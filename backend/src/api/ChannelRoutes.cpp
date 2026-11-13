#include "../chat/Illustrations.h"
#include "../knowledge/Visibility.h"
#include "../rules/PbtaRuling.h"
#include "../app/Services.h"
#include "../auth/AuthService.h"
#include "../chat/ChatService.h"
#include "../scenes/ScenarioService.h"
#include "../servers/ServerSettingsService.h"
#include "../servers/DeletionService.h"
#include "../dice/DiceService.h"
#include "../ai/ProviderCatalog.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include <drogon/drogon.h>

#include "RouteSupport.h"
#include "Routes.h"
using namespace drogon;
namespace acerciae::http {
void registerChannelRoutes() {
    auto& S = services();
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
    // AI providers and model uses (maintainers); the catalog of provider kinds and uses for any signed-in user.
    route0("/api/ai/catalog", {Get}, [&](auto&, auto&, auto&) { Json::Value v; v["kinds"] = ai::catalog::kinds(); v["uses"] = ai::catalog::uses(); return v; });
    route1("/api/servers/{1}/ai", {Get}, [&](auto&, auto& p, auto& a) { S.auth->requireServerAdmin(p.userId, a[0]); return S.settings->aiView(a[0]); });
    route1("/api/servers/{1}/ai/providers", {Post}, [&](auto& req, auto& p, auto& a) { return S.settings->createProvider(p, a[0], body(req)); });
    route2("/api/servers/{1}/ai/providers/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.settings->updateProvider(p, a[0], a[1], body(req)); });
    route2("/api/servers/{1}/ai/providers/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.settings->deleteProvider(p, a[0], a[1]); });
    route1("/api/servers/{1}/ai/uses", {Put}, [&](auto& req, auto& p, auto& a) { return S.settings->updateUses(p, a[0], body(req)); });
    route1("/api/servers/{1}/dice-texts", {Get}, [&](auto&, auto& p, auto& a) { return S.settings->listTextGroups(p, a[0]); });
    route1("/api/servers/{1}/dice-texts", {Post}, [&](auto& req, auto& p, auto& a) { return S.settings->createTextGroup(p, a[0], body(req)); });
    route2("/api/servers/{1}/dice-texts/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.settings->updateTextGroup(p, a[0], a[1], body(req)); });
    route2("/api/servers/{1}/dice-texts/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.settings->deleteTextGroup(p, a[0], a[1]); });
    // The dice persona's avatar (a text group's), for members of its server. ?v= is the avatar version a roll recorded.
    app().registerHandler("/api/dice-avatars/{1}", [](const HttpRequestPtr& req, Cb&& cb, std::string groupId) {
        try {
            auto principal = fileAuth(req);
            if (!principal) throw unauthorized("missing or invalid token");
            auto av = services().settings->diceAvatar(*principal, groupId);
            auto etag = "\"dice-" + groupId + "-" + std::to_string(av.version) + "\"";
            // A roll keeps the version it was made with; an older version is answered with the current picture, uncached.
            bool current = req->getParameter("v") == std::to_string(av.version);
            std::string cc = current ? kKeep : "private, no-cache";
            if (notModified(req, etag)) { cb(notModifiedResponse(etag, cc)); return; }
            auto response = HttpResponse::newHttpResponse();
            response->setContentTypeString(av.mime);
            response->setBody(std::move(av.bytes));
            response->addHeader("X-Content-Type-Options", "nosniff");
            response->addHeader("ETag", etag);
            response->addHeader("Cache-Control", cc);
            cb(response);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); }
          catch (const std::exception&) { cb(errResp(400, "bad_request", "invalid avatar request")); }
    }, {Get});
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
    // ---- windows / messages ----
    route1("/api/channels/{1}/windows", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->listWindows(access(p, a[0])); });
    route1("/api/channels/{1}/windows", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->createWindow(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/windows/{2}/fork", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->forkWindow(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/windows/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.chat->updateWindow(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/windows/{2}/members", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->windowMembers(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/windows/{2}/members", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.chat->addWindowMember(access(p, a[0]), a[1], json::requireStr(b, "user_id"), json::str(b, "character_id")); });
    route3("/api/channels/{1}/windows/{2}/members/{3}", {Delete}, [&](auto&, auto& p, auto& a) { return S.chat->removeWindowMember(access(p, a[0]), a[1], a[2]); });
    route3("/api/channels/{1}/windows/{2}/members/{3}/visibility", {Put}, [&](auto& req, auto& p, auto& a) { return S.chat->setWindowVisibility(access(p,a[0]),a[1],a[2],body(req)); });
    route2("/api/channels/{1}/windows/{2}/messages", {Get}, [&](auto& req, auto& p, auto& a) { return S.chat->listMessages(access(p, a[0]), a[1], qint(req, "limit", 80), qint64(req, "before_seq", 0), req->getParameter("include_history") != "false", qint64(req, "after_seq", -1)); });
    route1("/api/channels/{1}/pbta", {Get}, [&](auto&, auto& p, auto& a) { return pbta::read(*S.db, access(p,a[0])); });
    route1("/api/channels/{1}/pbta/draft", {Get}, [&](auto&, auto& p, auto& a) { return pbta::review(*S.db,access(p,a[0])); });
    route1("/api/channels/{1}/pbta/draft", {Post}, [&](auto& req, auto& p, auto& a) { return pbta::changeReview(*S.db,access(p,a[0]),body(req)); });
    route1("/api/channels/{1}/pbta/preview", {Post}, [&](auto& req, auto& p, auto& a) { return pbta::preview(access(p,a[0]),body(req)); });
    route1("/api/channels/{1}/pbta", {Put}, [&](auto& req, auto& p, auto& a) { return pbta::replace(*S.db, access(p,a[0]), body(req)); });
    route2("/api/channels/{1}/windows/{2}/initiative", {Get}, [&](auto&, auto& p, auto& a) { return S.dice->initiative(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/windows/{2}/initiative", {Post}, [&](auto& req, auto& p, auto& a) { return S.dice->initiativeAction(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/windows/{2}/read", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.chat->markRead(access(p, a[0]), a[1], b["seq"].isNumeric() ? b["seq"].asInt64() : 0); });
    route2("/api/channels/{1}/windows/{2}/pbta-rulings", {Get}, [&](auto& req, auto& p, auto& args) {
        auto a = access(p, args[0]);
        S.auth->requireGm(a);
        S.auth->requireWindowMember(a, args[1]);
        return pbta::rulingHistory(*S.db, a, args[1], qint(req, "before_seq", 0));
    });
    route2("/api/channels/{1}/windows/{2}/pbta-rulings", {Post}, [&](auto& req, auto& p, auto& a) {
        auto b=body(req); auto op=json::str(b,"op");
        if(op!="declare" && op!="move" && op!="ask" && op!="mark") throw badRequest("Invalid ruling action");
        auto actor=json::requireStr(b,"character_id");
        if(!Visibility::isUuid(actor)) throw badRequest("Invalid character ID");
        Json::Value line; line["character_id"]=actor;
        if(op=="move") {
            auto move=json::requireStr(b,"move_id");
            if(move.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_-")!=std::string::npos || move.size()>40) throw badRequest("Invalid move ID");
            if(b.isMember("modifier") && (!b["modifier"].isInt() || b["modifier"].asInt() < -99 || b["modifier"].asInt() > 99))
                throw badRequest("Invalid move modifier");
            line["content"]=".move "+move+(b.get("modifier",0).asInt()!=0?" "+json::str(b,"modifier"):"");
        } else line["content"]=op;
        return S.chat->postMessage(access(p,a[0]),a[1],line,b);
    });
    route2("/api/channels/{1}/windows/{2}/messages", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->postMessage(access(p, a[0]), a[1], body(req)); });
    // Illustrations: drawn on request and posted in the window as the requester's out-of-character line.
    // Drawing is optional: the server's maintainers switch it for the server, the GM for the channel (403
    // feature_disabled). The job list, cancelling and the pictures already posted stay available either way.
    route2("/api/channels/{1}/windows/{2}/illustrations", {Post}, [&](auto& req, auto& p, auto& a) {
        auto ac = access(p, a[0]); S.settings->requireFeature(ac.serverId, "illustrations"); S.chat->requireChannelAi(ac, "illustrations_enabled");
        return S.illustrations->request(ac, a[1], body(req));
    });
    // A picture a member uploads into the window, posted as their line (multipart: `file`, and as for a text line
    // `content` for the caption, `kind`, `character_id`, `visibility`, `whisper_to`). No image AI, no feature switch.
    route2("/api/channels/{1}/windows/{2}/images", {Post}, [&](auto& req, auto& p, auto& a) {
        auto ac = access(p, a[0]); MultiPartParser mp;
        if (mp.parse(req) != 0 || mp.getFiles().empty()) throw badRequest("multipart upload with a 'file' field required");
        auto& f = mp.getFiles()[0]; Json::Value fields(Json::objectValue); for (auto& [k, v] : mp.getParameters()) fields[k] = v;
        return S.illustrations->upload(ac, a[1], f.getFileName(), std::string(f.fileContent()), fields);
    });
    route1("/api/channels/{1}/illustrations", {Get}, [&](auto&, auto& p, auto& a) { return S.illustrations->jobs(access(p, a[0])); });
    route2("/api/channels/{1}/illustrations/{2}/cancel", {Post}, [&](auto&, auto& p, auto& a) { return S.illustrations->cancel(access(p, a[0]), a[1]); });
    // A line's picture, for <img>: only to those who may read the line (?token= since image tags cannot set headers).
    app().registerHandler("/api/channels/{1}/messages/{2}/image", [&](const HttpRequestPtr& req, Cb&& cb, std::string ch, std::string mid) {
        try {
            auto pr = fileAuth(req); if (!pr) { cb(errResp(401, "unauthorized", "missing or invalid token")); return; }
            auto ac = access(*pr, ch); std::string bytes, mime, direct, name;
            const std::string cc = "private, no-store";   // its chat audience may change
            // ?download=1: the bytes themselves, saved as a file with a readable name (never a bucket redirect, which
            // would lose the name).
            const bool download = req->getParameter("download") == "1";
            if (!S.illustrations->image(ac, mid, bytes, mime, !download && mayRedirect(req) ? &direct : nullptr, &name)) { cb(errResp(404, "not_found", "no picture")); return; }
            if (!direct.empty()) { cb(toBucket(req, direct, false, cc.c_str())); return; }
            auto r = HttpResponse::newHttpResponse(); r->setBody(std::move(bytes)); r->setContentTypeString(mime); r->addHeader("Cache-Control", cc); r->addHeader("X-Content-Type-Options", "nosniff");
            if (download) {
                std::string ascii; for (char c : name) ascii += (unsigned char)c < 0x80 && c != '"' ? c : '_';
                r->addHeader("Content-Disposition", "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + drogon::utils::urlEncodeComponent(name));
            }
            cb(r);
        } catch (const ApiError& e) { cb(errResp(e.status(), e.code(), e.what())); } catch (const std::exception& e) { cb(internalErr(e, req)); }
    }, {Get});
    // Deprecated alias of /scenarios/enter: scenarios are campaign-wide, the window is ignored.
    route2("/api/channels/{1}/windows/{2}/scene", {Post}, [&](auto& req, auto& p, auto& a) { return S.scenarios->enter(access(p, a[0]), json::requireStr(body(req), "scene_id")); });
    route2("/api/channels/{1}/messages/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->getMessage(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/messages/{2}/recall", {Post}, [&](auto&, auto& p, auto& a) {
        auto ac = access(p, a[0]); auto out = S.chat->recallMessage(ac, a[1]);
        S.illustrations->recalled(ac, out["message"]);   // an uploaded picture goes with its line
        return out;
    });
    route1("/api/channels/{1}/messages", {Get}, [&](auto& req, auto& p, auto& a) { return S.chat->searchMessages(access(p, a[0]), req->getParameter("q"), qint(req, "limit", 30)); });


}
}
