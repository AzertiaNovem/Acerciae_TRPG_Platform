#include "../app/Services.h"
#include "../characters/CharacterSpaceService.h"
#include "../logstudio/MediaService.h"
#include "../logstudio/PresentationService.h"
#include "../logstudio/StyleService.h"
#include "../logstudio/TtsService.h"
#include "../logstudio/PublicationService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include <drogon/drogon.h>
#include <drogon/MultiPart.h>

#include "RouteSupport.h"
#include "Routes.h"
using namespace drogon;
namespace acerciae::http {
void registerMediaRoutes() {
    auto& S = services();
    // ---- Log Studio: media assets ----
    route1("/api/channels/{1}/media", {Get}, [&](auto& req, auto& p, auto& a) { return S.media->list(access(p, a[0]), req->getParameter("type"), req->getParameter("character_id"), req->getParameter("approval")); });
    route1("/api/channels/{1}/media", {Post}, [&](auto& req, auto& p, auto& a) {
        auto ac = access(p, a[0]); MultiPartParser mp;
        if (mp.parse(req) != 0 || mp.getFiles().empty()) throw badRequest("multipart upload with a 'file' field required");
        auto& f = mp.getFiles()[0]; Json::Value meta(Json::objectValue); for (auto& [k, v] : mp.getParameters()) meta[k] = v;
        if (meta.isMember("tags") && meta["tags"].isString()) { Json::Value t(Json::arrayValue); std::string cur; for (char c : meta["tags"].asString()) { if (c == ',') { if (!cur.empty()) t.append(cur); cur.clear(); } else cur += c; } if (!cur.empty()) t.append(cur); meta["tags"] = t; }
        if (meta.isMember("gm_only")) meta["gm_only"] = meta["gm_only"].asString() == "true";
        auto asset = S.media->upload(ac, f.getFileName(), std::string(f.fileContent()), "", meta);
        S.characterSpace->adoptLibraryUpload(ac, asset);   // a character's own image replaces the older one of its subtitle
        return asset;
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
            // A named version of a player-visible asset is kept for good; the current version (no ?v=) revalidates;
            // GM-private material is never marked for keeping.
            logstudio::MediaService::MediaMeta meta;
            if (!S.media->resolve(ac, id, v, meta)) { cb(errResp(404, "not_found", "asset not found")); return; }
            auto etag = etagOf(meta.objectKey);
            std::string cc = meta.privateSource ? "private, no-store" : !meta.playerVisible ? "private, max-age=3600" : meta.pinned ? kKeep : "private, no-cache";
            if (notModified(req, etag)) { cb(notModifiedResponse(etag, cc)); return; }
            std::string direct;
            if (!S.media->fetch(ac, id, v, bytes, mime, name, mayRedirect(req) ? &direct : nullptr)) { cb(errResp(404, "not_found", "asset not found")); return; }
            if (!direct.empty()) { cb(toBucket(req, direct, cc == kKeep, "private, max-age=3600")); return; }
            auto r = HttpResponse::newHttpResponse(); r->setBody(std::move(bytes)); r->setContentTypeString(mime); r->addHeader("Cache-Control", cc); r->addHeader("ETag", etag); r->addHeader("Accept-Ranges", "none"); r->addHeader("X-Content-Type-Options", "nosniff");
            if (mime == "image/svg+xml") r->addHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
            cb(r);
        } catch (const ApiError& e) { cb(errResp(e)); } catch (const std::exception& e) { cb(internalErr(e, req)); }
    }, {Get});

    // ---- Log Studio: presentations (performance timeline) ----
    route1("/api/channels/{1}/studio/presentations", {Get}, [&](auto& req, auto& p, auto& a) { return S.presentations->list(studioAccess(p, a[0]), req->getParameter("project_id")); });
    route2("/api/channels/{1}/studio/snapshots/{2}/presentations", {Post}, [&](auto& req, auto& p, auto& a) { return S.presentations->create(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.presentations->get(studioAccess(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/presentations/{2}/hybrid", {Get}, [&](auto&, auto& p, auto& a) { return S.presentations->hybrid(studioAccess(p, a[0]), a[1], *S.media); });
    route2("/api/channels/{1}/studio/presentations/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.presentations->update(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}", {Delete}, [&](auto&, auto& p, auto& a) { return S.publication->deletePresentation(studioAccess(p, a[0]), a[1]); });
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
            auto r = HttpResponse::newHttpResponse(); r->setContentTypeString("application/zip"); r->addHeader("Content-Disposition", attachmentHeader(name)); r->addHeader("Cache-Control", "no-store"); r->setBody(data); cb(r);
        } catch (const ApiError& e) { cb(errResp(e)); } catch (const std::exception& e) { cb(internalErr(e, req)); }
    }, {Get});
    // The same, file by file (the desktop app saves it into a folder and skips files it already has).
    route2("/api/channels/{1}/studio/presentations/{2}/files", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->bundleManifest(studioAccess(p, a[0]), a[1]); });
    // Background bundles: prepared off the request, kept for VN_BUNDLE_TTL_HOURS, then deleted.
    route2("/api/channels/{1}/studio/presentations/{2}/bundle", {Post}, [&](auto& req, auto& p, auto& a) { return S.publication->requestBundle(studioAccess(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/studio/presentations/{2}/bundles", {Get}, [&](auto&, auto& p, auto& a) { return S.publication->bundleJobs(studioAccess(p, a[0]), a[1]); });
    app().registerHandler("/api/channels/{1}/studio/bundles/{2}/download", [&](const HttpRequestPtr& req, Cb&& cb, std::string ch, std::string id) {
        try {
            auto pr = fileAuth(req); if (!pr) throw ApiError(401, "unauthorized", "authentication required");
            std::string url, bytes, name;
            if (!S.publication->bundleDownload(studioAccess(*pr, ch), id, mayRedirect(req), url, bytes, name)) throw ApiError(404, "not_found", "this download is not ready or has expired; prepare it again");
            if (!url.empty()) { cb(redirectTo(url, "no-store")); return; }
            auto r = HttpResponse::newHttpResponse(); r->setContentTypeString("application/zip"); r->addHeader("Content-Disposition", attachmentHeader(name)); r->addHeader("Cache-Control", "no-store"); r->setBody(std::move(bytes)); cb(r);
        } catch (const ApiError& e) { cb(errResp(e)); } catch (const std::exception& e) { cb(internalErr(e, req)); }
    }, {Get});
    route2("/api/channels/{1}/studio/tts/jobs/{2}", {Get}, [&](auto&, auto& p, auto& a) { return S.tts->getJob(studioAccess(p, a[0]), a[1]); });
    route2("/api/channels/{1}/studio/tts/jobs/{2}/cancel", {Post}, [&](auto&, auto& p, auto& a) { return S.tts->cancelJob(studioAccess(p, a[0]), a[1]); });
    app().registerHandler("/api/channels/{1}/studio/tts/audio/{2}", [&](const HttpRequestPtr& req, Cb&& cb, std::string ch, std::string id) {
        try {
            auto pr = fileAuth(req); if (!pr) { cb(errResp(401, "unauthorized", "missing or invalid token")); return; }
            auto ac = studioAccess(*pr, ch);
            // Only public-source clips are cacheable; private audio and previews remain authenticated and transient.
            bool shared = false;
            std::string etag = etagOf(id);
            std::string bytes, mime, direct; if (!S.tts->fetchAudio(ac, id, bytes, mime, mayRedirect(req) ? &direct : nullptr, &shared)) { cb(errResp(404, "not_found", "audio not found")); return; }
            std::string cc = !shared ? "private, no-store" : ac.isGm ? "private, max-age=86400" : kKeep;
            if (!direct.empty()) { cb(toBucket(req, direct, shared && !ac.isGm, "private, max-age=86400")); return; }
            if (notModified(req, etag)) { cb(notModifiedResponse(etag, cc)); return; }
            auto r = HttpResponse::newHttpResponse(); r->setBody(std::move(bytes)); r->setContentTypeString(mime); r->addHeader("Cache-Control", cc); r->addHeader("ETag", etag); cb(r);
        } catch (const ApiError& e) { cb(errResp(e)); } catch (const std::exception& e) { cb(internalErr(e, req)); }
    }, {Get});


}
}
