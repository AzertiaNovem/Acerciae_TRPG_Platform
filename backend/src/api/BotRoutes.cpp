#include "../app/Services.h"
#include "../bots/BotService.h"
#include "../core/Json.h"
#include <drogon/drogon.h>

#include "RouteSupport.h"
#include "Routes.h"
using namespace drogon;
namespace acerciae::http {
// Bots (docs/BOTS.md): a server's maintainers set them up; a channel's members invite them; its GM removes them.
void registerBotRoutes() {
    auto& S = services();
    route1("/api/servers/{1}/bots", {Get}, [&](auto&, auto& p, auto& a) { return S.bots->list(p, a[0]); });
    route1("/api/servers/{1}/bots", {Post}, [&](auto& req, auto& p, auto& a) { return S.bots->create(p, a[0], body(req)); });
    route2("/api/servers/{1}/bots/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.bots->update(p, a[0], a[1], body(req)); });
    route2("/api/servers/{1}/bots/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.bots->remove(p, a[0], a[1]); });
    route1("/api/channels/{1}/bots", {Get}, [&](auto&, auto& p, auto& a) { return S.bots->channelView(access(p, a[0])); });
    route1("/api/channels/{1}/bots", {Post}, [&](auto& req, auto& p, auto& a) { return S.bots->invite(access(p, a[0]), json::requireStr(body(req), "bot_id")); });
    route2("/api/channels/{1}/bots/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.bots->removeFromChannel(access(p, a[0]), a[1]); });
}
}
