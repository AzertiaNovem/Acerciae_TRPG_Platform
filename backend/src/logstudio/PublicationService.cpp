#include "PublicationService.h"
#include "VnBundle.h"
#include "../core/Zip.h"
#include "../core/Crypto.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../documents/DocumentService.h"
#include "../knowledge/Visibility.h"
#include "../ws/Notifier.h"
#include "LogStudioService.h"
#include "MediaService.h"
#include "PresentationService.h"
#include <cmath>
#include <drogon/utils/Utilities.h>
#include <regex>
#include <set>
#include <tuple>
namespace acerciae::logstudio {
static DbParam opt(const std::string &s) {
  return s.empty() ? dbNull() : DbParam(s);
}
Json::Value PublicationService::validateConfig(const Json::Value &in) {
  if (!in.isObject())
    throw badRequest("template config must be an object");
  Json::Value c;
  auto choice = [&](const char *key, const char *fallback,
                    std::set<std::string> values) {
    auto v = json::str(in, key, fallback);
    if (!values.count(v))
      throw badRequest(std::string("invalid ") + key);
    c[key] = v;
  };
  choice("base", "classic", {"classic", "dossier", "novel"});
  choice("page_size", "A5", {"A4", "A5", "B5"});
  choice("orientation", "portrait", {"portrait", "landscape"});
  choice("font", "serif", {"serif", "sans"});
  choice("dice_style", "box", {"box", "inline", "hide"});
  for (auto [key, def, low, high] : {std::tuple{"font_size", 11.0, 8.0, 24.0},
                                     {"line_height", 1.7, 1.0, 2.5},
                                     {"margin_mm", 18.0, 8.0, 40.0}}) {
    if (in.isMember(key) && !in[key].isNumeric())
      throw badRequest(std::string("invalid ") + key);
    double v = in.isMember(key) ? in[key].asDouble() : def;
    if (!std::isfinite(v) || v < low || v > high)
      throw badRequest(std::string("invalid ") + key);
    c[key] = v;
  }
  for (auto key :
       {"include_ooc", "timestamps", "toc", "page_numbers", "chapter_breaks"})
    c[key] = json::toBool(in, key,
                          std::string(key) != "include_ooc" &&
                              std::string(key) != "timestamps");
  for (auto key : {"title", "subtitle", "header", "footer", "cover_asset_id"}) {
    auto v = json::str(in, key);
    if (v.size() > 1000)
      throw badRequest("template text too long");
    c[key] = v;
  }
  c["scene_images"] = Json::Value(Json::objectValue);
  c["character_colors"] = Json::Value(Json::objectValue);
  if (in["scene_images"].isObject()) {
    if (in["scene_images"].size() > 100)
      throw badRequest("too many illustrations");
    for (auto it = in["scene_images"].begin(); it != in["scene_images"].end();
         ++it)
      c["scene_images"][it.name()] = it->asString();
  }
  if (in["character_colors"].isObject())
    for (auto it = in["character_colors"].begin();
         it != in["character_colors"].end(); ++it) {
      auto v = it->asString();
      if (!std::regex_match(v, std::regex("#[0-9a-fA-F]{6}")))
        throw badRequest("colors must be six-digit hex");
      c["character_colors"][it.name()] = v;
    }
  return c;
}
void PublicationService::snapshotAccess(const ChannelAccess &a,
                                        const std::string &id) {
  logs_.getSnapshot(a, id, false);
}
Json::Value PublicationService::templates(const ChannelAccess &a) {
  auto rows = db_.queryJson("SELECT * FROM pdf_templates WHERE channel_id=$1 "
                            "ORDER BY updated_at DESC",
                            {a.channelId});
  for (auto base : {"classic", "dossier", "novel"}) {
    Json::Value r, c;
    c["base"] = base;
    r["id"] = base;
    r["name"] = base;
    r["config"] = validateConfig(c);
    r["builtin"] = true;
    rows.append(r);
  }
  return rows;
}
Json::Value PublicationService::saveTemplate(const ChannelAccess &a,
                                             const Json::Value &b) {
  if (!a.isGm)
    throw forbidden("GM role required");
  auto c = validateConfig(b["config"]);
  auto name = json::requireStr(b, "name");
  return db_.queryOne(
      "INSERT INTO pdf_templates(channel_id,name,base,config,created_by) "
      "VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *",
      {a.channelId, name, c["base"].asString(), json::dump(c), a.userId});
}
Json::Value PublicationService::image(const ChannelAccess &a,
                                      const std::string &id, bool publicOnly) {
  auto m = media_.get(a, id);
  if (m["approval_status"] != "approved" ||
      (publicOnly && m["visibility_scope"] != "channel"))
    throw badRequest(
        "only approved, audience-compatible images may be exported");
  auto mime = m["mime"].asString();
  if (mime.rfind("image/", 0) != 0 || mime == "image/svg+xml")
    throw badRequest("raster image required");
  std::string bytes, name;
  if (!media_.fetch(a, id, m["version"].asInt(), bytes, mime, name))
    throw notFound("image file missing");
  if (bytes.size() > 10 * 1024 * 1024)
    throw badRequest("publication image exceeds 10 MB");
  Json::Value r;
  r["version"] = m["version"];
  r["data_uri"] =
      "data:" + mime + ";base64," + drogon::utils::base64Encode(bytes);
  return r;
}
Json::Value PublicationService::createPdf(const ChannelAccess &a,
                                          const std::string &id,
                                          const Json::Value &b) {
  auto snap = logs_.getSnapshot(a, id, true);
  auto c = validateConfig(b["config"]);
  Json::Value payload;
  payload["snapshot"] = snap;
  payload["config"] = c;
  payload["images"] = Json::Value(Json::objectValue);
  auto addImage = [&](const std::string &asset) {
    if (!asset.empty())
      payload["images"][asset] = image(a, asset, snap["scope"] != "gm_full");
  };
  addImage(json::str(c, "cover_asset_id"));
  for (const auto &asset : c["scene_images"])
    addImage(asset.asString());
  auto docIds = json::strArray(b["appendix_document_ids"]);
  if (docIds.size() > 6)
    throw badRequest("at most six appendix documents");
  ChannelAccess reader = a;
  if (snap["scope"] != "gm_full") {
    reader.isGm = false;
    reader.characterIds.clear();
    if (snap["scope"] == "character")
      reader.characterIds.push_back(snap["scope_character_id"].asString());
  }
  if(!docIds.empty() && snap["scope"]=="pl_public") throw badRequest("Independent memory appendices require a private export");
  payload["appendices"] = Json::Value(Json::arrayValue);
  for (const auto &docId : docIds) {
    auto doc = documents_.getDocument(reader, docId, "", -1);
    Json::Value appendix;
    appendix["document_id"] = docId;
    appendix["version"] = doc["version"];
    appendix["title"] = doc["title"];
    appendix["entries"] = Json::Value(Json::arrayValue);
    for (const auto &e : doc["entries"])
      if (e["status"] == "confirmed" || e["status"] == "resolved") {
        Json::Value entry;
        entry["entry_id"] = e["id"];
        entry["summary"] = e["summary"];
        entry["content"] = e["content_md"];
        entry["source_event_ids"] = e["source_event_ids"];
        appendix["entries"].append(entry);
      }
    payload["appendices"].append(appendix);
  }
  auto data = json::dump(payload);
  if (data.size() > 32 * 1024 * 1024)
    throw badRequest(
        "render payload exceeds 32 MB; split into smaller snapshots");
  auto idem = crypto::sha256Hex(a.channelId + id + data);
  auto old = db_.queryOne(
      "SELECT id,status FROM pdf_render_jobs WHERE idempotency_key=$1", {idem});
  if (!old.isNull()) {
    if (old["status"] == "failed" && json::toBool(b, "retry"))
      db_.exec("UPDATE pdf_render_jobs SET "
               "status='pending',attempts=0,error=NULL,updated_at=now() WHERE "
               "id=$1 AND status='failed'",
               {old["id"].asString()});
    return pdfJob(a, old["id"].asString());
  }
  auto job = db_.queryOne(
      "INSERT INTO "
      "pdf_render_jobs(channel_id,project_id,snapshot_id,template_config,scope,"
      "scope_character_id,created_by,idempotency_key,render_payload,kp_memory,memory_group_id,memory_group_version) "
      "VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10,$11::uuid,$12) ON "
      "CONFLICT(idempotency_key) DO UPDATE SET "
      "idempotency_key=EXCLUDED.idempotency_key RETURNING id",
      {a.channelId, snap["project_id"].asString(), id, json::dump(c),
       snap["scope"].asString(), opt(json::str(snap, "scope_character_id")),
       a.userId, idem, data, !docIds.empty() && reader.isGm,
       docIds.empty() || reader.playerGroupId.empty() ? dbNull() : DbParam(reader.playerGroupId),
       docIds.empty() ? dbNull() : DbParam((int64_t)reader.playerGroupVersion)});
  logs_.audit(a, "pdf.create", job);
  return pdfJob(a, job["id"].asString());
}
Json::Value PublicationService::pdfJob(const ChannelAccess &a,
                                       const std::string &id) {
  auto j = db_.queryOne(
      "SELECT "
      "id,channel_id,snapshot_id,template_config,scope,scope_character_id,"
      "status,bytes,pages,attempts,error,created_at,finished_at,kp_memory,memory_group_id,memory_group_version FROM "
      "pdf_render_jobs WHERE id=$1 AND channel_id=$2",
      {id, a.channelId});
  if (j.isNull())
    throw notFound("PDF job not found");
  if(j["kp_memory"].asBool() && !a.isGm) throw forbidden("KP memory export");
  if(!j["memory_group_id"].isNull() && (a.isGm || j["memory_group_id"].asString()!=a.playerGroupId || j["memory_group_version"].asInt()!=a.playerGroupVersion)) throw forbidden("Player memory export belongs to another group version");
  snapshotAccess(a, j["snapshot_id"].asString());
  return j;
}
Json::Value PublicationService::pdfJobs(const ChannelAccess &a) {
  auto rows = db_.queryJson("SELECT id FROM pdf_render_jobs WHERE "
                            "channel_id=$1 ORDER BY created_at DESC LIMIT 100",
                            {a.channelId});
  Json::Value out(Json::arrayValue);
  for (auto &r : rows) {
    try {
      out.append(pdfJob(a, r["id"].asString()));
    } catch (const ApiError &e) {
      if (e.status() != 403)
        throw;
    }
  }
  return out;
}
std::string PublicationService::pdfBytes(const ChannelAccess &a,
                                         const std::string &id) {
  auto j = pdfJob(a, id);
  if (j["status"] != "completed")
    throw badRequest("PDF is not ready");
  auto r =
      db_.queryOne("SELECT object_key FROM pdf_render_jobs WHERE id=$1", {id});
  auto data = store_.get(r["object_key"].asString());
  if (!data)
    throw notFound("PDF missing");
  logs_.audit(a, "pdf.download", j["id"]);
  return *data;
}
Json::Value PublicationService::claimPdf() {
  return db_.tx([&](pqxx::work &w) {
    Db::exec(w, "UPDATE pdf_render_jobs SET status=CASE WHEN "
                "attempts<max_attempts THEN 'pending' ELSE 'failed' "
                "END,error='worker lease expired',lease_token=NULL WHERE "
                "status='running' AND lease_expires_at<now()");
    return Db::queryOne(
        w,
        "UPDATE pdf_render_jobs SET "
        "status='running',attempts=attempts+1,started_at=now(),lease_token=$1,"
        "lease_expires_at=now()+interval '5 minutes',updated_at=now() WHERE "
        "id=(SELECT id FROM pdf_render_jobs WHERE status='pending' ORDER BY "
        "created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING "
        "id,lease_token,render_payload",
        {crypto::randomHex(32)});
  });
}
Json::Value PublicationService::finishPdf(const std::string &id,
                                          const std::string &lease,
                                          const std::string &bytes,
                                          const std::string &error) {
  auto j = db_.queryOne(
      "SELECT * FROM pdf_render_jobs WHERE id=$1 AND lease_token=$2 AND "
      "status='running' AND lease_expires_at>now()",
      {id, lease});
  if (j.isNull())
    throw forbidden("expired worker lease");
  std::string key;
  if (error.empty()) {
    if (bytes.size() < 5 || bytes.compare(0, 5, "%PDF-") != 0 ||
        bytes.size() > 60 * 1024 * 1024)
      throw badRequest("invalid PDF output");
    key = safeObjectKey(j["channel_id"].asString(), "pdf", "pdf");
    store_.put(key, bytes, "application/pdf");
  }
  auto status = error.empty() ? "completed"
                : j["attempts"].asInt() < j["max_attempts"].asInt() ? "pending"
                                                                    : "failed";
  auto out = db_.queryOne("UPDATE pdf_render_jobs SET "
                          "status=$3,object_key=$4,bytes=$5,error=$6,finished_"
                          "at=now(),updated_at=now(),lease_token=NULL WHERE "
                          "id=$1 AND lease_token=$2 RETURNING id,status",
                          {id, lease, status, opt(key), (int64_t)bytes.size(),
                           opt(error.substr(0, 1000))});
  notifier_.studioEvent(j["channel_id"].asString(), "pdf.updated", out, true);
  return out;
}
Json::Value PublicationService::publicRow(Json::Value row) {
  row.removeMember("share_token");
  return row;
}
Json::Value PublicationService::publish(const ChannelAccess &a,
                                        const Json::Value &b) {
  if (!a.isGm)
    throw forbidden("GM publishes final products");
  auto snap = logs_.getSnapshot(a, json::requireStr(b, "snapshot_id"), true);
  auto kind = json::str(b, "kind", "styled"),
       vis = json::str(b, "visibility", "players");
  if (kind != "styled" && kind != "pdf" && kind != "vn")
    throw badRequest("invalid publication kind");
  if (vis != "gm" && vis != "players" && vis != "link")
    throw badRequest("invalid publication visibility");
  if (vis != "gm" && snap["scope"] != "pl_public")
    throw badRequest("shared products require a public-player snapshot");
  Json::Value content;
  content["snapshot"] = snap;
  content["assets"] = Json::Value(Json::objectValue);
  content["audio"] = Json::Value(Json::objectValue);
  Json::Value versions(Json::objectValue);
  std::string pdf = json::str(b, "pdf_job_id"),
              pid = json::str(b, "presentation_id");
  if (kind == "pdf") {
    auto j = pdfJob(a, pdf);
    if(j["kp_memory"].asBool() || !j["memory_group_id"].isNull()) throw forbidden("Memory appendices are private exports and cannot be published");
    if (j["snapshot_id"] != snap["id"] || j["status"] != "completed")
      throw badRequest("PDF must be completed and use this snapshot");
  }
  if (kind == "vn") {
    auto p = pres_.get(a, pid);
    if (p["snapshot_id"] != snap["id"])
      throw badRequest("presentation snapshot mismatch");
    if (vis != "gm")
      PresentationService::limitVisuals(p);
    auto freeze = [&](const std::string &asset, int version) {
      if (asset.empty())
        return;
      auto m = media_.get(a, asset);
      if (m["approval_status"] != "approved" ||
          (vis != "gm" && m["visibility_scope"] != "channel"))
        throw badRequest("asset is not publishable");
      if (version <= 0)
        version = m["version"].asInt();
      auto v = db_.queryOne("SELECT object_key,mime FROM asset_versions WHERE "
                            "asset_id=$1 AND version=$2",
                            {asset, (int64_t)version});
      if (v.isNull())
        throw badRequest("asset version missing");
      content["assets"][asset] = v;
      versions[asset] = version;
    };
    for (auto &scene : p["scenes"]) {
      freeze(json::str(scene, "background_asset_id"),
             json::toInt(scene, "background_asset_version", 0));
      freeze(json::str(scene, "bgm_asset_id"), 0);
    }
    for (auto &e : p["events"]) {
      e.removeMember("ai_suggestion");
      for (auto &c : e["character_asset_ids"])
        freeze(json::str(c, "asset_id"), json::toInt(c, "asset_version", 0));
      if (e["audio_asset_id"].isString()) {
        auto t = db_.queryOne("SELECT object_key,mime FROM tts_audio_assets "
                              "WHERE id=$1 AND channel_id=$2",
                              {e["audio_asset_id"].asString(), a.channelId});
        if (!t.isNull())
          content["audio"][e["audio_asset_id"].asString()] = t;
      }
    }
    content["presentation"] = p;
  }
  auto token = vis == "link" ? crypto::randomHex(32) : "";
  auto r = db_.queryOne(
      "INSERT INTO "
      "published_logs(channel_id,project_id,snapshot_id,presentation_id,pdf_"
      "job_id,kind,title,visibility,share_token,frozen_asset_versions,frozen_"
      "content,published_by) "
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12) RETURNING "
      "id,share_token",
      {a.channelId, snap["project_id"].asString(), snap["id"].asString(),
       kind == "vn" ? opt(pid) : dbNull(), kind == "pdf" ? opt(pdf) : dbNull(),
       kind, json::str(b, "title", snap["title"].asString()), vis, opt(token),
       json::dump(versions), json::dump(content), a.userId});
  logs_.audit(a, "publication.create", r["id"]);
  return r;
}
Json::Value PublicationService::publications(const ChannelAccess &a) {
  return db_.queryJson(
      "SELECT "
      "id,title,kind,visibility,revoked,created_at,snapshot_id,presentation_id,"
      "pdf_job_id FROM published_logs WHERE channel_id=$1" +
          std::string(a.isGm ? "" : " AND visibility<>'gm' AND NOT revoked") +
          " ORDER BY created_at DESC",
      {a.channelId});
}
Json::Value PublicationService::publication(const ChannelAccess &a,
                                            const std::string &id) {
  auto r = db_.queryOne("SELECT * FROM published_logs WHERE id=$1 AND "
                        "channel_id=$2 AND NOT revoked",
                        {id, a.channelId});
  if (r.isNull())
    throw notFound("publication not found");
  if (!a.isGm && r["visibility"] == "gm")
    throw forbidden("GM publication");
  snapshotAccess(a, r["snapshot_id"].asString());
  r["frozen_content"].removeMember("assets");
  r["frozen_content"].removeMember("audio");
  return publicRow(r);
}
Json::Value PublicationService::shared(const std::string &token) {
  auto r =
      db_.queryOne("SELECT id,title,kind,frozen_content FROM published_logs "
                   "WHERE share_token=$1 AND visibility='link' AND NOT revoked",
                   {token});
  if (r.isNull())
    throw notFound("share link revoked or missing");
  r["frozen_content"].removeMember("assets");
  r["frozen_content"].removeMember("audio");
  return r;
}
Json::Value PublicationService::revoke(const ChannelAccess &a,
                                       const std::string &id) {
  if (!a.isGm)
    throw forbidden("GM role required");
  auto r =
      db_.queryOne("UPDATE published_logs SET revoked=true,revoked_at=now() "
                   "WHERE id=$1 AND channel_id=$2 RETURNING id,revoked",
                   {id, a.channelId});
  if (r.isNull())
    throw notFound("publication not found");
  logs_.audit(a, "publication.revoke", r);
  return r;
}
std::string PublicationService::sharedFile(const std::string &token,
                                           const std::string &id,
                                           std::string &mime) {
  auto r = db_.queryOne("SELECT * FROM published_logs WHERE share_token=$1 AND "
                        "visibility='link' AND NOT revoked",
                        {token});
  if (r.isNull())
    throw notFound("share link revoked or missing");
  return frozenFile(r, id, mime);
}
std::string
PublicationService::publicationFile(const ChannelAccess &a,
                                    const std::string &publicationId,
                                    const std::string &id, std::string &mime) {
  publication(a, publicationId);
  auto row = db_.queryOne("SELECT * FROM published_logs WHERE id=$1 AND "
                          "channel_id=$2 AND NOT revoked",
                          {publicationId, a.channelId});
  if (row.isNull())
    throw notFound("publication revoked");
  return frozenFile(row, id, mime);
}
std::string PublicationService::frozenFile(const Json::Value &r,
                                           const std::string &id,
                                           std::string &mime) {
  Json::Value file;
  if (id == "pdf" && r["kind"] == "pdf") {
    file = db_.queryOne("SELECT object_key FROM pdf_render_jobs WHERE id=$1 "
                        "AND status='completed'",
                        {r["pdf_job_id"].asString()});
    file["mime"] = "application/pdf";
  } else if (r["frozen_content"]["assets"].isMember(id))
    file = r["frozen_content"]["assets"][id];
  else if (r["frozen_content"]["audio"].isMember(id))
    file = r["frozen_content"]["audio"][id];
  if (file.isNull())
    throw notFound("file is not part of this publication");
  auto bytes = store_.get(file["object_key"].asString());
  if (!bytes)
    throw notFound("file missing");
  mime = file["mime"].asString();
  return *bytes;
}

std::string PublicationService::bundle(const ChannelAccess &a, const std::string &presentationId, std::string &fileName) {
  auto p = pres_.get(a, presentationId);   // viewer-filtered: a GM-only draft never reaches a player
  std::vector<std::pair<std::string, std::string>> files;
  std::map<std::string, std::string> assetPath;   // asset id → relative path inside the bundle
  auto ext = [](const std::string &mime) { return mime == "image/png" ? "png" : mime == "image/jpeg" ? "jpg" : mime == "image/webp" ? "webp" : mime == "image/gif" ? "gif" : mime == "image/svg+xml" ? "svg" : mime == "audio/wav" ? "wav" : mime == "audio/mpeg" ? "mp3" : mime == "audio/ogg" ? "ogg" : "bin"; };
  auto image = [&](const Json::Value &idv, int version) -> std::string {
    if (!idv.isString() || idv.asString().empty()) return "";
    auto id = idv.asString();
    if (assetPath.count(id)) return assetPath[id];
    std::string bytes, mime, name;
    if (!media_.fetch(a, id, version, bytes, mime, name) || mime.rfind("image/", 0) != 0) return "";
    auto path = "assets/" + id.substr(0, 8) + "." + ext(mime);
    files.push_back({path, bytes}); assetPath[id] = path; return path;
  };
  Json::Value data; data["title"] = p["title"]; data["template"] = p["settings"]["template"].isObject() ? p["settings"]["template"] : Json::Value(Json::objectValue);
  data["scenes"] = Json::Value(Json::arrayValue);
  for (const auto &sc : p["scenes"]) { Json::Value x; x["id"] = sc["id"]; x["title"] = sc["title"]; auto bg = image(sc["background_asset_id"], json::toInt(sc, "background_asset_version", 0)); x["background"] = bg.empty() ? Json::Value() : Json::Value(bg); data["scenes"].append(x); }
  std::map<std::string, std::string> names; for (const auto &c : db_.queryJson("SELECT id, name FROM characters WHERE channel_id=$1", {a.channelId})) names[c["id"].asString()] = c["name"].asString();
  data["events"] = Json::Value(Json::arrayValue);
  for (const auto &e : p["events"]) {
    if (e["hidden"].asBool()) continue;
    Json::Value x; x["id"] = e["id"]; x["scene_id"] = e["scene_id"]; x["kind"] = e["display_kind"]; x["text"] = e["display_text"];
    x["speaker"] = e["speaker_name_override"].isString() ? e["speaker_name_override"] : e["character_name"].isString() ? e["character_name"] : e["speaker_display_name"];
    x["stage"] = Json::Value(Json::arrayValue);
    for (const auto &pl : e["character_asset_ids"]) { Json::Value c; auto cid = json::str(pl, "character_id"); c["name"] = names.count(cid) ? names[cid] : ""; c["position"] = pl["position"]; c["active"] = json::toBool(pl, "active") || cid == json::str(e, "speaker_character_id"); auto img = image(pl["asset_id"], json::toInt(pl, "asset_version", 0)); c["image"] = img.empty() ? Json::Value() : Json::Value(img); x["stage"].append(c); }
    if (e["dice"].isObject() && !e["dice"]["total"].isNull()) { x["dice"]["total"] = e["dice"]["total"]; x["dice"]["outcome"] = e["dice"]["outcome"]; }
    if (e["audio_asset_id"].isString()) {
      auto au = db_.queryOne("SELECT object_key, mime FROM tts_audio_assets WHERE id=$1 AND channel_id=$2", {e["audio_asset_id"].asString(), a.channelId});
      if (!au.isNull()) { auto bytes = store_.get(au["object_key"].asString()); if (bytes) { auto path = "audio/" + e["id"].asString().substr(0, 8) + "." + ext(au["mime"].asString()); files.push_back({path, *bytes}); x["audio"] = path; } }
    }
    data["events"].append(x);
  }
  files.insert(files.begin(), {"index.html", renderStandaloneVn(data)});
  files.push_back({"script.json", json::dump(data, true)});
  std::string base; for (unsigned char c : p["title"].asString()) base += (isalnum(c) || c >= 0x80) ? (char)c : '_';
  fileName = (base.empty() ? "visual-novel" : base.substr(0, 40)) + ".zip";
  logs_.audit(a, "presentation.bundle", Json::Value(presentationId));
  return zip::build(files);
}
} // namespace acerciae::logstudio
