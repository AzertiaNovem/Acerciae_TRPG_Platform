#include "../atmosphere/AtmosphereService.h"
#include "../ws/Notifier.h"
#include "../app/Services.h"
#include "../auth/AuthService.h"
#include "../chat/ChatService.h"
#include "../events/EventStore.h"
#include "../scenes/SceneManager.h"
#include "../scenes/ScenarioService.h"
#include "../reminders/ReminderService.h"
#include "../script/ScriptKnowledgeService.h"
#include "../knowledge/KnowledgeService.h"
#include "../documents/DocumentService.h"
#include "../highlights/HighlightService.h"
#include "../retrieval/ContextRetrievalService.h"
#include "../llm/LlmGateway.h"
#include "../observer/ObserverScheduler.h"
#include "../consistency/ConsistencyService.h"
#include "../inspiration/InspirationService.h"
#include "../modules/ModuleImporter.h"
#include "../servers/ServerSettingsService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include <drogon/drogon.h>
#include <drogon/MultiPart.h>

#include "RouteSupport.h"
#include "Routes.h"
using namespace drogon;
namespace acerciae::http {
void registerKnowledgeRoutes() {
    auto& S = services();
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
    // ---- the living world record (the caller's memory partition) ----
    route1("/api/channels/{1}/world", {Get}, [&](auto&, auto& p, auto& a) { return S.documents->world(access(p, a[0])); });
    // A GM declaration about the world, often off-screen: a GM-only event (no chat message) that the GM's
    // observer treats as authoritative. Player groups never read it. ?observe=true runs the observer like observe-now.
    ai1("/api/channels/{1}/world/declare", {Post}, [&](auto& req, auto& p, auto& a) {
        auto ac = access(p, a[0]); S.auth->requireGm(ac);
        auto b = body(req); auto content = text::trim(json::str(b, "text"));
        std::size_t chars = 0; for (unsigned char c : content) if ((c & 0xC0) != 0x80) chars++;
        if (chars < 1 || chars > 4000) throw badRequest("text must be 1 to 4000 characters");
        NewEvent e; e.channelId = a[0]; e.actorUserId = p.userId; e.actorRole = "gm"; e.kind = "gm.declared"; e.visibility = "gm_only";
        auto ch = S.db->queryOne("SELECT current_scene_id FROM channels WHERE id=$1", {a[0]});
        if (!ch.isNull() && ch["current_scene_id"].isString()) e.sceneId = ch["current_scene_id"].asString();
        e.payload["content"] = content; e.payload["secret"] = json::toBool(b, "secret", false);
        auto ev = S.events->append(e);
        Json::Value out; out["event_id"] = ev["id"]; out["seq"] = ev["seq"];
        auto observe = req->getParameter("observe");
        if (observe == "true" || observe == "1") out["jobs"] = S.observer->observeChannel(a[0], true);
        return out;
    });
    route1("/api/channels/{1}/proposals", {Get}, [&](auto& req, auto& p, auto& a) { return S.documents->listProposals(access(p, a[0]), req->getParameter("status")); });
    route2("/api/channels/{1}/proposals/{2}/decide", {Post}, [&](auto& req, auto& p, auto& a) { return S.documents->decideProposal(access(p, a[0]), a[1], json::toBool(body(req), "accept", false)); });

    // ---- channel atmosphere and reminder bubbles ----
    route1("/api/channels/{1}/atmosphere", {Get}, [&](auto&,auto& p,auto& a){return S.atmosphere->current(access(p,a[0]));});
    route1("/api/channels/{1}/atmosphere/history", {Get}, [&](auto&,auto& p,auto& a){return S.atmosphere->history(access(p,a[0]));});
    app().registerHandler("/api/channels/{1}/atmosphere/assets/{2}", [&](const HttpRequestPtr& req,Cb&& cb,std::string ch,std::string id){
        try { auto p=fileAuth(req);if(!p)throw unauthorized("authentication required");auto a=access(*p,ch);std::string bytes,mime;
            if(!S.atmosphere->fetch(a,id,bytes,mime))throw notFound("background unavailable");
            // A backdrop id names one stored image, shown to everyone in the channel.
            auto etag=etagOf(id);if(notModified(req,etag)){cb(notModifiedResponse(etag,kKeep));return;}
            auto r=HttpResponse::newHttpResponse();r->setBody(std::move(bytes));r->setContentTypeString(mime);r->addHeader("Cache-Control",kKeep);r->addHeader("ETag",etag);r->addHeader("X-Content-Type-Options","nosniff");cb(r);
        }catch(const ApiError& e){cb(errResp(e.status(),e.code(),e.what()));}catch(const std::exception& e){cb(internalErr(e,req));}
    },{Get});
    route1("/api/channels/{1}/reminders", {Get}, [&](auto&, auto& p, auto& a) { return S.reminders->list(access(p, a[0])); });
    route2("/api/channels/{1}/reminders/{2}/dismiss", {Post}, [&](auto&, auto& p, auto& a) { return S.reminders->dismiss(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/reminders/{2}/context", {Get}, [&](auto& req, auto& p, auto& a) { return S.reminders->context(access(p, a[0]), a[1], qint(req, "limit", 30)); });
    // Pinned lines: a member keeps a chat line in their group's bubbles (the GM's for the GM); the pinner or the GM unpins.
    route2("/api/channels/{1}/messages/{2}/pin", {Post}, [&](auto&, auto& p, auto& a) { return S.reminders->pin(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/reminders/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.reminders->unpin(access(p, a[0]), a[1]); });
    // ---- GM script knowledge and the pinned board ----
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
    ai1("/api/channels/{1}/inspiration", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); auto ac = access(p, a[0]); S.settings->requireFeature(ac.serverId, "inspiration"); S.chat->requireChannelAi(ac, "inspiration_enabled"); return S.inspiration->draft(ac, json::str(b, "chat_window_id"), json::str(b, "character_id"), json::str(b, "hint"), json::toInt(b, "variant", 0), b["avoid"]); });

    // ---- AI observer admin ----
    // Members see the channel's AI mode; the observer's cursors (group keys, private window ids) stay with the GM.
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


}
}
