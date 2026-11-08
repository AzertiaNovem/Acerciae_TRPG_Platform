#include "../app/Services.h"
#include "../core/Errors.h"
#include "../core/Text.h"
#include <drogon/drogon.h>
#include <set>

#include "RouteSupport.h"
#include "Routes.h"
using namespace drogon;
namespace acerciae::http {
void registerCors() {
    // CORS only for the origins listed in CORS_ORIGINS and the desktop app (the bundled frontend is same-origin).
    static std::vector<std::string> origins = [] { std::vector<std::string> v; std::string cur; for (char c : services().cfg.corsOrigins + ",") { if (c == ',') { cur = text::trim(cur); if (!cur.empty()) v.push_back(cur); cur.clear(); } else cur += c; } return v; }();
    auto allowedOrigin = [](const HttpRequestPtr& req) -> std::string {
        auto o = req->getHeader("Origin");
        if (o.empty()) return "";
        for (auto& a : origins) if (a == "*" || a == o) return o;
        // The desktop app (Tauri) loads its pages from these origins on macOS/Linux and Windows. Requests carry a
        // bearer token, never cookies, so allowing them exposes nothing a token holder could not already reach.
        static const std::set<std::string> desktop = {"tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"};
        if (desktop.count(o)) return o;
        return "";
    };
    app().registerPreRoutingAdvice([allowedOrigin](const HttpRequestPtr& req, AdviceCallback&& acb, AdviceChainCallback&& ccb) {
        if (req->method() == Options) {
            auto r = HttpResponse::newHttpResponse();
            r->addHeader("Vary", "Origin");
            if (auto o = allowedOrigin(req); !o.empty()) {
                r->addHeader("Access-Control-Allow-Origin", o);
                r->addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
                r->addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                r->addHeader("Access-Control-Max-Age", "600");
            }
            acb(r); return;
        }
        ccb();
    });
    app().registerPostHandlingAdvice([allowedOrigin](const HttpRequestPtr& req, const HttpResponsePtr& resp) {
        // Every response varies by Origin, whether or not this one carries the CORS header: a browser otherwise reuses
        // the cached answer to an <img> load (no Origin, no header) for a fetch() from the web app and fails its CORS
        // check, which bites on the 302 to the public bucket.
        resp->addHeader("Vary", "Origin");
        if (auto o = allowedOrigin(req); !o.empty()) resp->addHeader("Access-Control-Allow-Origin", o);
        resp->addHeader("X-Content-Type-Options", "nosniff");
    });
}
}
