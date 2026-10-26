#include "Api.h"
#include "../app/Services.h"
#include "../auth/AuthService.h"
#include "../chat/ChatService.h"
#include "../events/EventStore.h"
#include "../scenes/SceneManager.h"
#include "../knowledge/KnowledgeService.h"
#include "../documents/DocumentService.h"
#include "../highlights/HighlightService.h"
#include "../retrieval/ContextRetrievalService.h"
#include "../llm/LlmGateway.h"
#include "../observer/ObserverScheduler.h"
#include "../consistency/ConsistencyService.h"
#include "../inspiration/InspirationService.h"
#include "../modules/ModuleImporter.h"
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
    route0("/api/auth/register", {Post}, [&](auto& req, auto&, auto&) { auto b = body(req); auto u = S.auth->registerUser(json::requireStr(b, "username"), json::requireStr(b, "password"), json::str(b, "display_name")); auto login = S.auth->login(json::requireStr(b, "username"), json::requireStr(b, "password")); login["user"] = u; return login; }, false);
    route0("/api/auth/login", {Post}, [&](auto& req, auto&, auto&) { auto b = body(req); return S.auth->login(json::requireStr(b, "username"), json::requireStr(b, "password")); }, false);
    route0("/api/auth/logout", {Post}, [&](auto& req, auto&, auto&) { S.auth->logout(bearer(req)); return ok(); });
    route0("/api/auth/me", {Get}, [&](auto&, auto& p, auto&) { Json::Value v; v["id"] = p.userId; v["username"] = p.username; v["display_name"] = p.displayName; return v; });

    // ---- servers ----
    route0("/api/servers", {Get}, [&](auto&, auto& p, auto&) { return S.chat->listServers(p); });
    route0("/api/servers", {Post}, [&](auto& req, auto& p, auto&) { return S.chat->createServer(p, json::requireStr(body(req), "name")); });
    route1("/api/servers/{1}/join", {Post}, [&](auto&, auto& p, auto& a) { return S.chat->joinServer(p, a[0]); });
    route1("/api/servers/{1}/members", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->serverMembers(p, a[0]); });
    route1("/api/servers/{1}/members", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.chat->addServerMember(p, a[0], json::requireStr(b, "username"), json::str(b, "role", "member")); });
    route1("/api/servers/{1}/channels", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->listChannels(p, a[0]); });
    route1("/api/servers/{1}/channels", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->createChannel(p, a[0], body(req)); });

    // ---- channels / members / characters ----
    route1("/api/channels/{1}", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->getChannel(access(p, a[0])); });
    route1("/api/channels/{1}", {Put}, [&](auto& req, auto& p, auto& a) { return S.chat->updateChannel(access(p, a[0]), body(req)); });
    route1("/api/channels/{1}/members", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->channelMembers(access(p, a[0])); });
    route1("/api/channels/{1}/members", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.chat->addChannelMember(access(p, a[0]), json::requireStr(b, "username"), json::str(b, "role", "player")); });
    route1("/api/channels/{1}/characters", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->listCharacters(access(p, a[0])); });
    route1("/api/channels/{1}/characters", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->createCharacter(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/characters/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.chat->updateCharacter(access(p, a[0]), a[1], body(req)); });

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
    route1("/api/channels/{1}/consistency", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.consistency->check(access(p, a[0]), json::str(b, "chat_window_id"), json::str(b, "character_id"), json::str(b, "draft")); });
    route1("/api/channels/{1}/consistency/history", {Get}, [&](auto& req, auto& p, auto& a) { return S.consistency->history(access(p, a[0]), qint(req, "limit", 20)); });
    route1("/api/channels/{1}/inspiration", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.inspiration->draft(access(p, a[0]), json::str(b, "chat_window_id"), json::str(b, "character_id"), json::str(b, "hint"), json::toInt(b, "variant", 0)); });

    // ---- AI observer admin ----
    route1("/api/channels/{1}/ai/status", {Get}, [&](auto&, auto& p, auto& a) { access(p, a[0]); auto s = S.observer->status(); s["cursors"] = S.db->queryJson("SELECT kind, group_key, last_seq, updated_at FROM ai_processing_cursors WHERE channel_id=$1", {a[0]}); return s; });
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
