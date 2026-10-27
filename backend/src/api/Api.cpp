#include "Api.h"
#include "../ws/Notifier.h"
#include "../app/Services.h"
#include "../auth/AuthService.h"
#include "../chat/ChatService.h"
#include "../events/EventStore.h"
#include "../scenes/SceneManager.h"
#include "../scenes/ScenarioService.h"
#include "../knowledge/KnowledgeService.h"
#include "../documents/DocumentService.h"
#include "../highlights/HighlightService.h"
#include "../retrieval/ContextRetrievalService.h"
#include "../llm/LlmGateway.h"
#include "../observer/ObserverScheduler.h"
#include "../consistency/ConsistencyService.h"
#include "../inspiration/InspirationService.h"
#include "../modules/ModuleImporter.h"
#include "../logstudio/LogStudioService.h"
#include "../logstudio/MediaService.h"
#include "../logstudio/PresentationService.h"
#include "../logstudio/StyleService.h"
#include "../logstudio/TtsService.h"
#include "../logstudio/PublicationService.h"
#include "../logstudio/CreativeService.h"
#include "../logstudio/VnScriptService.h"
#include "../servers/ServerSettingsService.h"
#include "../dice/DiceService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../ws/WsGateway.h"
#include <drogon/drogon.h>
#include <drogon/MultiPart.h>

using namespace drogon;

namespace acerciae {
namespace {

using Cb = std::function<void(const HttpResponsePtr&)>;
using Params = std::vector<std::string>;
using Fn = std::function<Json::Value(const HttpRequestPtr&, const Principal&, const Params&)>;

HttpResponsePtr jsonResp(const Json::Value& v, int status = 200) {
    auto r = HttpResponse::newHttpJsonResponse(v);
    r->setStatusCode((HttpStatusCode)status);
    return r;
}
HttpResponsePtr errResp(int status, const std::string& code, const std::string& msg) {
    Json::Value e; e["error"] = code; e["message"] = msg; return jsonResp(e, status);
}
std::string bearer(const HttpRequestPtr& req) {
    auto h = req->getHeader("Authorization");
    if (h.rfind("Bearer ", 0) == 0) return h.substr(7);
    auto q = req->getParameter("token");
    return q;
}
Json::Value body(const HttpRequestPtr& req) {
    auto j = req->getJsonObject();
    if (j) return *j;
    auto b = req->getBody();
    if (b.empty()) return Json::Value(Json::objectValue);
    return json::parse(std::string(b));
}
int qint(const HttpRequestPtr& req, const char* k, int def) { auto s = req->getParameter(k); if (s.empty()) return def; try { return std::stoi(s); } catch (...) { return def; } }

void run(const HttpRequestPtr& req, Cb&& cb, const Params& params, const Fn& fn, bool authRequired) {
    try {
        Principal p;
        if (authRequired) {
            auto pr = services().auth->authenticate(bearer(req));
            if (!pr) { cb(errResp(401, "unauthorized", "missing or invalid token")); return; }
            p = *pr;
        }
        cb(jsonResp(fn(req, p, params)));
    } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); }
    catch (const pqxx::sql_error& e) { ALOG_ERROR << "sql error: " << e.what() << " :: " << e.query(); cb(errResp(500, "db_error", "database error")); }
    catch (const std::exception& e) { ALOG_ERROR << "unhandled: " << e.what(); cb(errResp(500, "internal", e.what())); }
}
void route0(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb) { run(req, std::move(cb), {}, fn, auth); }, m);
}
void route1(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb, std::string a) { run(req, std::move(cb), {a}, fn, auth); }, m);
}
void route2(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb, std::string a, std::string b) { run(req, std::move(cb), {a, b}, fn, auth); }, m);
}
void route3(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb, std::string a, std::string b, std::string c) { run(req, std::move(cb), {a, b, c}, fn, auth); }, m);
}
ChannelAccess access(const Principal& p, const std::string& channelId) { return services().auth->channelAccess(p.userId, channelId); }
Json::Value ok() { Json::Value v; v["ok"] = true; return v; }

} // namespace

void registerRoutes() {
    auto& S = services();

    // ---- health / llm ----
    route0("/api/health", {Get}, [&](auto&, auto&, auto&) { Json::Value v; v["status"] = "ok"; v["llm_mode"] = S.llm->mode(); v["ws_connections"] = (int)WsGateway::instance().connectionCount(); S.db->exec("SELECT 1"); v["db"] = "ok"; return v; }, false);
    route0("/api/llm/status", {Get}, [&](auto&, auto&, auto&) { return S.llm->status(); }, false);

    // ---- auth ----
    route0("/api/auth/register", {Post}, [&](auto& req, auto&, auto&) { auto b = body(req); auto u = S.auth->registerUser(json::requireStr(b, "username"), json::requireStr(b, "password"), json::str(b, "display_name")); auto login = S.auth->login(json::requireStr(b, "username"), json::requireStr(b, "password")); login["user"] = S.auth->profile(u["id"].asString()); return login; }, false);
    route0("/api/auth/login", {Post}, [&](auto& req, auto&, auto&) { auto b = body(req); return S.auth->login(json::requireStr(b, "username"), json::requireStr(b, "password")); }, false);
    route0("/api/auth/logout", {Post}, [&](auto& req, auto&, auto&) { S.auth->logout(bearer(req)); return ok(); });
    route0("/api/auth/me", {Get}, [&](auto&, auto& p, auto&) { return S.auth->profile(p.userId); });
    route0("/api/auth/me", {Put}, [&](auto& req, auto& p, auto&) { return S.auth->updateProfile(p, body(req)); });
    app().registerHandler("/api/users/{1}/avatar", [](const HttpRequestPtr& req, Cb&& cb, std::string userId) {
        try {
            auto principal = services().auth->authenticate(bearer(req));
            if (!principal) throw unauthorized("missing or invalid token");
            auto [mime, bytes] = services().auth->avatar(*principal, userId);
            auto response = HttpResponse::newHttpResponse();
            response->setContentTypeString(mime);
            response->setBody(bytes);
            response->addHeader("X-Content-Type-Options", "nosniff");
            response->addHeader("Cache-Control", "private, no-store");
            cb(response);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); }
          catch (const std::exception&) { cb(errResp(400, "bad_request", "invalid avatar request")); }
    }, {Get});


    // ---- servers ----
    route0("/api/servers", {Get}, [&](auto&, auto& p, auto&) { return S.chat->listServers(p); });
    route0("/api/servers", {Post}, [&](auto& req, auto& p, auto&) { return S.chat->createServer(p, json::requireStr(body(req), "name")); });
    route1("/api/servers/{1}/join", {Post}, [&](auto&, auto& p, auto& a) { return S.chat->joinServer(p, a[0]); });
    route1("/api/servers/{1}/members", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->serverMembers(p, a[0]); });
    route1("/api/servers/{1}/members", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); auto who = json::str(b, "user_id", json::str(b, "username")); if (who.empty()) throw badRequest("user_id or username required"); return S.chat->addServerMember(p, a[0], who, json::str(b, "role", "member")); });
    route2("/api/servers/{1}/members/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.chat->setServerMemberRole(p, a[0], a[1], json::requireStr(body(req), "role")); });
    route2("/api/servers/{1}/members/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.chat->removeServerMember(p, a[0], a[1]); });
    route1("/api/servers/{1}/settings", {Get}, [&](auto&, auto& p, auto& a) { return S.settings->get(p, a[0]); });
    route1("/api/servers/{1}/settings", {Put}, [&](auto& req, auto& p, auto& a) { return S.settings->update(p, a[0], body(req)); });
    route1("/api/servers/{1}/dice-texts", {Get}, [&](auto&, auto& p, auto& a) { return S.settings->listTextGroups(p, a[0]); });
    route1("/api/servers/{1}/dice-texts", {Post}, [&](auto& req, auto& p, auto& a) { return S.settings->createTextGroup(p, a[0], body(req)); });
    route2("/api/servers/{1}/dice-texts/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.settings->updateTextGroup(p, a[0], a[1], body(req)); });
    route2("/api/servers/{1}/dice-texts/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.settings->deleteTextGroup(p, a[0], a[1]); });
    route0("/api/dice/texts", {Get}, [&](auto&, auto&, auto&) { return ServerSettingsService::builtinTexts(); });
    route0("/api/users/search", {Get}, [&](auto& req, auto& p, auto&) { return S.chat->searchUsers(p, req->getParameter("q"), qint(req, "limit", 15)); });
    route1("/api/servers/{1}/channels", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->listChannels(p, a[0]); });
    route1("/api/servers/{1}/channels", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->createChannel(p, a[0], body(req)); });

    // ---- channels / members / characters ----
    route1("/api/channels/{1}", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->getChannel(access(p, a[0])); });
    route1("/api/channels/{1}", {Put}, [&](auto& req, auto& p, auto& a) { return S.chat->updateChannel(access(p, a[0]), body(req)); });
    route1("/api/channels/{1}/members", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->channelMembers(access(p, a[0])); });
    route1("/api/channels/{1}/members", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); auto who = json::str(b, "user_id", json::str(b, "username")); if (who.empty()) throw badRequest("user_id or username required"); return S.chat->addChannelMember(access(p, a[0]), who, json::str(b, "role", "player")); });
    route2("/api/channels/{1}/members/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.chat->removeChannelMember(access(p, a[0]), a[1]); });
    route1("/api/channels/{1}/characters", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->listCharacters(access(p, a[0])); });
    route1("/api/channels/{1}/characters", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->createCharacter(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/characters/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.chat->updateCharacter(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/characters/{2}/attributes", {Get}, [&](auto&, auto& p, auto& a) { return S.dice->getAttributes(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/characters/{2}/attributes", {Put}, [&](auto& req, auto& p, auto& a) { return S.dice->updateAttributes(access(p, a[0]), a[1], body(req)); });
    route1("/api/channels/{1}/dice/preview", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.dice->preview(access(p, a[0]), json::str(b, "chat_window_id"), json::str(b, "character_id"), json::str(b, "content")); });

    // ---- windows / messages ----
    route1("/api/channels/{1}/windows", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->listWindows(access(p, a[0])); });
    route1("/api/channels/{1}/windows", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->createWindow(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/windows/{2}/members", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->windowMembers(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/windows/{2}/members", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.chat->addWindowMember(access(p, a[0]), a[1], json::requireStr(b, "user_id"), json::str(b, "character_id")); });
    route3("/api/channels/{1}/windows/{2}/members/{3}", {Delete}, [&](auto&, auto& p, auto& a) { return S.chat->removeWindowMember(access(p, a[0]), a[1], a[2]); });
    route2("/api/channels/{1}/windows/{2}/messages", {Get}, [&](auto& req, auto& p, auto& a) { return S.chat->listMessages(access(p, a[0]), a[1], qint(req, "limit", 80), qint(req, "before_seq", 0)); });
    route2("/api/channels/{1}/windows/{2}/messages", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->postMessage(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/windows/{2}/scene", {Post}, [&](auto& req, auto& p, auto& a) { return S.scenes->enterScene(access(p, a[0]), a[1], json::requireStr(body(req), "scene_id")); });
    route2("/api/channels/{1}/messages/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->getMessage(access(p, a[0]), a[1]); });
    route1("/api/channels/{1}/messages", {Get}, [&](auto& req, auto& p, auto& a) { return S.chat->searchMessages(access(p, a[0]), req->getParameter("q"), qint(req, "limit", 30)); });

    // ---- scenes / events ----
    route1("/api/channels/{1}/scenes", {Get}, [&](auto&, auto& p, auto& a) { return S.scenes->list(access(p, a[0])); });
    route1("/api/channels/{1}/scenes", {Post}, [&](auto& req, auto& p, auto& a) { return S.scenes->create(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/scenes/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.scenes->get(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/scenes/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.scenes->update(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/scenes/{2}/close", {Post}, [&](auto&, auto& p, auto& a) { return S.scenes->close(access(p, a[0]), a[1]); });
    route1("/api/channels/{1}/scenarios/advance", {Post}, [&](auto& req, auto& p, auto& a) { return S.scenarios->advance(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/scenes/{2}/summarize", {Post}, [&](auto&, auto& p, auto& a) { return S.scenarios->summarize(access(p, a[0]), a[1]); });
    route1("/api/channels/{1}/scenario-settings", {Put}, [&](auto& req, auto& p, auto& a) { return S.scenarios->setAuto(access(p, a[0]), json::toBool(body(req), "auto_scenarios", true)); });
    route2("/api/channels/{1}/scenes/{2}/log", {Get}, [&](auto& req, auto& p, auto& a) { return S.scenes->sceneLog(access(p, a[0]), a[1], qint(req, "limit", 200), qint(req, "after_seq", 0)); });
    route1("/api/channels/{1}/events", {Get}, [&](auto& req, auto& p, auto& a) { auto ac = access(p, a[0]); auto ids = req->getParameter("ids"); if (!ids.empty()) { std::vector<std::string> v; std::string cur; for (char c : ids) { if (c == ',') { if (!cur.empty()) v.push_back(cur); cur.clear(); } else cur += c; } if (!cur.empty()) v.push_back(cur); return S.events->listByIds(ac, v); } return S.events->search(ac, req->getParameter("q"), req->getParameter("scene_id"), qint(req, "limit", 30)); });
    route2("/api/channels/{1}/events/{2}", {Get}, [&](auto&, auto& p, auto& a) { auto ac = access(p, a[0]); auto r = S.events->listByIds(ac, {a[1]}); if (r.empty()) throw notFound("event not found"); return r[0]; });

    // ---- documents ----
    route1("/api/channels/{1}/documents", {Get}, [&](auto&, auto& p, auto& a) { return S.documents->listDocuments(access(p, a[0]), 0); });
    route2("/api/channels/{1}/documents/{2}", {Get}, [&](auto& req, auto& p, auto& a) { return S.documents->getDocument(access(p, a[0]), a[1], req->getParameter("scene_id"), qint(req, "since_version", -1)); });
    route2("/api/channels/{1}/documents/{2}/revisions", {Get}, [&](auto& req, auto& p, auto& a) { return S.documents->listRevisions(access(p, a[0]), a[1], qint(req, "limit", 50)); });
    route3("/api/channels/{1}/documents/{2}/revisions/{3}", {Get}, [&](auto&, auto& p, auto& a) { return S.documents->getRevision(access(p, a[0]), a[1], std::stoi(a[2])); });
    route2("/api/channels/{1}/documents/{2}/rollback", {Post}, [&](auto& req, auto& p, auto& a) { return S.documents->gmRollback(access(p, a[0]), a[1], json::toInt(body(req), "version", -1)); });
    route3("/api/channels/{1}/documents/{2}/entries/{3}", {Put}, [&](auto& req, auto& p, auto& a) { return S.documents->gmCorrectEntry(access(p, a[0]), a[1], a[2], body(req)); });
    route2("/api/channels/{1}/entries/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.documents->getEntry(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/entries/{2}/related", {Get}, [&](auto&, auto& p, auto& a) { return S.documents->relatedEntries(access(p, a[0]), a[1]); });
    route1("/api/channels/{1}/proposals", {Get}, [&](auto& req, auto& p, auto& a) { return S.documents->listProposals(access(p, a[0]), req->getParameter("status")); });
    route2("/api/channels/{1}/proposals/{2}/decide", {Post}, [&](auto& req, auto& p, auto& a) { return S.documents->decideProposal(access(p, a[0]), a[1], json::toBool(body(req), "accept", false)); });

    // ---- highlights ----
    route1("/api/channels/{1}/highlights", {Get}, [&](auto& req, auto& p, auto& a) { return S.highlights->listActive(access(p, a[0]), req->getParameter("document_id")); });
    route2("/api/channels/{1}/highlights/{2}/dismiss", {Post}, [&](auto&, auto& p, auto& a) { return S.highlights->dismiss(access(p, a[0]), a[1]); });

    route1("/api/channels/{1}/player-groups", {Get}, [&](auto&, auto& p, auto& a) { return S.knowledge->playerGroups(access(p,a[0])); });
    route1("/api/channels/{1}/player-groups", {Post}, [&](auto& req, auto& p, auto& a) { return S.knowledge->createPlayerGroup(access(p,a[0]),json::requireStr(body(req),"name")); });
    route2("/api/channels/{1}/player-groups/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.knowledge->renamePlayerGroup(access(p,a[0]),a[1],json::requireStr(body(req),"name")); });
    route3("/api/channels/{1}/player-groups/{2}/members/{3}", {Put}, [&](auto&, auto& p, auto& a) { auto result=S.knowledge->movePlayer(access(p,a[0]),a[1],a[2]); S.notifier->knowledgeChanged(a[0]); return result; });

    // ---- knowledge / shards ----
    route1("/api/channels/{1}/facts", {Get}, [&](auto& req, auto& p, auto& a) { return S.knowledge->listFacts(access(p, a[0]), req->getParameter("kind"), req->getParameter("q"), req->getParameter("scene_id"), qint(req, "limit", 50)); });
    route2("/api/channels/{1}/facts/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.knowledge->getFact(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/facts/{2}/visibility", {Get}, [&](auto&, auto& p, auto& a) { return S.knowledge->getScopeJson(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/facts/{2}/visibility", {Put}, [&](auto& req, auto& p, auto& a) { return S.knowledge->gmSetScope(access(p, a[0]), a[1], KnowledgeScope::fromJson(body(req))); });
    route1("/api/channels/{1}/entities", {Get}, [&](auto& req, auto& p, auto& a) { return S.knowledge->listEntities(access(p, a[0]), req->getParameter("q")); });
    route2("/api/channels/{1}/entities/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.knowledge->getEntity(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/knowledge/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.knowledge->knowledgeScope(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/tools/{2}", {Post}, [&](auto& req, auto& p, auto& a) { return S.retrieval->executeTool(access(p, a[0]), a[1], body(req)); });
    route1("/api/channels/{1}/shards", {Get}, [&](auto& req, auto& p, auto& a) { return S.retrieval->getShard(access(p, a[0]), req->getParameter("id")); });

    // ---- AI auxiliary (user-triggered) ----
    route1("/api/channels/{1}/consistency", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); auto ac = access(p, a[0]); S.settings->requireFeature(ac.serverId, "consistency"); return S.consistency->check(ac, json::str(b, "chat_window_id"), json::str(b, "character_id"), json::str(b, "draft")); });
    route1("/api/channels/{1}/consistency/history", {Get}, [&](auto& req, auto& p, auto& a) { return S.consistency->history(access(p, a[0]), qint(req, "limit", 20)); });
    route1("/api/channels/{1}/inspiration", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); auto ac = access(p, a[0]); S.settings->requireFeature(ac.serverId, "inspiration"); return S.inspiration->draft(ac, json::str(b, "chat_window_id"), json::str(b, "character_id"), json::str(b, "hint"), json::toInt(b, "variant", 0)); });

    // ---- AI observer admin ----
    route1("/api/channels/{1}/ai/status", {Get}, [&](auto&, auto& p, auto& a) { access(p, a[0]); auto s = S.observer->status(); s["llm"] = S.llm->status(a[0]); s["cursors"] = S.db->queryJson("SELECT kind, group_key, last_seq, updated_at FROM ai_processing_cursors WHERE channel_id=$1", {a[0]}); return s; });
    route1("/api/channels/{1}/ai/jobs", {Get}, [&](auto& req, auto& p, auto& a) { auto ac = access(p, a[0]); S.auth->requireGm(ac); return S.observer->listJobs(a[0], qint(req, "limit", 30)); });
    route1("/api/channels/{1}/ai/observe-now", {Post}, [&](auto&, auto& p, auto& a) { auto ac = access(p, a[0]); S.auth->requireGm(ac); Json::Value v; v["jobs"] = S.observer->observeChannel(a[0], true); return v; });
    route1("/api/channels/{1}/ai/consolidate-now", {Post}, [&](auto&, auto& p, auto& a) { auto ac = access(p, a[0]); S.auth->requireGm(ac); Json::Value v; v["job"] = S.observer->consolidateChannel(a[0]); return v; });
    route1("/api/channels/{1}/ai/cleanup-highlights", {Post}, [&](auto&, auto& p, auto& a) { auto ac = access(p, a[0]); S.auth->requireGm(ac); Json::Value v; v["removed"] = S.observer->cleanupHighlights(); return v; });

    // ---- modules / GM workspace ----
    route1("/api/channels/{1}/modules", {Get}, [&](auto&, auto& p, auto& a) { return S.modules->list(access(p, a[0])); });
    route1("/api/channels/{1}/modules", {Post}, [&](auto& req, auto& p, auto& a) {
        auto ac = access(p, a[0]);
        MultiPartParser mp;
        if (mp.parse(req) != 0 || mp.getFiles().empty()) throw badRequest("multipart upload with a 'file' PDF required");
        auto& f = mp.getFiles()[0];
        std::string bytes(f.fileContent());
        std::string title; auto& ps = mp.getParameters(); if (ps.count("title")) title = ps.at("title");
        return S.modules->importPdf(ac, f.getFileName(), bytes, title);
    });
    route1("/api/channels/{1}/modules/text", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); std::vector<std::string> pages = json::strArray(b["pages"]); if (pages.empty() && !json::str(b, "text").empty()) pages.push_back(json::str(b, "text")); return S.modules->importText(access(p, a[0]), json::str(b, "title"), pages); });
    route1("/api/channels/{1}/modules/hints", {Get}, [&](auto& req, auto& p, auto& a) { return S.modules->listHints(access(p, a[0]), req->getParameter("status")); });
    route2("/api/channels/{1}/modules/hints/{2}/decide", {Post}, [&](auto& req, auto& p, auto& a) { return S.modules->decideHint(access(p, a[0]), a[1], json::str(body(req), "decision")); });
    route2("/api/channels/{1}/modules/nodes/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.modules->updateNode(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/modules/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.modules->get(access(p, a[0]), a[1]); });
    route3("/api/channels/{1}/modules/{2}/pages/{3}", {Get}, [&](auto&, auto& p, auto& a) { return S.modules->page(access(p, a[0]), a[1], std::stoi(a[2])); });
    route1("/api/channels/{1}/gm/workspace", {Get}, [&](auto&, auto& p, auto& a) { return S.modules->gmWorkspace(access(p, a[0])); });

    route1("/api/channels/{1}/studio/images/status", {Get}, [&](auto&, auto& p, auto& a) { return S.creative->status(access(p,a[0])); });
    route1("/api/channels/{1}/studio/images/jobs", {Get}, [&](auto&, auto& p, auto& a) { return S.creative->jobs(access(p,a[0])); });
    route1("/api/channels/{1}/studio/images/jobs", {Post}, [&](auto& req, auto& p, auto& a) { return S.creative->create(access(p,a[0]),body(req)); });
    route2("/api/channels/{1}/studio/images/jobs/{2}/cancel", {Post}, [&](auto&, auto& p, auto& a) { return S.creative->cancel(access(p,a[0]),a[1]); });
    route1("/api/channels/{1}/studio/vn-scripts/status", {Get}, [&](auto&, auto& p, auto& a) { return S.vnScripts->status(access(p,a[0])); });
    route1("/api/channels/{1}/studio/vn-scripts", {Get}, [&](auto&, auto& p, auto& a) { return S.vnScripts->list(access(p,a[0])); });
    route1("/api/channels/{1}/studio/vn-scripts", {Post}, [&](auto& req, auto& p, auto& a) { return S.vnScripts->create(access(p,a[0]),body(req)); });
    route2("/api/channels/{1}/studio/vn-scripts/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.vnScripts->get(access(p,a[0]),a[1]); });
    route2("/api/channels/{1}/studio/vn-scripts/{2}/cancel", {Post}, [&](auto&, auto& p, auto& a) { return S.vnScripts->cancel(access(p,a[0]),a[1]); });
    route2("/api/channels/{1}/studio/presentations/{2}/suggest", {Post}, [&](auto& req, auto& p, auto& a) { return S.creative->suggest(access(p,a[0]),a[1],body(req)); });
    route1("/api/channels/{1}/studio/pdf/templates", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->templates(access(p,a[0])); });
    route1("/api/channels/{1}/studio/pdf/templates", {Post}, [&](auto& req, auto& p, auto& a) { return S.publication->saveTemplate(access(p,a[0]),body(req)); });
    route2("/api/channels/{1}/studio/snapshots/{2}/pdf", {Post}, [&](auto& req, auto& p, auto& a) { return S.publication->createPdf(access(p,a[0]),a[1],body(req)); });
    route1("/api/channels/{1}/studio/pdf/jobs", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->pdfJobs(access(p,a[0])); });
    route2("/api/channels/{1}/studio/pdf/jobs/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->pdfJob(access(p,a[0]),a[1]); });
    route1("/api/channels/{1}/studio/publications", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->publications(access(p,a[0])); });
    route1("/api/channels/{1}/studio/publications", {Post}, [&](auto& req, auto& p, auto& a) { return S.publication->publish(access(p,a[0]),body(req)); });
    route2("/api/channels/{1}/studio/publications/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->publication(access(p,a[0]),a[1]); });
    route2("/api/channels/{1}/studio/publications/{2}/revoke", {Post}, [&](auto&, auto& p, auto& a) { return S.publication->revoke(access(p,a[0]),a[1]); });
    route1("/api/published/{1}", {Get}, [&](auto&, auto&, auto& a) { return S.publication->shared(a[0]); },false);
    auto workerAuth=[](const HttpRequestPtr& req) { const char* key=std::getenv("PDF_WORKER_TOKEN"); if(!key||std::string(key).size()<32||req->getHeader("X-Worker-Token")!=key) throw forbidden("invalid worker credentials"); };
    route0("/api/internal/pdf/claim", {Post}, [&,workerAuth](auto& req, auto&, auto&) { workerAuth(req); return S.publication->claimPdf(); },false);
    route1("/api/internal/pdf/{1}/finish", {Post}, [&,workerAuth](auto& req, auto&, auto& a) { workerAuth(req); return S.publication->finishPdf(a[0],req->getHeader("X-Worker-Lease"),std::string(req->getBody()),req->getHeader("X-Worker-Error")); },false);
    app().registerHandler("/api/channels/{1}/studio/pdf/jobs/{2}/file", [&](const HttpRequestPtr& req,Cb&& cb,std::string ch,std::string id) {
        try { auto p=S.auth->authenticate(bearer(req)); if(!p) throw ApiError(401,"unauthorized","authentication required"); auto data=S.publication->pdfBytes(access(*p,ch),id); auto r=HttpResponse::newHttpResponse(); r->setContentTypeString("application/pdf"); r->addHeader("Cache-Control","private, no-store"); r->addHeader("Content-Disposition","inline; filename=log.pdf"); r->setBody(std::move(data)); cb(r); } catch(const ApiError& e) { cb(errResp(e.status(),e.code(),e.what())); } catch(const std::exception&) { cb(errResp(500,"internal","PDF unavailable")); }
    },{Get});
    app().registerHandler("/api/channels/{1}/studio/publications/{2}/files/{3}", [&](const HttpRequestPtr& req,Cb&& cb,std::string ch,std::string pub,std::string id) {
        try { auto p=S.auth->authenticate(bearer(req)); if(!p)throw ApiError(401,"unauthorized","authentication required"); std::string mime; auto data=S.publication->publicationFile(access(*p,ch),pub,id,mime); auto r=HttpResponse::newHttpResponse(); r->setContentTypeString(mime); r->addHeader("Cache-Control","no-store"); r->addHeader("X-Content-Type-Options","nosniff"); r->setBody(std::move(data)); cb(r); } catch(const ApiError& e) { cb(errResp(e.status(),e.code(),e.what())); } catch(const std::exception&) { cb(errResp(500,"internal","file unavailable")); }
    },{Get});
    app().registerHandler("/api/published/{1}/files/{2}", [&](const HttpRequestPtr&,Cb&& cb,std::string token,std::string id) {
        try { std::string mime; auto data=S.publication->sharedFile(token,id,mime); auto r=HttpResponse::newHttpResponse(); r->setContentTypeString(mime); r->addHeader("Cache-Control","no-store"); r->addHeader("X-Content-Type-Options","nosniff"); r->setBody(std::move(data)); cb(r); } catch(const ApiError& e) { cb(errResp(e.status(),e.code(),e.what())); } catch(const std::exception&) { cb(errResp(500,"internal","file unavailable")); }
    },{Get});

    route1("/api/channels/{1}/studio/settings", {Get}, [&](auto&,auto& p,auto& a){return S.studio->settings(access(p,a[0]));});
    route1("/api/channels/{1}/studio/settings", {Put}, [&](auto& req,auto& p,auto& a){return S.studio->saveSettings(access(p,a[0]),body(req));});

    // ---- Log Studio: projects / canonical events / imports / snapshots / exports ----
    route1("/api/channels/{1}/studio/adapters", {Get}, [&](auto&, auto& p, auto& a) { access(p, a[0]); return S.studio->adapters(); });
    route1("/api/channels/{1}/studio/projects", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->listProjects(access(p, a[0])); });
    route1("/api/channels/{1}/studio/projects", {Post}, [&](auto& req, auto& p, auto& a) { return S.studio->createProject(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/studio/projects/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->getProject(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/projects/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.studio->updateProject(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/projects/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.studio->deleteProject(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/projects/{2}/events", {Get}, [&](auto& req, auto& p, auto& a) { return S.studio->listEvents(access(p, a[0]), a[1], qint(req, "limit", 500), qint(req, "after_seq", 0), req->getParameter("scene_key")); });
    route3("/api/channels/{1}/studio/projects/{2}/events/{3}", {Put}, [&](auto& req, auto& p, auto& a) { return S.studio->updateEvent(access(p, a[0]), a[1], a[2], body(req)); });
    route2("/api/channels/{1}/studio/projects/{2}/scenes", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->sceneSummary(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/projects/{2}/scenes/split", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.studio->splitScene(access(p, a[0]), a[1], json::toInt(b, "from_seq", 0), json::str(b, "title", "New scene")); });
    route2("/api/channels/{1}/studio/projects/{2}/scenes/merge", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.studio->mergeScene(access(p, a[0]), a[1], json::requireStr(b, "scene_key"), json::requireStr(b, "into_key")); });
    route2("/api/channels/{1}/studio/projects/{2}/scenes/rename", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.studio->renameScene(access(p, a[0]), a[1], json::requireStr(b, "scene_key"), json::str(b, "title")); });
    route2("/api/channels/{1}/studio/projects/{2}/scenes/suggest", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->suggestScenes(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/projects/{2}/sync", {Post}, [&](auto& req, auto& p, auto& a) { return S.studio->syncFromChannel(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/projects/{2}/imports", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->listImports(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/projects/{2}/imports", {Post}, [&](auto& req, auto& p, auto& a) {
        auto ac = access(p, a[0]);
        MultiPartParser mp; std::string adapter = "auto";
        if (mp.parse(req) == 0 && !mp.getFiles().empty()) { auto& f = mp.getFiles()[0]; auto& ps = mp.getParameters(); if (ps.count("adapter")) adapter = ps.at("adapter"); return S.studio->previewImport(ac, a[1], f.getFileName(), std::string(f.fileContent()), adapter); }
        auto b = body(req); return S.studio->previewImport(ac, a[1], json::str(b, "file_name", "pasted.txt"), json::str(b, "text"), json::str(b, "adapter", "auto"));
    });
    route3("/api/channels/{1}/studio/projects/{2}/imports/{3}/commit", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.studio->commitImport(access(p, a[0]), a[1], a[2], b["speaker_map"]); });
    route2("/api/channels/{1}/studio/imports/{2}/errors", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->importErrors(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/projects/{2}/snapshots", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->listSnapshots(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/projects/{2}/snapshots", {Post}, [&](auto& req, auto& p, auto& a) { return S.studio->createSnapshot(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/snapshots/{2}", {Get}, [&](auto& req, auto& p, auto& a) { return S.studio->getSnapshot(access(p, a[0]), a[1], req->getParameter("events") != "false"); });
    app().registerHandler("/api/channels/{1}/studio/snapshots/{2}/export", [&](const HttpRequestPtr& req, Cb&& cb, std::string ch, std::string snap) {
        try {
            auto pr = S.auth->authenticate(bearer(req)); if (!pr) { cb(errResp(401, "unauthorized", "missing or invalid token")); return; }
            std::string mime, name; auto data = S.studio->exportSnapshot(access(*pr, ch), snap, req->getParameter("format").empty() ? "json" : req->getParameter("format"), mime, name);
            auto r = HttpResponse::newHttpResponse(); r->setBody(data); r->setContentTypeString(mime);
            if (req->getParameter("download") == "1") r->addHeader("Content-Disposition", "attachment; filename=\"" + name + "\"");
            cb(r);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); } catch (const std::exception& e) { cb(errResp(500, "internal", e.what())); }
    }, {Get});

    // ---- Log Studio: media assets ----
    route1("/api/channels/{1}/media", {Get}, [&](auto& req, auto& p, auto& a) { return S.media->list(access(p, a[0]), req->getParameter("type"), req->getParameter("character_id"), req->getParameter("approval")); });
    route1("/api/channels/{1}/media", {Post}, [&](auto& req, auto& p, auto& a) {
        auto ac = access(p, a[0]); MultiPartParser mp;
        if (mp.parse(req) != 0 || mp.getFiles().empty()) throw badRequest("multipart upload with a 'file' field required");
        auto& f = mp.getFiles()[0]; Json::Value meta(Json::objectValue); for (auto& [k, v] : mp.getParameters()) meta[k] = v;
        if (meta.isMember("tags") && meta["tags"].isString()) { Json::Value t(Json::arrayValue); std::string cur; for (char c : meta["tags"].asString()) { if (c == ',') { if (!cur.empty()) t.append(cur); cur.clear(); } else cur += c; } if (!cur.empty()) t.append(cur); meta["tags"] = t; }
        if (meta.isMember("gm_only")) meta["gm_only"] = meta["gm_only"].asString() == "true";
        return S.media->upload(ac, f.getFileName(), std::string(f.fileContent()), "", meta);
    });
    route2("/api/channels/{1}/media/{2}/meta", {Get}, [&](auto&, auto& p, auto& a) { return S.media->get(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/media/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.media->update(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/media/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.media->remove(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/media/{2}/versions", {Post}, [&](auto& req, auto& p, auto& a) { auto ac = access(p, a[0]); MultiPartParser mp; if (mp.parse(req) != 0 || mp.getFiles().empty()) throw badRequest("file required"); auto& f = mp.getFiles()[0]; auto& ps = mp.getParameters(); return S.media->newVersion(ac, a[1], f.getFileName(), std::string(f.fileContent()), "", ps.count("note") ? ps.at("note") : ""); });
    // Binary delivery (images/audio for <img>/<audio>/howler): token may come as ?token= since media tags cannot set headers.
    app().registerHandler("/api/channels/{1}/media/{2}", [&](const HttpRequestPtr& req, Cb&& cb, std::string ch, std::string id) {
        try {
            auto pr = S.auth->authenticate(bearer(req)); if (!pr) { cb(errResp(401, "unauthorized", "missing or invalid token")); return; }
            auto ac = access(*pr, ch); std::string bytes, mime, name; int v = qint(req, "v", 0);
            if (!S.media->fetch(ac, id, v, bytes, mime, name)) { cb(errResp(404, "not_found", "asset not found")); return; }
            auto r = HttpResponse::newHttpResponse(); r->setBody(std::move(bytes)); r->setContentTypeString(mime); r->addHeader("Cache-Control", "private, max-age=3600"); r->addHeader("Accept-Ranges", "none"); r->addHeader("X-Content-Type-Options", "nosniff");
            if (mime == "image/svg+xml") r->addHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
            cb(r);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); } catch (const std::exception& e) { cb(errResp(500, "internal", e.what())); }
    }, {Get});

    // ---- Log Studio: presentations (performance timeline) ----
    route1("/api/channels/{1}/studio/presentations", {Get}, [&](auto& req, auto& p, auto& a) { return S.presentations->list(access(p, a[0]), req->getParameter("project_id")); });
    route2("/api/channels/{1}/studio/snapshots/{2}/presentations", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->create(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.presentations->get(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/presentations/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.presentations->update(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.presentations->remove(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/presentations/{2}/events/bulk", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->bulkUpdateEvents(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/merge", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->mergeEvents(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/reorder", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->reorder(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/progress", {Get}, [&](auto&, auto& p, auto& a) { return S.presentations->getProgress(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/presentations/{2}/progress", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->saveProgress(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/pscenes/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.presentations->updateScene(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/pevents/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.presentations->updateEvent(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/pevents/{2}/split", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->splitEvent(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/pevents/{2}/suggestion", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->acceptSuggestion(access(p, a[0]), a[1], json::toBool(body(req), "accept", false)); });

    // ---- Log Studio: visual styles / character visuals ----
    route1("/api/channels/{1}/studio/styles", {Get}, [&](auto&, auto& p, auto& a) { return S.styles->listStyles(access(p, a[0])); });
    route1("/api/channels/{1}/studio/styles", {Post}, [&](auto& req, auto& p, auto& a) { return S.styles->createStyle(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/studio/styles/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.styles->updateStyle(access(p, a[0]), a[1], body(req)); });
    route1("/api/channels/{1}/studio/character-visuals", {Get}, [&](auto&, auto& p, auto& a) { return S.styles->listCharacterVisuals(access(p, a[0])); });
    route2("/api/channels/{1}/studio/character-visuals/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.styles->upsertCharacterVisual(access(p, a[0]), a[1], body(req)); });

    // ---- Log Studio: TTS ----
    route1("/api/channels/{1}/studio/tts/status", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->status(access(p, a[0])); });
    route1("/api/channels/{1}/studio/tts/available-voices", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->availableVoices(access(p, a[0])); });
    route1("/api/channels/{1}/studio/tts/usage", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->usage(access(p, a[0])); });
    route1("/api/channels/{1}/studio/voices", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->listVoices(access(p, a[0])); });
    route1("/api/channels/{1}/studio/voices", {Post}, [&](auto& req, auto& p, auto& a) {
        auto ac = access(p, a[0]); MultiPartParser mp;
        if (mp.parse(req) == 0 && !mp.getParameters().empty()) { Json::Value b(Json::objectValue); for (auto& [k, v] : mp.getParameters()) { if (k == "consent_metadata" || k == "synthesis_parameters") { try { b[k] = json::parse(v); } catch (...) { b[k] = v; } } else b[k] = v; } std::string audio, mime; if (!mp.getFiles().empty()) { audio = std::string(mp.getFiles()[0].fileContent()); mime = "audio/wav"; } return S.tts->createVoice(ac, b, audio, mime); }
        return S.tts->createVoice(ac, body(req), "", "");
    });
    route2("/api/channels/{1}/studio/voices/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.tts->updateVoice(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/voices/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.tts->deleteVoice(access(p, a[0]), a[1]); });
    route1("/api/channels/{1}/studio/dictionaries", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->listDictionaries(access(p, a[0])); });
    route1("/api/channels/{1}/studio/dictionaries", {Post}, [&](auto& req, auto& p, auto& a) { return S.tts->saveDictionary(access(p, a[0]), "", body(req)); });
    route2("/api/channels/{1}/studio/dictionaries/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.tts->saveDictionary(access(p, a[0]), a[1], body(req)); });
    route1("/api/channels/{1}/studio/tts/preview", {Post}, [&](auto& req, auto& p, auto& a) { return S.tts->preview(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/tts/estimate", {Post}, [&](auto& req, auto& p, auto& a) { return S.tts->estimate(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/tts/jobs", {Post}, [&](auto& req, auto& p, auto& a) { return S.tts->createJob(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/tts/jobs", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->listJobs(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/tts/jobs/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->getJob(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/tts/jobs/{2}/cancel", {Post}, [&](auto&, auto& p, auto& a) { return S.tts->cancelJob(access(p, a[0]), a[1]); });
    app().registerHandler("/api/channels/{1}/studio/tts/audio/{2}", [&](const HttpRequestPtr& req, Cb&& cb, std::string ch, std::string id) {
        try {
            auto pr = S.auth->authenticate(bearer(req)); if (!pr) { cb(errResp(401, "unauthorized", "missing or invalid token")); return; }
            std::string bytes, mime; if (!S.tts->fetchAudio(access(*pr, ch), id, bytes, mime)) { cb(errResp(404, "not_found", "audio not found")); return; }
            auto r = HttpResponse::newHttpResponse(); r->setBody(std::move(bytes)); r->setContentTypeString(mime); r->addHeader("Cache-Control", "private, max-age=86400"); cb(r);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); } catch (const std::exception& e) { cb(errResp(500, "internal", e.what())); }
    }, {Get});

    // CORS for dev setups where the frontend is served from another origin.
    app().registerPreRoutingAdvice([](const HttpRequestPtr& req, AdviceCallback&& acb, AdviceChainCallback&& ccb) {
        if (req->method() == Options) {
            auto r = HttpResponse::newHttpResponse();
            r->addHeader("Access-Control-Allow-Origin", "*");
            r->addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
            r->addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
            acb(r); return;
        }
        ccb();
    });
    app().registerPostHandlingAdvice([](const HttpRequestPtr&, const HttpResponsePtr& resp) { resp->addHeader("Access-Control-Allow-Origin", "*"); });
}

} // namespace acerciae
