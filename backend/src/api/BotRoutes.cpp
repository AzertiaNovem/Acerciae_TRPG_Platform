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
    route2("/api/channels/{1}/windows/{2}/bot-turns", {Post}, [&](auto& req, auto& p, auto& a) { return S.bots->callTurn(access(p, a[0]), a[1], body(req)); });
    route1("/api/channels/{1}/bot-brief", {Put}, [&](auto& req, auto& p, auto& a) { return S.bots->setBrief(access(p, a[0]), body(req)); });
    route2("/api/servers/{1}/bots/{2}/activity", {Get}, [&](auto&, auto& p, auto& a) { return S.bots->activity(p, a[0], a[1]); });
    route2("/api/servers/{1}/bots/{2}/memories", {Get}, [&](auto&, auto& p, auto& a) { return S.bots->memories(p, a[0], a[1]); });
    route2("/api/servers/{1}/bots/{2}/memories", {Post}, [&](auto& req, auto& p, auto& a) { return S.bots->addNote(p, a[0], a[1], body(req)); });
    route3("/api/servers/{1}/bots/{2}/memories/{3}", {Put}, [&](auto& req, auto& p, auto& a) { return S.bots->editMemory(p, a[0], a[1], a[2], body(req)); });
    route3("/api/servers/{1}/bots/{2}/memories/{3}", {Delete}, [&](auto&, auto& p, auto& a) { return S.bots->deleteMemory(p, a[0], a[1], a[2]); });
    route2("/api/channels/{1}/bots/{2}/memory", {Get}, [&](auto&, auto& p, auto& a) { return S.bots->tableMemory(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/bots/{2}/memory", {Delete}, [&](auto&, auto& p, auto& a) { return S.bots->forgetTable(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/bots/{2}/briefing", {Put}, [&](auto& req, auto& p, auto& a) { return S.bots->setBriefing(access(p, a[0]), a[1], body(req)); });
}
}
