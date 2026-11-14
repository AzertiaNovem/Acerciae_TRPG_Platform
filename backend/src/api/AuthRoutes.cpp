#include "../app/Services.h"
#include "../auth/AuthService.h"
#include "../admin/AdminService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../ws/WsGateway.h"
#include "../core/Throttle.h"
#include "../core/Text.h"
#include <drogon/drogon.h>

#include "RouteSupport.h"
#include "Routes.h"
using namespace drogon;
namespace acerciae::http {
void registerAuthRoutes() {
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
            if (!av.url.empty()) { cb(toBucket(req, av.url, !req->getParameter("v").empty(), "private, max-age=600")); return; }
            // ?v= names the avatar version the client saw: that URL may be kept; a bare URL revalidates.
            std::string cc = req->getParameter("v").empty() ? "private, no-cache" : kKeep;
            if (notModified(req, av.etag)) { cb(notModifiedResponse(av.etag, cc)); return; }
            auto response = HttpResponse::newHttpResponse();
            response->setContentTypeString(av.mime);
            response->setBody(std::move(av.bytes));
            response->addHeader("X-Content-Type-Options", "nosniff");
            response->addHeader("ETag", av.etag);
            response->addHeader("Cache-Control", cc);
            cb(response);
        } catch (const ApiError& e) { cb(errResp(e)); }
          catch (const std::exception&) { cb(errResp(400, "bad_request", "invalid avatar request")); }
    }, {Get});


    // ---- platform administration (PLATFORM_ADMINS / users.is_admin) ----
    route0("/api/admin/overview", {Get}, [&](auto&, auto& p, auto&) { return S.admin->overview(p); });
    route0("/api/admin/servers", {Get}, [&](auto& req, auto& p, auto&) { return S.admin->servers(p, req->getParameter("q"), req->getParameter("sort"), qint(req, "limit", 50), qint(req, "offset", 0)); });
    route0("/api/admin/users", {Get}, [&](auto& req, auto& p, auto&) { return S.admin->users(p, req->getParameter("q"), req->getParameter("sort"), qint(req, "limit", 50), qint(req, "offset", 0)); });
    route1("/api/admin/servers/{1}", {Get}, [&](auto&, auto& p, auto& a) { return S.admin->server(p, a[0]); });
    route1("/api/admin/users/{1}", {Get}, [&](auto&, auto& p, auto& a) { return S.admin->user(p, a[0]); });
    route1("/api/admin/servers/{1}/suspension", {Put}, [&](auto& req, auto& p, auto& a) { return S.admin->suspendServer(p, a[0], body(req)); });
    route1("/api/admin/users/{1}/suspension", {Put}, [&](auto& req, auto& p, auto& a) { return S.admin->suspendUser(p, a[0], body(req)); });
    route1("/api/admin/users/{1}/admin", {Put}, [&](auto& req, auto& p, auto& a) { return S.admin->setAdmin(p, a[0], body(req)); });
    route0("/api/admin/actions", {Get}, [&](auto& req, auto& p, auto&) { return S.admin->actions(p, qint(req, "limit", 50), qint(req, "offset", 0)); });


}
}
