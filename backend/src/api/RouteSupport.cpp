#include "RouteSupport.h"
#include "../app/Services.h"
#include "../servers/ServerSettingsService.h"
#include "../core/WorkPool.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../core/Crypto.h"
#include "../core/Text.h"
#include <atomic>

using namespace drogon;
namespace acerciae::http {
HttpResponsePtr jsonResp(const Json::Value& v, int status) {
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
// Content-Disposition for a file name that may not be ASCII (titles are often Chinese): an ASCII fallback plus RFC 5987.
std::string attachmentHeader(const std::string& name) {
    std::string ascii, enc; static const char* hex = "0123456789ABCDEF";
    for (unsigned char c : name) {
        ascii += (c >= 0x20 && c < 0x7f && c != '"' && c != '\\') ? (char)c : '_';
        if (isalnum(c) || c == '.' || c == '-' || c == '_') enc += (char)c; else { enc += '%'; enc += hex[c >> 4]; enc += hex[c & 15]; }
    }
    return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + enc;
}
// The site's own address for absolute links: PUBLIC_URL, else the scheme and host the request came in on.
std::string siteOrigin(const HttpRequestPtr& req) {
    const auto& cfg = services().cfg;
    if (!cfg.publicUrl.empty()) return cfg.publicUrl;
    auto host = req->getHeader("X-Forwarded-Host"); if (host.empty()) host = req->getHeader("Host");
    if (host.empty() || host.find_first_of(" /\\\"<>") != std::string::npos) return "";
    auto proto = req->getHeader("X-Forwarded-Proto");
    if (proto != "http" && proto != "https") proto = host.rfind("localhost", 0) == 0 || host.rfind("127.", 0) == 0 ? "http" : "https";
    return proto + "://" + host;
}
bool mayRedirect(const HttpRequestPtr& req) { return req->getHeader("Authorization").empty(); }
HttpResponsePtr redirectTo(const std::string& url, const char* cacheControl) {
    auto r = HttpResponse::newRedirectionResponse(url, k302Found);
    r->addHeader("Cache-Control", cacheControl);
    r->addHeader("Referrer-Policy", "no-referrer");   // the backend URL carries the file token
    return r;
}
// Client caching. A stored object is never rewritten (a new upload or version is a new object), so a response naming
// one exactly may be kept for good: it is marked immutable. Only content a player could see gets that mark, so clients
// that keep assets on disk (web, desktop and mobile caches keep only immutable responses) never store GM-private
// material. Every binary carries an ETag, so the rest revalidate with a 304 instead of downloading again.
const char* const kKeep = "private, max-age=31536000, immutable";
// The web client's asset cache asks for the public bucket's URL instead of a redirect to it (`?direct=1`), then fetches
// the object itself in one hop from the page. Following a redirect from the API's origin to the bucket's would make the
// browser send `Origin: null` (a tainted cross-origin redirect), which no CORS policy naming the site matches. `keep` is
// this route's own decision on keeping the object (the same as the immutable mark the bytes would have carried here):
// the bucket marks every object immutable, GM-private material included, so the client keeps only what `keep` allows.
bool wantsDirect(const HttpRequestPtr& req) { return req->getParameter("direct") == "1"; }
const char* const kDirectType = "application/vnd.acerciae.direct+json";
HttpResponsePtr directTo(const std::string& url, bool keep, const char* cacheControl) {
    Json::Value j; j["url"] = url; j["keep"] = keep;
    auto r = HttpResponse::newHttpResponse();
    r->setBody(json::dump(j)); r->setContentTypeString(kDirectType);
    r->addHeader("Cache-Control", cacheControl);
    r->addHeader("Referrer-Policy", "no-referrer");
    return r;
}
HttpResponsePtr toBucket(const HttpRequestPtr& req, const std::string& url, bool keep, const char* cacheControl) {
    return wantsDirect(req) ? directTo(url, keep, cacheControl) : redirectTo(url, cacheControl);
}
std::string etagOf(const std::string& key) { return "\"" + key + "\""; }
bool notModified(const HttpRequestPtr& req, const std::string& etag) {
    auto h = req->getHeader("If-None-Match");
    return !h.empty() && !etag.empty() && (h == "*" || h.find(etag) != std::string::npos);
}
HttpResponsePtr notModifiedResponse(const std::string& etag, const std::string& cacheControl) {
    auto r = HttpResponse::newHttpResponse();
    r->setStatusCode(k304NotModified);
    r->addHeader("ETag", etag);
    r->addHeader("Cache-Control", cacheControl);
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
HttpResponsePtr internalErr(const std::exception& e, const HttpRequestPtr& req) {
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
int64_t qint64(const HttpRequestPtr& req, const char* k, int64_t def) { auto s = req->getParameter(k); if (s.empty()) return def; try { return std::stoll(s); } catch (...) { return def; } }

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
void route0(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb) { dispatch(req, std::move(cb), {}, fn, auth, false); }, m);
}
void route1(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb, std::string a) { dispatch(req, std::move(cb), {a}, fn, auth, false); }, m);
}
void route2(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb, std::string a, std::string b) { dispatch(req, std::move(cb), {a, b}, fn, auth, false); }, m);
}
void route3(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth) {
    app().registerHandler(path, [fn, auth](const HttpRequestPtr& req, Cb&& cb, std::string a, std::string b, std::string c) { dispatch(req, std::move(cb), {a, b, c}, fn, auth, false); }, m);
}
void offload(const HttpRequestPtr& req, Cb&& cb, Params params, const Fn& fn) {
    dispatch(req, std::move(cb), std::move(params), fn, true, true);
}
void ai1(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool queuedWhenAsync) {
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
// The Log Studio, when the server maintainer has not turned it off: before the story ends, the GM decides whether
// it is shown at all and whether players may open it; once the story has ended it opens to every member, so that
// everyone can read the whole story.
ChannelAccess studioAccess(const Principal& p, const std::string& channelId) {
    auto a = access(p, channelId);
    if (!services().settings->featureEnabled(a.serverId, "log_studio")) throw ApiError(403, "studio_disabled", "The Log Studio is turned off by the server maintainer");
    auto row = services().db->queryOne("SELECT studio_visible, studio_player_access, story_status FROM channels WHERE id=$1", {a.channelId});
    if (row.isNull()) throw notFound("channel not found");
    if (row["story_status"].asString() == "ended") return a;
    if (!row["studio_visible"].asBool()) throw ApiError(403, "studio_hidden", "The GM has hidden the Log Studio in this channel");
    if (!a.isGm && !row["studio_player_access"].asBool()) throw ApiError(403, "studio_locked", "The GM opens the Log Studio to players when the story ends");
    return a;
}
Json::Value ok() { Json::Value v; v["ok"] = true; return v; }

}
