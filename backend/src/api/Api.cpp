#include <atomic>
#include "../atmosphere/AtmosphereService.h"
#include "Api.h"
#include "../ws/Notifier.h"
#include "../app/Services.h"
#include "../auth/AuthService.h"
#include "../chat/ChatService.h"
#include "../events/EventStore.h"
#include "../scenes/SceneManager.h"
#include "../scenes/ScenarioService.h"
#include "../reminders/ReminderService.h"
#include "../script/ScriptKnowledgeService.h"
#include "../characters/CharacterSpaceService.h"
#include "../characters/Coc7Rules.h"
#include "../knowledge/KnowledgeService.h"
#include "../documents/DocumentService.h"
#include "../highlights/HighlightService.h"
#include "../retrieval/ContextRetrievalService.h"
#include "../llm/LlmGateway.h"
#include "../observer/ObserverScheduler.h"
#include "../consistency/ConsistencyService.h"
#include "../inspiration/InspirationService.h"
#include "../modules/ModuleImporter.h"
#include "../core/WorkPool.h"
#include "../logstudio/LogStudioService.h"
#include "../logstudio/MediaService.h"
#include "../logstudio/PresentationService.h"
#include "../logstudio/StyleService.h"
#include "../logstudio/TtsService.h"
#include "../logstudio/PublicationService.h"
#include "../logstudio/CreativeService.h"
#include "../logstudio/VnScriptService.h"
#include "../servers/ServerSettingsService.h"
#include "../servers/DeletionService.h"
#include "../dice/DiceService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../ws/WsGateway.h"
#include "../core/Throttle.h"
#include "../core/Crypto.h"
#include "../core/Text.h"
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
// The session token travels only in the Authorization header.
std::string bearer(const HttpRequestPtr& req) {
    auto h = req->getHeader("Authorization");
    if (h.rfind("Bearer ", 0) == 0) return h.substr(7);
    return "";
}
// Files a browser loads by itself (images, audio, downloads) also accept a short-lived file token in ?token=.
// Browsers load media with <img>/<audio> and a short-lived file token in the query. Their requests for an object in
// the public bucket are answered with a redirect, so the bytes come straight from Cloudflare instead of this server.
// Requests with an Authorization header (native apps, API clients) still get the bytes: some HTTP stacks would carry
// the bearer token along to the other host.
bool mayRedirect(const HttpRequestPtr& req) { return req->getHeader("Authorization").empty(); }
HttpResponsePtr redirectTo(const std::string& url, const char* cacheControl) {
    auto r = HttpResponse::newRedirectionResponse(url, k302Found);
    r->addHeader("Cache-Control", cacheControl);
    r->addHeader("Referrer-Policy", "no-referrer");   // the backend URL carries the file token
    return r;
}
std::optional<Principal> fileAuth(const HttpRequestPtr& req) {
    auto h = bearer(req);
    if (!h.empty()) return services().auth->authenticate(h);
    auto q = req->getParameter("token");
    return q.empty() ? std::nullopt : services().auth->authenticateFileToken(q);
}
// Unexpected failures are logged with their detail and answered with a generic message: SQL text, file paths and
// provider responses never reach the client.
HttpResponsePtr internalErr(const std::exception& e, const HttpRequestPtr& req = nullptr) {
    auto id = crypto::randomHex(6);
    std::string where = req ? std::string(req->methodString()) + " " + req->path() + " " : "";
    if (auto* sql = dynamic_cast<const pqxx::sql_error*>(&e)) ALOG_ERROR << "[" << id << "] " << where << "sql error: " << sql->what() << " :: " << sql->query();
    else ALOG_ERROR << "[" << id << "] " << where << "unhandled: " << e.what();
    return errResp(500, "internal", "internal error (reference " + id + ")");
}
std::string clientIp(const HttpRequestPtr& req) {
    // Behind a trusted reverse proxy: X-Real-IP as the proxy set it, else the address the proxy appended last
    // (the earlier entries of X-Forwarded-For come from the client and can be forged).
    if (services().cfg.trustProxy) {
        auto real = text::trim(req->getHeader("X-Real-IP"));
        if (!real.empty()) return real;
        auto f = req->getHeader("X-Forwarded-For");
        if (!f.empty()) { auto comma = f.rfind(','); return text::trim(comma == std::string::npos ? f : f.substr(comma + 1)); }
    }
    return req->peerAddr().toIp();
}
// Every JSON body is an object; anything else is the client's mistake.
Json::Value body(const HttpRequestPtr& req) {
    auto j = req->getJsonObject();
    Json::Value v;
    if (j) v = *j;
    else {
        auto b = req->getBody();
        if (b.empty()) return Json::Value(Json::objectValue);
        v = json::parse(std::string(b));
    }
    if (v.isNull()) return Json::Value(Json::objectValue);
    if (!v.isObject()) throw badRequest("the request body must be a JSON object");
    return v;
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
    // Values the database or the JSON layer reject are the client's mistake, not a server failure.
    catch (const pqxx::unique_violation&) { cb(errResp(409, "conflict", "that already exists or was just changed by someone else")); }
    catch (const pqxx::check_violation&) { cb(errResp(400, "bad_request", "a value is outside its allowed range")); }
    catch (const pqxx::foreign_key_violation&) { cb(errResp(400, "bad_request", "a referenced item does not exist")); }
    catch (const pqxx::data_exception&) { cb(errResp(400, "bad_request", "a value has the wrong form or is out of range")); }
    catch (const Json::Exception&) { cb(errResp(400, "bad_request", "a value has the wrong type or is out of range")); }
    catch (const std::invalid_argument&) { cb(errResp(400, "bad_request", "a number in the request is malformed")); }
    catch (const std::out_of_range&) { cb(errResp(400, "bad_request", "a number in the request is out of range")); }
    catch (const std::exception& e) { cb(internalErr(e, req)); }
}
// Separate bounded pools keep synchronous database/business work off socket loops.
// A response deadline also prevents an overloaded queue leaving a browser pending indefinitely.
void dispatch(const HttpRequestPtr& req, Cb&& cb, Params params, const Fn& fn, bool auth, bool ai) {
    auto responded = std::make_shared<std::atomic<bool>>(false);
    auto original = std::make_shared<Cb>(std::move(cb));
    auto reply = [responded, original](const HttpResponsePtr& response) { if (!responded->exchange(true)) (*original)(response); };
    auto timer = app().getLoop()->runAfter(ai ? 90.0 : 30.0, [reply, ai] {
        reply(errResp(504, ai ? "ai_timeout" : "request_timeout", ai
            ? "The AI request timed out. Background tasks may still be running; check their status before retrying."
            : "The request timed out. Check the saved state before retrying."));
    });
    auto& pool = ai ? services().aiRequests : services().apiRequests;
    if (!pool->submit([req, reply, responded, timer, params, fn, auth] {
        if (!responded->load()) run(req, Cb(reply), params, fn, auth);
        app().getLoop()->invalidateTimer(timer);
    })) {
        app().getLoop()->invalidateTimer(timer);
        reply(errResp(503, ai ? "ai_busy" : "server_busy", "The request queue is full; try again shortly."));
    }
}
void route0(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb) { dispatch(req, std::move(cb), {}, fn, auth, false); }, m);
}
void route1(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb, std::string a) { dispatch(req, std::move(cb), {a}, fn, auth, false); }, m);
}
void route2(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb, std::string a, std::string b) { dispatch(req, std::move(cb), {a, b}, fn, auth, false); }, m);
}
void route3(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb, std::string a, std::string b, std::string c) { dispatch(req, std::move(cb), {a, b, c}, fn, auth, false); }, m);
}
void offload(const HttpRequestPtr& req, Cb&& cb, Params params, const Fn& fn) {
    dispatch(req, std::move(cb), std::move(params), fn, true, true);
}
void ai1(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool queuedWhenAsync = false) {
    app().registerHandler(path, [fn, queuedWhenAsync](const HttpRequestPtr& req, Cb&& cb, std::string a) {
        auto j=req->getJsonObject();
        if(queuedWhenAsync && j && j->isObject() && (*j)["async"].isBool() && (*j)["async"].asBool()) dispatch(req,std::move(cb),{a},fn,true,false);
        else offload(req, std::move(cb), {a}, fn);
    }, m);
}
void ai2(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn) {
    app().registerHandler(path, [fn](const HttpRequestPtr& req, Cb&& cb, std::string a, std::string b) { offload(req, std::move(cb), {a, b}, fn); }, m);
}
ChannelAccess access(const Principal& p, const std::string& channelId) { return services().auth->channelAccess(p.userId, channelId); }
// The Log Studio, when the server maintainer has not turned it off: before the story ends, the Keeper decides whether
// it is shown at all and whether players may open it; once the story has ended it opens to every member, so that
// everyone can read the whole story.
ChannelAccess studioAccess(const Principal& p, const std::string& channelId) {
    auto a = access(p, channelId);
    if (!services().settings->featureEnabled(a.serverId, "log_studio")) throw ApiError(403, "studio_disabled", "The Log Studio is turned off by the server maintainer");
    auto row = services().db->queryOne("SELECT studio_visible, studio_player_access, story_status FROM channels WHERE id=$1", {a.channelId});
    if (row.isNull()) throw notFound("channel not found");
    if (row["story_status"].asString() == "ended") return a;
    if (!row["studio_visible"].asBool()) throw ApiError(403, "studio_hidden", "The Keeper has hidden the Log Studio in this channel");
    if (!a.isGm && !row["studio_player_access"].asBool()) throw ApiError(403, "studio_locked", "The Keeper opens the Log Studio to players when the story ends");
    return a;
}
Json::Value ok() { Json::Value v; v["ok"] = true; return v; }

} // namespace

void registerRoutes() {
    auto& S = services();

    // ---- health / llm ----
    route0("/api/health", {Get}, [&](auto&, auto&, auto&) { Json::Value v; v["status"] = "ok"; v["ws_connections"] = (int)WsGateway::instance().connectionCount(); S.db->exec("SELECT 1"); v["db"] = "ok"; return v; }, false);

    // ---- auth ----
    // Password guessing: per account, 5 failed logins in 15 minutes; per client address, 30 failed logins in 15 minutes
    // and AUTH_REGISTER_PER_HOUR registrations an hour.
    static Throttle loginByUser(5, std::chrono::minutes(15)), loginByIp(30, std::chrono::minutes(15)), registerByIp(std::max(1, S.cfg.registerPerHour), std::chrono::hours(1));
    auto throttled = [](int seconds) { return ApiError(429, "too_many_attempts", "Too many attempts; try again in " + std::to_string((seconds + 59) / 60) + " minute(s)."); };
    route0("/api/auth/register", {Post}, [&, throttled](auto& req, auto&, auto&) {
        auto ip = "ip:" + clientIp(req);
        if (int w = registerByIp.retryAfter(ip)) throw throttled(w);
        registerByIp.hit(ip);
        auto b = body(req); auto u = S.auth->registerUser(json::requireStr(b, "username"), json::requireStr(b, "password"), json::str(b, "display_name"));
        auto login = S.auth->login(json::requireStr(b, "username"), json::requireStr(b, "password")); login["user"] = S.auth->profile(u["id"].asString()); return login;
    }, false);
    route0("/api/auth/login", {Post}, [&, throttled](auto& req, auto&, auto&) {
        auto b = body(req); auto user = "user:" + text::lower(json::requireStr(b, "username")), ip = "ip:" + clientIp(req);
        if (int w = std::max(loginByUser.retryAfter(user), loginByIp.retryAfter(ip))) throw throttled(w);
        try {
            auto out = S.auth->login(json::requireStr(b, "username"), json::requireStr(b, "password"));
            loginByUser.clear(user);
            return out;
        } catch (const ApiError& e) {
            if (e.status() == 401) { loginByUser.hit(user); loginByIp.hit(ip); }
            throw;
        }
    }, false);
    route0("/api/auth/logout", {Post}, [&](auto& req, auto&, auto&) {
        auto token = bearer(req);
        WsGateway::instance().closeSession(S.auth->sessionHashOf(token));   // its sockets stop receiving at once
        S.auth->logout(token); return ok();
    });
    route0("/api/auth/file-token", {Post}, [&](auto& req, auto&, auto&) { return S.auth->issueFileToken(bearer(req)); });
    route0("/api/auth/me", {Get}, [&](auto&, auto& p, auto&) { return S.auth->profile(p.userId); });
    route0("/api/auth/me", {Put}, [&](auto& req, auto& p, auto&) { return S.auth->updateProfile(p, body(req)); });
    app().registerHandler("/api/users/{1}/avatar", [](const HttpRequestPtr& req, Cb&& cb, std::string userId) {
        try {
            auto principal = fileAuth(req);
            if (!principal) throw unauthorized("missing or invalid token");
            auto av = services().auth->avatar(*principal, userId, mayRedirect(req));
            if (!av.url.empty()) { cb(redirectTo(av.url, "private, max-age=600")); return; }
            auto response = HttpResponse::newHttpResponse();
            response->setContentTypeString(av.mime);
            response->setBody(std::move(av.bytes));
            response->addHeader("X-Content-Type-Options", "nosniff");
            response->addHeader("Cache-Control", "private, no-store");
            cb(response);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); }
          catch (const std::exception&) { cb(errResp(400, "bad_request", "invalid avatar request")); }
    }, {Get});


    // ---- servers ----
    route0("/api/servers", {Get}, [&](auto&, auto& p, auto&) { return S.chat->listServers(p); });
    route0("/api/servers", {Post}, [&](auto& req, auto& p, auto&) { return S.chat->createServer(p, json::requireStr(body(req), "name")); });
    route1("/api/servers/{1}", {Delete}, [&](auto& req, auto& p, auto& a) { return S.deletion->deleteServer(p, a[0], body(req)); });   // owner only
    route1("/api/servers/{1}/join", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.chat->joinServer(p, a[0], json::str(b, "invite_code")); });
    route0("/api/server-directory", {Get}, [&](auto& req, auto& p, auto&) { return S.chat->discoverServers(p, req->getParameter("q")); });
    route1("/api/servers/{1}/invites", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->listInvites(p, a[0]); });
    route1("/api/servers/{1}/invites", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->createInvite(p, a[0], body(req)); });
    route2("/api/servers/{1}/invites/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.chat->revokeInvite(p, a[0], a[1]); });
    route1("/api/invites/{1}", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->previewInvite(p, a[0]); });
    route1("/api/invites/{1}/accept", {Post}, [&](auto&, auto& p, auto& a) { return S.chat->acceptInvite(p, a[0]); });
    route1("/api/servers/{1}/spectate", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->spectatableChannels(p, a[0]); });
    route1("/api/channels/{1}/spectate", {Get}, [&](auto& req, auto& p, auto& a) { return S.chat->spectate(p, a[0], qint(req, "limit", 80), qint(req, "before_seq", 0)); });
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
    route1("/api/servers/{1}/all-channels", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->allChannels(p, a[0]); });
    route1("/api/servers/{1}/channels", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->listChannels(p, a[0]); });
    route1("/api/servers/{1}/channels", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->createChannel(p, a[0], body(req)); });

    // ---- channels / members / characters ----
    route1("/api/channels/{1}", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->getChannel(access(p, a[0])); });
    route1("/api/channels/{1}", {Delete}, [&](auto& req, auto& p, auto& a) { return S.deletion->deleteChannel(p, a[0], body(req)); });   // server maintainers
    route1("/api/channels/{1}", {Put}, [&](auto& req, auto& p, auto& a) { return S.chat->updateChannel(access(p, a[0]), body(req)); });
    route1("/api/channels/{1}/story/end", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->endStory(access(p, a[0]), body(req)); });
    route1("/api/channels/{1}/story/reopen", {Post}, [&](auto&, auto& p, auto& a) { return S.chat->reopenStory(access(p, a[0])); });
    route1("/api/channels/{1}/members", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->channelMembers(access(p, a[0])); });
    route1("/api/channels/{1}/members", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); auto who = json::str(b, "user_id", json::str(b, "username")); if (who.empty()) throw badRequest("user_id or username required"); return S.chat->addChannelMember(access(p, a[0]), who, json::str(b, "role", "player")); });
    route2("/api/channels/{1}/members/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.chat->removeChannelMember(access(p, a[0]), a[1]); });
    route1("/api/channels/{1}/characters", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->listCharacters(access(p, a[0])); });
    route1("/api/channels/{1}/characters", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->createCharacter(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/characters/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.chat->updateCharacter(access(p, a[0]), a[1], body(req)); });
    // ---- character space ----
    route2("/api/channels/{1}/characters/{2}/space", {Get}, [&](auto&, auto& p, auto& a) { return S.characterSpace->space(access(p, a[0]), a[1]); });
    // COC7 point-buy reference: skills with bases, specialisation families, the 230 careers of the community sheet.
    route0("/api/coc7/rules", {Get}, [&](auto&, auto&, auto&) { return coc7::rules(); });
    route2("/api/channels/{1}/characters/{2}/card", {Put}, [&](auto& req, auto& p, auto& a) { return S.characterSpace->updateCard(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/characters/{2}/appearance", {Put}, [&](auto& req, auto& p, auto& a) { return S.characterSpace->updateAppearance(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/characters/{2}/assets", {Post}, [&](auto& req, auto& p, auto& a) {
        auto ac = access(p, a[0]); MultiPartParser mp;
        if (mp.parse(req) != 0 || mp.getFiles().empty()) throw badRequest("multipart upload with a 'file' field required");
        auto& f = mp.getFiles()[0]; auto& ps = mp.getParameters();
        return S.characterSpace->uploadAsset(ac, a[1], ps.count("slot") ? ps.at("slot") : "portrait", ps.count("subtitle") ? ps.at("subtitle") : "", f.getFileName(), std::string(f.fileContent()));
    });
    route2("/api/channels/{1}/characters/{2}/assets/generate", {Post}, [&](auto& req, auto& p, auto& a) { return S.characterSpace->generate(access(p, a[0]), a[1], body(req)); });
    route3("/api/channels/{1}/characters/{2}/assets/{3}", {Delete}, [&](auto&, auto& p, auto& a) { return S.characterSpace->removeAsset(access(p, a[0]), a[1], a[2]); });
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
    // Deprecated alias of /scenarios/enter: scenarios are campaign-wide, the window is ignored.
    route2("/api/channels/{1}/windows/{2}/scene", {Post}, [&](auto& req, auto& p, auto& a) { return S.scenarios->enter(access(p, a[0]), json::requireStr(body(req), "scene_id")); });
    route2("/api/channels/{1}/messages/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->getMessage(access(p, a[0]), a[1]); });
    route1("/api/channels/{1}/messages", {Get}, [&](auto& req, auto& p, auto& a) { return S.chat->searchMessages(access(p, a[0]), req->getParameter("q"), qint(req, "limit", 30)); });

    // ---- scenes / events ----
    route1("/api/channels/{1}/scenes", {Get}, [&](auto&, auto& p, auto& a) { return S.scenes->list(access(p, a[0])); });
    route1("/api/channels/{1}/scenes", {Post}, [&](auto& req, auto& p, auto& a) { return S.scenes->create(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/scenes/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.scenes->get(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/scenes/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.scenes->update(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/scenes/{2}/close", {Post}, [&](auto&, auto& p, auto& a) { return S.scenes->close(access(p, a[0]), a[1]); });
    route1("/api/channels/{1}/scenarios/advance", {Post}, [&](auto& req, auto& p, auto& a) { return S.scenarios->advance(access(p, a[0]), body(req)); });
    route1("/api/channels/{1}/scenarios/enter", {Post}, [&](auto& req, auto& p, auto& a) { return S.scenarios->enter(access(p, a[0]), json::requireStr(body(req), "scene_id")); });
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

    // ---- channel atmosphere and reminder bubbles ----
    route1("/api/channels/{1}/atmosphere", {Get}, [&](auto&,auto& p,auto& a){return S.atmosphere->current(access(p,a[0]));});
    route1("/api/channels/{1}/atmosphere/history", {Get}, [&](auto&,auto& p,auto& a){return S.atmosphere->history(access(p,a[0]));});
    app().registerHandler("/api/channels/{1}/atmosphere/assets/{2}", [&](const HttpRequestPtr& req,Cb&& cb,std::string ch,std::string id){
        try { auto p=fileAuth(req);if(!p)throw unauthorized("authentication required");auto a=access(*p,ch);std::string bytes,mime;
            if(!S.atmosphere->fetch(a,id,bytes,mime))throw notFound("background unavailable");
            auto r=HttpResponse::newHttpResponse();r->setBody(std::move(bytes));r->setContentTypeString(mime);r->addHeader("Cache-Control","private, no-store");r->addHeader("X-Content-Type-Options","nosniff");cb(r);
        }catch(const ApiError& e){cb(errResp(e.status(),e.code(),e.what()));}catch(const std::exception& e){cb(internalErr(e,req));}
    },{Get});
    route1("/api/channels/{1}/reminders", {Get}, [&](auto&, auto& p, auto& a) { return S.reminders->list(access(p, a[0])); });
    route2("/api/channels/{1}/reminders/{2}/dismiss", {Post}, [&](auto&, auto& p, auto& a) { return S.reminders->dismiss(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/reminders/{2}/context", {Get}, [&](auto& req, auto& p, auto& a) { return S.reminders->context(access(p, a[0]), a[1], qint(req, "limit", 30)); });
    // ---- Keeper script knowledge and the pinned board ----
    route1("/api/channels/{1}/script-knowledge", {Get}, [&](auto& req, auto& p, auto& a) { return S.script->list(access(p, a[0]), req->getParameter("kind")); });
    ai1("/api/channels/{1}/script-knowledge/rebuild", {Post}, [&](auto& req, auto& p, auto& a) { return S.script->rebuild(access(p, a[0]), json::str(body(req), "module_id"), json::toBool(body(req),"async",false)); }, true);
    route1("/api/channels/{1}/script-knowledge/builds", {Get}, [&](auto&, auto& p, auto& a) { return S.script->builds(access(p,a[0])); });
    route1("/api/channels/{1}/script-knowledge/changes", {Get}, [&](auto& req, auto& p, auto& a) { return S.script->changes(access(p, a[0]), qint(req, "limit", 50)); });
    ai2("/api/channels/{1}/script-knowledge/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.script->update(access(p, a[0]), a[1], body(req)); });
    route1("/api/channels/{1}/kp/board", {Get}, [&](auto&, auto& p, auto& a) { return S.script->board(access(p, a[0])); });
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
    ai2("/api/channels/{1}/tools/{2}", {Post}, [&](auto& req, auto& p, auto& a) { return S.retrieval->executeTool(access(p, a[0]), a[1], body(req)); });
    route1("/api/channels/{1}/shards", {Get}, [&](auto& req, auto& p, auto& a) { return S.retrieval->getShard(access(p, a[0]), req->getParameter("id")); });

    // ---- AI auxiliary (user-triggered) ----
    ai1("/api/channels/{1}/consistency", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); auto ac = access(p, a[0]); S.settings->requireFeature(ac.serverId, "consistency"); S.chat->requireChannelAi(ac, "consistency_enabled"); return S.consistency->check(ac, json::str(b, "chat_window_id"), json::str(b, "character_id"), json::str(b, "draft")); });
    route1("/api/channels/{1}/consistency/history", {Get}, [&](auto& req, auto& p, auto& a) { return S.consistency->history(access(p, a[0]), qint(req, "limit", 20)); });
    ai1("/api/channels/{1}/inspiration", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); auto ac = access(p, a[0]); S.settings->requireFeature(ac.serverId, "inspiration"); S.chat->requireChannelAi(ac, "inspiration_enabled"); return S.inspiration->draft(ac, json::str(b, "chat_window_id"), json::str(b, "character_id"), json::str(b, "hint"), json::toInt(b, "variant", 0)); });

    // ---- AI observer admin ----
    // Members see the channel's AI mode; the observer's cursors (group keys, private window ids) stay with the Keeper.
    route1("/api/channels/{1}/ai/status", {Get}, [&](auto&, auto& p, auto& a) { auto ac = access(p, a[0]); Json::Value s; if (ac.isGm) { s = S.observer->status(); s["cursors"] = S.db->queryJson("SELECT kind, group_key, last_seq, updated_at FROM ai_processing_cursors WHERE channel_id=$1", {a[0]}); } s["llm"] = S.llm->status(a[0]); return s; });
    route1("/api/channels/{1}/ai/jobs", {Get}, [&](auto& req, auto& p, auto& a) { auto ac = access(p, a[0]); S.auth->requireGm(ac); return S.observer->listJobs(a[0], qint(req, "limit", 30)); });
    ai1("/api/channels/{1}/ai/observe-now", {Post}, [&](auto&, auto& p, auto& a) { auto ac = access(p, a[0]); S.auth->requireGm(ac); Json::Value v; v["jobs"] = S.observer->observeChannel(a[0], true); return v; });
    ai1("/api/channels/{1}/ai/consolidate-now", {Post}, [&](auto&, auto& p, auto& a) { auto ac = access(p, a[0]); S.auth->requireGm(ac); Json::Value v; v["job"] = S.observer->consolidateChannel(a[0]); return v; });
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
    ai1("/api/channels/{1}/modules/text", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); std::vector<std::string> pages = json::strArray(b["pages"]); if (pages.empty() && !json::str(b, "text").empty()) pages.push_back(json::str(b, "text")); return S.modules->importText(access(p, a[0]), json::str(b, "title"), pages, json::toBool(b,"async",false)); }, true);
    route1("/api/channels/{1}/modules/hints", {Get}, [&](auto& req, auto& p, auto& a) { return S.modules->listHints(access(p, a[0]), req->getParameter("status")); });
    route2("/api/channels/{1}/modules/hints/{2}/decide", {Post}, [&](auto& req, auto& p, auto& a) { return S.modules->decideHint(access(p, a[0]), a[1], json::str(body(req), "decision")); });
    route2("/api/channels/{1}/modules/nodes/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.modules->updateNode(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/modules/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.modules->get(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/modules/{2}/retry", {Post}, [&](auto&,auto& p,auto& a){return S.modules->retry(access(p,a[0]),a[1]);});
    route3("/api/channels/{1}/modules/{2}/pages/{3}", {Get}, [&](auto&, auto& p, auto& a) { return S.modules->page(access(p, a[0]), a[1], std::stoi(a[2])); });
    route1("/api/channels/{1}/gm/workspace", {Get}, [&](auto&, auto& p, auto& a) { return S.modules->gmWorkspace(access(p, a[0])); });

    route1("/api/channels/{1}/studio/images/status", {Get}, [&](auto&, auto& p, auto& a) { return S.creative->status(studioAccess(p,a[0])); });
    route1("/api/channels/{1}/studio/images/jobs", {Get}, [&](auto&, auto& p, auto& a) { return S.creative->jobs(studioAccess(p,a[0])); });
    route1("/api/channels/{1}/studio/images/jobs", {Post}, [&](auto& req, auto& p, auto& a) { return S.creative->create(studioAccess(p,a[0]),body(req)); });
    route2("/api/channels/{1}/studio/images/jobs/{2}/cancel", {Post}, [&](auto&, auto& p, auto& a) { return S.creative->cancel(studioAccess(p,a[0]),a[1]); });
    route1("/api/channels/{1}/studio/vn-scripts/status", {Get}, [&](auto&, auto& p, auto& a) { return S.vnScripts->status(studioAccess(p,a[0])); });
    route1("/api/channels/{1}/studio/vn-scripts", {Get}, [&](auto&, auto& p, auto& a) { return S.vnScripts->list(studioAccess(p,a[0])); });
    route1("/api/channels/{1}/studio/vn-scripts", {Post}, [&](auto& req, auto& p, auto& a) { return S.vnScripts->create(studioAccess(p,a[0]),body(req)); });
    route2("/api/channels/{1}/studio/vn-scripts/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.vnScripts->get(studioAccess(p,a[0]),a[1]); });
    route2("/api/channels/{1}/studio/vn-scripts/{2}/cancel", {Post}, [&](auto&, auto& p, auto& a) { return S.vnScripts->cancel(studioAccess(p,a[0]),a[1]); });
    route2("/api/channels/{1}/studio/vn-scripts/{2}/retry", {Post}, [&](auto& req, auto& p, auto& a) { return S.vnScripts->retry(studioAccess(p,a[0]),a[1],body(req)); });
    ai2("/api/channels/{1}/studio/presentations/{2}/suggest", {Post}, [&](auto& req, auto& p, auto& a) { return S.creative->suggest(studioAccess(p,a[0]),a[1],body(req)); });
    route1("/api/channels/{1}/studio/pdf/templates", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->templates(studioAccess(p,a[0])); });
    route1("/api/channels/{1}/studio/pdf/templates", {Post}, [&](auto& req, auto& p, auto& a) { return S.publication->saveTemplate(studioAccess(p,a[0]),body(req)); });
    route2("/api/channels/{1}/studio/snapshots/{2}/pdf", {Post}, [&](auto& req, auto& p, auto& a) { return S.publication->createPdf(studioAccess(p,a[0]),a[1],body(req)); });
    route1("/api/channels/{1}/studio/pdf/jobs", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->pdfJobs(studioAccess(p,a[0])); });
    route2("/api/channels/{1}/studio/pdf/jobs/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->pdfJob(studioAccess(p,a[0]),a[1]); });
    route1("/api/channels/{1}/studio/publications", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->publications(studioAccess(p,a[0])); });
    route1("/api/channels/{1}/studio/publications", {Post}, [&](auto& req, auto& p, auto& a) { return S.publication->publish(studioAccess(p,a[0]),body(req)); });
    route2("/api/channels/{1}/studio/publications/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->publication(studioAccess(p,a[0]),a[1]); });
    route2("/api/channels/{1}/studio/publications/{2}/revoke", {Post}, [&](auto&, auto& p, auto& a) { return S.publication->revoke(studioAccess(p,a[0]),a[1]); });
    route1("/api/published/{1}", {Get}, [&](auto&, auto&, auto& a) { return S.publication->shared(a[0]); },false);
    auto workerAuth=[](const HttpRequestPtr& req) { const char* key=std::getenv("PDF_WORKER_TOKEN"); if(!key||std::string(key).size()<32||!crypto::constantTimeEquals(req->getHeader("X-Worker-Token"),key)) throw forbidden("invalid worker credentials"); };
    route0("/api/internal/pdf/claim", {Post}, [&,workerAuth](auto& req, auto&, auto&) { workerAuth(req); return S.publication->claimPdf(); },false);
    route1("/api/internal/pdf/{1}/finish", {Post}, [&,workerAuth](auto& req, auto&, auto& a) { workerAuth(req); return S.publication->finishPdf(a[0],req->getHeader("X-Worker-Lease"),std::string(req->getBody()),req->getHeader("X-Worker-Error")); },false);
    app().registerHandler("/api/channels/{1}/studio/pdf/jobs/{2}/file", [&](const HttpRequestPtr& req,Cb&& cb,std::string ch,std::string id) {
        try { auto p=fileAuth(req); if(!p) throw ApiError(401,"unauthorized","authentication required"); auto data=S.publication->pdfBytes(studioAccess(*p,ch),id); auto r=HttpResponse::newHttpResponse(); r->setContentTypeString("application/pdf"); r->addHeader("Cache-Control","private, no-store"); r->addHeader("Content-Disposition","inline; filename=log.pdf"); r->setBody(std::move(data)); cb(r); } catch(const ApiError& e) { cb(errResp(e.status(),e.code(),e.what())); } catch(const std::exception&) { cb(errResp(500,"internal","PDF unavailable")); }
    },{Get});
    app().registerHandler("/api/channels/{1}/studio/publications/{2}/files/{3}", [&](const HttpRequestPtr& req,Cb&& cb,std::string ch,std::string pub,std::string id) {
        try { auto p=fileAuth(req); if(!p)throw ApiError(401,"unauthorized","authentication required"); std::string mime; auto data=S.publication->publicationFile(studioAccess(*p,ch),pub,id,mime); auto r=HttpResponse::newHttpResponse(); r->setContentTypeString(mime); r->addHeader("Cache-Control","no-store"); r->addHeader("X-Content-Type-Options","nosniff"); r->setBody(std::move(data)); cb(r); } catch(const ApiError& e) { cb(errResp(e.status(),e.code(),e.what())); } catch(const std::exception&) { cb(errResp(500,"internal","file unavailable")); }
    },{Get});
    app().registerHandler("/api/published/{1}/files/{2}", [&](const HttpRequestPtr&,Cb&& cb,std::string token,std::string id) {
        try { std::string mime; auto data=S.publication->sharedFile(token,id,mime); auto r=HttpResponse::newHttpResponse(); r->setContentTypeString(mime); r->addHeader("Cache-Control","no-store"); r->addHeader("X-Content-Type-Options","nosniff"); r->setBody(std::move(data)); cb(r); } catch(const ApiError& e) { cb(errResp(e.status(),e.code(),e.what())); } catch(const std::exception&) { cb(errResp(500,"internal","file unavailable")); }
    },{Get});

    route1("/api/channels/{1}/studio/settings", {Get}, [&](auto&,auto& p,auto& a){return S.studio->settings(studioAccess(p,a[0]));});
    route1("/api/channels/{1}/studio/settings", {Put}, [&](auto& req,auto& p,auto& a){return S.studio->saveSettings(studioAccess(p,a[0]),body(req));});

    // ---- Log Studio: the campaign log, snapshots, exports ----
    route1("/api/channels/{1}/studio/log", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->campaignLog(studioAccess(p, a[0])); });
    app().registerHandler("/api/channels/{1}/studio/log/export", [&](const HttpRequestPtr& req, Cb&& cb, std::string ch) {
        try {
            auto pr = fileAuth(req); if (!pr) throw ApiError(401, "unauthorized", "authentication required");
            std::string mime, name; auto data = S.studio->exportLog(studioAccess(*pr, ch), req->getParameter("format").empty() ? "json" : req->getParameter("format"), req->getParameter("chat_window_id"), mime, name);
            auto r = HttpResponse::newHttpResponse(); r->setContentTypeString(mime); r->addHeader("Content-Disposition", "attachment; filename=\"" + name + "\""); r->addHeader("Cache-Control", "no-store"); r->setBody(data); cb(r);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); } catch (const std::exception& e) { cb(internalErr(e, req)); }
    }, {Get});
    route1("/api/channels/{1}/studio/projects", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->listProjects(studioAccess(p, a[0])); });
    route1("/api/channels/{1}/studio/projects", {Post}, [&](auto& req, auto& p, auto& a) { return S.studio->createProject(studioAccess(p, a[0]), body(req)); });
    route2("/api/channels/{1}/studio/projects/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->getProject(studioAccess(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/projects/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.studio->updateProject(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/projects/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.studio->deleteProject(studioAccess(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/projects/{2}/events", {Get}, [&](auto& req, auto& p, auto& a) { return S.studio->listEvents(studioAccess(p, a[0]), a[1], qint(req, "limit", 500), qint(req, "after_seq", 0), req->getParameter("scene_key")); });
    route3("/api/channels/{1}/studio/projects/{2}/events/{3}", {Put}, [&](auto& req, auto& p, auto& a) { return S.studio->updateEvent(studioAccess(p, a[0]), a[1], a[2], body(req)); });
    route2("/api/channels/{1}/studio/projects/{2}/scenes", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->sceneSummary(studioAccess(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/projects/{2}/sync", {Post}, [&](auto& req, auto& p, auto& a) { return S.studio->syncFromChannel(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/projects/{2}/snapshots", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->listSnapshots(studioAccess(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/projects/{2}/snapshots", {Post}, [&](auto& req, auto& p, auto& a) { return S.studio->createSnapshot(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/snapshots/{2}", {Get}, [&](auto& req, auto& p, auto& a) { return S.studio->getSnapshot(studioAccess(p, a[0]), a[1], req->getParameter("events") != "false"); });
    app().registerHandler("/api/channels/{1}/studio/snapshots/{2}/export", [&](const HttpRequestPtr& req, Cb&& cb, std::string ch, std::string snap) {
        try {
            auto pr = fileAuth(req); if (!pr) { cb(errResp(401, "unauthorized", "missing or invalid token")); return; }
            std::string mime, name; auto data = S.studio->exportSnapshot(studioAccess(*pr, ch), snap, req->getParameter("format").empty() ? "json" : req->getParameter("format"), mime, name);
            auto r = HttpResponse::newHttpResponse(); r->setBody(data); r->setContentTypeString(mime);
            if (req->getParameter("download") == "1") r->addHeader("Content-Disposition", "attachment; filename=\"" + name + "\"");
            cb(r);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); } catch (const std::exception& e) { cb(internalErr(e, req)); }
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
            auto pr = fileAuth(req); if (!pr) { cb(errResp(401, "unauthorized", "missing or invalid token")); return; }
            auto ac = access(*pr, ch); std::string bytes, mime, name; int v = qint(req, "v", 0);
            std::string direct;
            if (!S.media->fetch(ac, id, v, bytes, mime, name, mayRedirect(req) ? &direct : nullptr)) { cb(errResp(404, "not_found", "asset not found")); return; }
            if (!direct.empty()) { cb(redirectTo(direct, "private, max-age=3600")); return; }
            auto r = HttpResponse::newHttpResponse(); r->setBody(std::move(bytes)); r->setContentTypeString(mime); r->addHeader("Cache-Control", "private, max-age=3600"); r->addHeader("Accept-Ranges", "none"); r->addHeader("X-Content-Type-Options", "nosniff");
            if (mime == "image/svg+xml") r->addHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
            cb(r);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); } catch (const std::exception& e) { cb(internalErr(e, req)); }
    }, {Get});

    // ---- Log Studio: presentations (performance timeline) ----
    route1("/api/channels/{1}/studio/presentations", {Get}, [&](auto& req, auto& p, auto& a) { return S.presentations->list(studioAccess(p, a[0]), req->getParameter("project_id")); });
    route2("/api/channels/{1}/studio/snapshots/{2}/presentations", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->create(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.presentations->get(studioAccess(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/presentations/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.presentations->update(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.presentations->remove(studioAccess(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/presentations/{2}/events/bulk", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->bulkUpdateEvents(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/merge", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->mergeEvents(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/reorder", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->reorder(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/progress", {Get}, [&](auto&, auto& p, auto& a) { return S.presentations->getProgress(studioAccess(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/presentations/{2}/progress", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->saveProgress(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/pscenes/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.presentations->updateScene(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/pevents/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.presentations->updateEvent(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/pevents/{2}/split", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->splitEvent(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/pevents/{2}/suggestion", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->acceptSuggestion(studioAccess(p, a[0]), a[1], json::toBool(body(req), "accept", false)); });

    // ---- Log Studio: visual styles / character visuals ----
    route1("/api/channels/{1}/studio/styles", {Get}, [&](auto&, auto& p, auto& a) { return S.styles->listStyles(studioAccess(p, a[0])); });
    route1("/api/channels/{1}/studio/styles", {Post}, [&](auto& req, auto& p, auto& a) { return S.styles->createStyle(studioAccess(p, a[0]), body(req)); });
    route2("/api/channels/{1}/studio/styles/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.styles->updateStyle(studioAccess(p, a[0]), a[1], body(req)); });
    route1("/api/channels/{1}/studio/character-visuals", {Get}, [&](auto&, auto& p, auto& a) { return S.styles->listCharacterVisuals(studioAccess(p, a[0])); });
    route2("/api/channels/{1}/studio/character-visuals/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.styles->upsertCharacterVisual(studioAccess(p, a[0]), a[1], body(req)); });

    // ---- Log Studio: TTS ----
    route1("/api/channels/{1}/studio/tts/status", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->status(studioAccess(p, a[0])); });
    ai1("/api/channels/{1}/studio/tts/available-voices", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->availableVoices(studioAccess(p, a[0])); });
    route1("/api/channels/{1}/studio/tts/usage", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->usage(studioAccess(p, a[0])); });
    route1("/api/channels/{1}/studio/voices", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->listVoices(studioAccess(p, a[0])); });
    ai1("/api/channels/{1}/studio/voices", {Post}, [&](auto& req, auto& p, auto& a) {
        auto ac = studioAccess(p, a[0]); MultiPartParser mp;
        if (mp.parse(req) == 0 && !mp.getParameters().empty()) { Json::Value b(Json::objectValue); for (auto& [k, v] : mp.getParameters()) { if (k == "consent_metadata" || k == "synthesis_parameters") { try { b[k] = json::parse(v); } catch (...) { b[k] = v; } } else b[k] = v; } std::string audio, mime; if (!mp.getFiles().empty()) { audio = std::string(mp.getFiles()[0].fileContent()); mime = "audio/wav"; } return S.tts->createVoice(ac, b, audio, mime); }
        return S.tts->createVoice(ac, body(req), "", "");
    });
    route2("/api/channels/{1}/studio/voices/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.tts->updateVoice(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/voices/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.tts->deleteVoice(studioAccess(p, a[0]), a[1]); });
    route1("/api/channels/{1}/studio/dictionaries", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->listDictionaries(studioAccess(p, a[0])); });
    route1("/api/channels/{1}/studio/dictionaries", {Post}, [&](auto& req, auto& p, auto& a) { return S.tts->saveDictionary(studioAccess(p, a[0]), "", body(req)); });
    route2("/api/channels/{1}/studio/dictionaries/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.tts->saveDictionary(studioAccess(p, a[0]), a[1], body(req)); });
    ai1("/api/channels/{1}/studio/tts/preview", {Post}, [&](auto& req, auto& p, auto& a) { return S.tts->preview(studioAccess(p, a[0]), body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/tts/estimate", {Post}, [&](auto& req, auto& p, auto& a) { return S.tts->estimate(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/tts/jobs", {Post}, [&](auto& req, auto& p, auto& a) { return S.tts->createJob(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/tts/jobs", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->listJobs(studioAccess(p, a[0]), a[1]); });
    // Dubbing cast: which voice reads each character and the narration.
    route2("/api/channels/{1}/studio/presentations/{2}/cast", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->applyCast(studioAccess(p, a[0]), a[1], body(req)["cast"]); });
    // Standalone visual novel: index.html plus every image and voice line, as one ZIP.
    app().registerHandler("/api/channels/{1}/studio/presentations/{2}/bundle.zip", [&](const HttpRequestPtr& req, Cb&& cb, std::string ch, std::string pid) {
        try {
            auto pr = fileAuth(req); if (!pr) throw ApiError(401, "unauthorized", "authentication required");
            std::string name; auto data = S.publication->bundle(studioAccess(*pr, ch), pid, name);
            auto r = HttpResponse::newHttpResponse(); r->setContentTypeString("application/zip"); r->addHeader("Content-Disposition", "attachment; filename=\"" + name + "\""); r->addHeader("Cache-Control", "no-store"); r->setBody(data); cb(r);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); } catch (const std::exception& e) { cb(internalErr(e, req)); }
    }, {Get});
    route2("/api/channels/{1}/studio/tts/jobs/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->getJob(studioAccess(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/tts/jobs/{2}/cancel", {Post}, [&](auto&, auto& p, auto& a) { return S.tts->cancelJob(studioAccess(p, a[0]), a[1]); });
    app().registerHandler("/api/channels/{1}/studio/tts/audio/{2}", [&](const HttpRequestPtr& req, Cb&& cb, std::string ch, std::string id) {
        try {
            auto pr = fileAuth(req); if (!pr) { cb(errResp(401, "unauthorized", "missing or invalid token")); return; }
            std::string bytes, mime, direct; if (!S.tts->fetchAudio(studioAccess(*pr, ch), id, bytes, mime, mayRedirect(req) ? &direct : nullptr)) { cb(errResp(404, "not_found", "audio not found")); return; }
            if (!direct.empty()) { cb(redirectTo(direct, "private, max-age=86400")); return; }
            auto r = HttpResponse::newHttpResponse(); r->setBody(std::move(bytes)); r->setContentTypeString(mime); r->addHeader("Cache-Control", "private, max-age=86400"); cb(r);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); } catch (const std::exception& e) { cb(internalErr(e, req)); }
    }, {Get});

    // CORS only for the origins listed in CORS_ORIGINS (the bundled frontend is same-origin and needs none).
    static std::vector<std::string> origins = [] { std::vector<std::string> v; std::string cur; for (char c : services().cfg.corsOrigins + ",") { if (c == ',') { cur = text::trim(cur); if (!cur.empty()) v.push_back(cur); cur.clear(); } else cur += c; } return v; }();
    auto allowedOrigin = [](const HttpRequestPtr& req) -> std::string {
        auto o = req->getHeader("Origin");
        if (o.empty()) return "";
        for (auto& a : origins) if (a == "*" || a == o) return o;
        return "";
    };
    app().registerPreRoutingAdvice([allowedOrigin](const HttpRequestPtr& req, AdviceCallback&& acb, AdviceChainCallback&& ccb) {
        if (req->method() == Options) {
            auto r = HttpResponse::newHttpResponse();
            if (auto o = allowedOrigin(req); !o.empty()) {
                r->addHeader("Access-Control-Allow-Origin", o); r->addHeader("Vary", "Origin");
                r->addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
                r->addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                r->addHeader("Access-Control-Max-Age", "600");
            }
            acb(r); return;
        }
        ccb();
    });
    app().registerPostHandlingAdvice([allowedOrigin](const HttpRequestPtr& req, const HttpResponsePtr& resp) {
        if (auto o = allowedOrigin(req); !o.empty()) { resp->addHeader("Access-Control-Allow-Origin", o); resp->addHeader("Vary", "Origin"); }
        resp->addHeader("X-Content-Type-Options", "nosniff");
    });
}

} // namespace acerciae
