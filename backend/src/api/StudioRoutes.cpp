#include "../app/Services.h"
#include "../logstudio/LogStudioService.h"
#include "../logstudio/PublicationService.h"
#include "../logstudio/CreativeService.h"
#include "../logstudio/VnScriptService.h"
#include "../core/Errors.h"
#include "../core/Crypto.h"
#include <drogon/drogon.h>

#include "RouteSupport.h"
#include "Routes.h"
using namespace drogon;
namespace acerciae::http {
void registerStudioRoutes() {
    auto& S = services();
    route1("/api/channels/{1}/studio/images/status", {Get}, [&](auto&, auto& p, auto& a) { return S.creative->status(studioAccess(p,a[0])); });
    route1("/api/channels/{1}/studio/images/jobs", {Get}, [&](auto&, auto& p, auto& a) { return S.creative->jobs(studioAccess(p,a[0])); });
    route1("/api/channels/{1}/studio/images/jobs", {Post}, [&](auto& req, auto& p, auto& a) { return S.creative->create(studioAccess(p,a[0]),body(req)); });
    route2("/api/channels/{1}/studio/images/jobs/{2}/cancel", {Post}, [&](auto&, auto& p, auto& a) { return S.creative->cancel(studioAccess(p,a[0]),a[1]); });
    route1("/api/channels/{1}/studio/vn-scripts/status", {Get}, [&](auto&, auto& p, auto& a) { return S.vnScripts->status(studioAccess(p,a[0])); });
    // The chat windows a visual novel may tell, with their lines in a point of view (?scope=&scope_character_id=).
    route1("/api/channels/{1}/studio/vn-scripts/windows", {Get}, [&](auto& req, auto& p, auto& a) { return S.studio->scopeWindows(studioAccess(p,a[0]), req->getParameter("scope"), req->getParameter("scope_character_id")); });
    route1("/api/channels/{1}/studio/vn-scripts", {Get}, [&](auto&, auto& p, auto& a) { return S.vnScripts->list(studioAccess(p,a[0])); });
    route1("/api/channels/{1}/studio/vn-scripts", {Post}, [&](auto& req, auto& p, auto& a) { return S.vnScripts->create(studioAccess(p,a[0]),body(req)); });
    route2("/api/channels/{1}/studio/vn-scripts/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.vnScripts->get(studioAccess(p,a[0]),a[1]); });
    route2("/api/channels/{1}/studio/vn-scripts/{2}/cancel", {Post}, [&](auto&, auto& p, auto& a) { return S.vnScripts->cancel(studioAccess(p,a[0]),a[1]); });
    route2("/api/channels/{1}/studio/vn-scripts/{2}/backgrounds/retry", {Post}, [&](auto& req, auto& p, auto& a) { return S.vnScripts->retryBackgrounds(studioAccess(p,a[0]),a[1],body(req)); });
    route2("/api/channels/{1}/studio/vn-scripts/{2}/retry", {Post}, [&](auto& req, auto& p, auto& a) { return S.vnScripts->retry(studioAccess(p,a[0]),a[1],body(req)); });
    route2("/api/channels/{1}/studio/vn-scripts/{2}/answers", {Post}, [&](auto& req, auto& p, auto& a) { return S.vnScripts->answer(studioAccess(p,a[0]),a[1],body(req)); });
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
        try { auto p=fileAuth(req); if(!p) throw ApiError(401,"unauthorized","authentication required"); auto data=S.publication->pdfBytes(studioAccess(*p,ch),id); auto r=HttpResponse::newHttpResponse(); r->setContentTypeString("application/pdf"); r->addHeader("Cache-Control","private, no-store"); r->addHeader("Content-Disposition","inline; filename=log.pdf"); r->setBody(std::move(data)); cb(r); } catch(const ApiError& e) { cb(errResp(e)); } catch(const std::exception&) { cb(errResp(500,"internal","PDF unavailable")); }
    },{Get});
    app().registerHandler("/api/channels/{1}/studio/publications/{2}/files/{3}", [&](const HttpRequestPtr& req,Cb&& cb,std::string ch,std::string pub,std::string id) {
        try { auto p=fileAuth(req); if(!p)throw ApiError(401,"unauthorized","authentication required"); std::string mime; auto data=S.publication->publicationFile(studioAccess(*p,ch),pub,id,mime); auto r=HttpResponse::newHttpResponse(); r->setContentTypeString(mime); r->addHeader("Cache-Control","no-store"); r->addHeader("X-Content-Type-Options","nosniff"); r->setBody(std::move(data)); cb(r); } catch(const ApiError& e) { cb(errResp(e)); } catch(const std::exception&) { cb(errResp(500,"internal","file unavailable")); }
    },{Get});
    app().registerHandler("/api/published/{1}/files/{2}", [&](const HttpRequestPtr&,Cb&& cb,std::string token,std::string id) {
        try { std::string mime; auto data=S.publication->sharedFile(token,id,mime); auto r=HttpResponse::newHttpResponse(); r->setContentTypeString(mime); r->addHeader("Cache-Control","no-store"); r->addHeader("X-Content-Type-Options","nosniff"); r->setBody(std::move(data)); cb(r); } catch(const ApiError& e) { cb(errResp(e)); } catch(const std::exception&) { cb(errResp(500,"internal","file unavailable")); }
    },{Get});

    route1("/api/channels/{1}/studio/settings", {Get}, [&](auto&,auto& p,auto& a){return S.studio->settings(studioAccess(p,a[0]));});
    route1("/api/channels/{1}/studio/settings", {Put}, [&](auto& req,auto& p,auto& a){return S.studio->saveSettings(studioAccess(p,a[0]),body(req));});

    // ---- Log Studio: the campaign log, snapshots, exports ----
    route1("/api/channels/{1}/studio/log", {Get}, [&](auto&, auto& p, auto& a) { return S.studio->campaignLog(studioAccess(p, a[0])); });
    app().registerHandler("/api/channels/{1}/studio/log/export", [&](const HttpRequestPtr& req, Cb&& cb, std::string ch) {
        try {
            auto pr = fileAuth(req); if (!pr) throw ApiError(401, "unauthorized", "authentication required");
            std::string mime, name; auto data = S.studio->exportLog(studioAccess(*pr, ch), req->getParameter("format").empty() ? "json" : req->getParameter("format"), req->getParameter("chat_window_id"), mime, name, siteOrigin(req));
            auto r = HttpResponse::newHttpResponse(); r->setContentTypeString(mime); r->addHeader("Content-Disposition", attachmentHeader(name)); r->addHeader("Cache-Control", "no-store"); r->setBody(data); cb(r);
        } catch (const ApiError& e) { cb(errResp(e)); } catch (const std::exception& e) { cb(internalErr(e, req)); }
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
            std::string mime, name; auto data = S.studio->exportSnapshot(studioAccess(*pr, ch), snap, req->getParameter("format").empty() ? "json" : req->getParameter("format"), mime, name, siteOrigin(req));
            auto r = HttpResponse::newHttpResponse(); r->setBody(data); r->setContentTypeString(mime);
            if (req->getParameter("download") == "1") r->addHeader("Content-Disposition", "attachment; filename=\"" + name + "\"");
            cb(r);
        } catch (const ApiError& e) { cb(errResp(e)); } catch (const std::exception& e) { cb(internalErr(e, req)); }
    }, {Get});


}
}
