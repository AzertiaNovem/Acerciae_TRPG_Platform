#include "VnScriptService.h"
#include "../core/Errors.h"
#include "../core/Crypto.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../core/Text.h"
#include "../llm/LlmGateway.h"
#include "../llm/Replay.h"
#include "../ws/Notifier.h"
#include "LogStudioService.h"
#include "CreativeService.h"
#include "PresentationService.h"
#include "StudioPolicy.h"
#include "../rules/RuleSystem.h"
#include <algorithm>
#include <regex>
#include <ctime>
#include <set>

#include "VnScriptInternals.h"
namespace acerciae::logstudio {
using namespace vnscript;

Json::Value VnScriptService::status(const ChannelAccess &a) {
  Json::Value v;
  v["mock"] = llm_.isMock(a.channelId, "vn_script");
  v["model"] = llm_.modelName(a.channelId, "vn_script");
  auto row = db_.queryOne("SELECT studio_cloud_allowed FROM channels WHERE id=$1", {a.channelId});
  v["cloud_allowed"] = !row.isNull() && row["studio_cloud_allowed"].asBool();
  v["max_lines"] = (Json::UInt64)kMaxLines;
  v["max_tokens"] = llm_.limitsForTask("vn_script").maxTokens;
  v["timeout_ms"] = llm_.limitsForTask("vn_script").timeoutMs;
  v["retry_failed_chunks"] = llm_.retryFailedVnChunks();
  v["images"] = creative_.available(a.channelId);
  v["note"] = v["mock"].asBool() ? "MOCK planner: one scene per chat window and scenario, portraits SAY/IDLE, no language model."
                                 : "The model reads the whole campaign log block by block. Review the draft before publishing.";
  return v;
}
static std::string ownerClause(const ChannelAccess &a, DbParams &p) {
  if (a.isGm) return "";
  p.push_back(a.userId);
  return " AND j.created_by=$" + std::to_string(p.size());
}
Json::Value VnScriptService::list(const ChannelAccess &a) {
  DbParams p{a.channelId};
  auto own = ownerClause(a, p);
  return db_.queryJson("SELECT j.id, j.snapshot_id, j.project_id, j.status, j.provider, j.model, j.progress, j.presentation_id, j.error, j.created_at, j.updated_at, j.created_by, "
                       "j.params->>'title' AS title, j.params->>'continues_presentation_id' AS continues_presentation_id, j.params->'windows' AS windows, s.scope AS snapshot_scope, s.version AS snapshot_version, j.script->'stats' AS stats, j.script->'generation' AS generation "
                       "FROM vn_script_jobs j JOIN log_snapshots s ON s.id=j.snapshot_id WHERE j.channel_id=$1" + own + " ORDER BY j.created_at DESC LIMIT 50",
                       p);
}
Json::Value VnScriptService::get(const ChannelAccess &a, const std::string &id) {
  DbParams p{id, a.channelId};
  auto own = ownerClause(a, p);
  auto j = db_.queryOne("SELECT j.* FROM vn_script_jobs j WHERE j.id=$1 AND j.channel_id=$2" + own, p);
  if (j.isNull()) throw notFound("script job not found");
  // The parts whose editor asked something: their questions, and whether the user answered yet.
  j["questions"] = Json::Value(Json::arrayValue);
  for (const auto &c : db_.queryJson("SELECT part_index, questions, answers FROM vn_script_chunks WHERE job_id=$1 AND questions IS NOT NULL ORDER BY part_index", {id})) {
    Json::Value q; q["part_index"] = c["part_index"]; q["first_line"] = c["questions"]["first_line"]; q["last_line"] = c["questions"]["last_line"];
    q["items"] = c["questions"]["items"]; q["answered"] = c["answers"].isObject(); q["answers"] = c["answers"].isObject() ? c["answers"] : Json::Value(Json::objectValue);
    j["questions"].append(q);
  }
  j["background_jobs"] = Json::Value(Json::arrayValue);
  if (j["presentation_id"].isString()) {
    j["background_jobs"] = db_.queryJson(
        "SELECT s.id AS scene_id,s.canonical_scene_key AS scene_key,g.id AS job_id,"
        "CASE WHEN s.background_asset_id IS NOT NULL THEN 'completed' WHEN g.status='completed' OR g.status IS NULL THEN 'missing' ELSE g.status END AS status,"
        "CASE WHEN s.background_asset_id IS NULL THEN g.error END AS error "
        "FROM presentation_scenes s LEFT JOIN LATERAL (SELECT id,status,error FROM asset_generation_jobs "
        "WHERE channel_id=$2 AND kind='background' AND params->'attach'->>'presentation_id'=s.presentation_id::text AND params->'attach'->>'scene_key'=s.canonical_scene_key "
        "ORDER BY (status IN ('pending','running')) DESC,updated_at DESC,created_at DESC LIMIT 1) g ON true WHERE s.presentation_id=$1 ORDER BY s.position",
        {j["presentation_id"].asString(), a.channelId});
  }
  return j;
}
Json::Value VnScriptService::create(const ChannelAccess &a, const Json::Value &b) {
  if (b.isMember("media_mode") && (!b["media_mode"].isString() || (b["media_mode"] != "server" && b["media_mode"] != "hybrid"))) throw badRequest("media_mode must be server or hybrid");
  if (b.isMember("retry_failed_chunks") && !b["retry_failed_chunks"].isBool()) throw badRequest("retry_failed_chunks must be a boolean");
  Json::Value snap;
  std::string snapshotId = json::str(b, "snapshot_id");
  const std::string cont = json::str(b, "continue_presentation_id");
  Json::Value continued;
  if (!cont.empty()) {
    // Continue a visual novel: the campaign log frozen again in the presentation's own scope.
    continued = pres_.presentationRow(a, cont);
    if (b.isMember("media_mode") && json::str(b, "media_mode") != json::str(continued["settings"], "media_mode", "server")) throw badRequest("a continuation keeps its original media mode");
    if (!pres_.canEditPresentation(a, continued)) throw forbidden("only the draft author or GM can continue this visual novel");
    auto old = db_.queryOne("SELECT project_id, scope, scope_character_id, selection FROM log_snapshots WHERE id=$1", {continued["snapshot_id"].asString()});
    auto projectId = logs_.campaignProjectId(a.channelId);
    if (old.isNull() || old["project_id"].asString() != projectId) throw badRequest("only a visual novel made from the campaign log can be continued");
    if (!db_.queryOne("SELECT id FROM vn_script_jobs WHERE channel_id=$1 AND params->>'continues_presentation_id'=$2 AND status IN ('pending','running','waiting')", {a.channelId, cont}).isNull())
      throw conflict("this visual novel is already being continued");
    logs_.syncCampaign(a.channelId, projectId);
    Json::Value sb;
    sb["scope"] = old["scope"];
    if (old["scope_character_id"].isString()) sb["scope_character_id"] = old["scope_character_id"];
    sb["title"] = clip(continued["title"].asString(), 200);
    sb["selection"]["mode"] = "campaign";
    // The continuation tells the same chat windows (those still there).
    if (old["selection"]["windows"].isArray()) {
      auto kept = db_.queryJson("SELECT id FROM chat_windows WHERE channel_id=$1 AND id = ANY(" + Visibility::uuidArray(json::strArray(old["selection"]["windows"])) + ")", {a.channelId});
      if (kept.empty()) throw badRequest("the chat windows this visual novel tells no longer exist");
      sb["selection"]["windows"] = Json::Value(Json::arrayValue);
      for (const auto& w : kept) sb["selection"]["windows"].append(w["id"]);
    }
    snapshotId = logs_.createSnapshot(a, projectId, sb)["id"].asString();
  } else if (snapshotId.empty()) {
    // Freeze the campaign log now: the script always reads the latest lines in the requester's scope.
    auto projectId = logs_.campaignProjectId(a.channelId);
    logs_.syncCampaign(a.channelId, projectId);
    Json::Value sb;
    sb["scope"] = json::str(b, "scope", a.isGm ? "gm_full" : "pl_public");
    if (b["scope_character_id"].isString()) sb["scope_character_id"] = b["scope_character_id"];
    sb["title"] = clip(json::str(b, "title", "Visual novel"), 200);
    sb["selection"]["mode"] = "campaign";
    // The chat windows to tell; without the list, every window the point of view can read.
    if (b.isMember("windows")) sb["selection"]["windows"] = b["windows"];
    snapshotId = logs_.createSnapshot(a, projectId, sb)["id"].asString();
  } else if (b.isMember("windows")) {
    throw badRequest("windows choose the lines of a new snapshot; an existing snapshot already holds its lines");
  }
  auto events = logs_.snapshotEvents(a, snapshotId, &snap);
  if (!cont.empty()) {
    events.erase(events.begin(), events.begin() + (std::ptrdiff_t)continuationStart(events, presentedEvents(cont)));
    if (events.empty()) throw badRequest("there are no new lines after the end of this visual novel yet");
  }
  const bool someWindows = snap["selection"]["windows"].isArray();
  if (events.empty()) throw badRequest(someWindows ? "the chosen chat windows have no lines in this point of view yet"
                                       : json::str(b, "scope") == "pl_public" ? "no line of the log is public to every player yet; choose a character's point of view" : "the log has no lines in your scope yet");
  if (events.size() > kMaxLines) throw badRequest("the log has more than " + std::to_string(kMaxLines) + " lines; snapshot a range or a set of scenes");
  bool mock = llm_.isMock(a.channelId, "vn_script");
  if (!mock) {
    if (!json::toBool(b, "allow_cloud")) throw badRequest("confirm that the log's lines may be sent to the configured model");
    requireCloudPermission(db_, a.channelId);
  }
  Json::Value params;
  params["title"] = clip(json::str(b, "title", json::str(snap, "title", "Visual novel")), 200);
  params["instructions"] = clip(json::str(b, "instructions"), 1000);
  params["template"] = b.isMember("template") && !b["template"].isNull() ? PresentationService::validateVnTemplate(b["template"]) : PresentationService::validateVnTemplate(Json::Value(Json::objectValue));
  if (!cont.empty()) {
    params["title"] = continued["title"];
    params["continues_presentation_id"] = cont;
    params["new_lines"] = (Json::UInt64)events.size();
    params.removeMember("template");   // the presentation keeps its own look
  }
  if (someWindows) params["windows"] = snap["selection"]["windows"];   // shown with the job
  params["cloud_authorized"] = !mock || json::toBool(b, "allow_cloud");
  params["media_mode"] = cont.empty() ? json::str(b, "media_mode", "server") : json::str(continued["settings"], "media_mode", "server");
  params["generate_art"] = params["media_mode"] != "hybrid" && json::toBool(b, "generate_art", true);
  params["retry_failed_chunks"] = json::toBool(b, "retry_failed_chunks", llm_.retryFailedVnChunks());
  auto j = db_.queryOne("INSERT INTO vn_script_jobs(channel_id, project_id, snapshot_id, provider, model, params, created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id, status, provider, snapshot_id, created_at, params",
                        {a.channelId, snap["project_id"].asString(), snapshotId, mock ? "mock" : llm_.mode(a.channelId, "vn_script"), llm_.modelName(a.channelId, "vn_script"), json::dump(params), a.userId});
  logs_.audit(a, "vnscript.request", j);
  cv_.notify_all();
  return j;
}
Json::Value VnScriptService::cancel(const ChannelAccess &a, const std::string &id) {
  DbParams p{id, a.channelId};
  auto own = ownerClause(a, p);
  auto r = db_.queryOne("UPDATE vn_script_jobs j SET status='cancelled', updated_at=now() WHERE j.id=$1 AND j.channel_id=$2 AND j.status IN ('pending','running','waiting')" + own + " RETURNING id, status", p);
  if (r.isNull()) throw badRequest("job is not running");
  return r;
}

Json::Value VnScriptService::retry(const ChannelAccess &a, const std::string &id, const Json::Value &body) {
  auto job = get(a, id); // owner or GM; never reveal another player's jobs
  if (job["status"] != "failed") throw badRequest("only failed script jobs can be retried");
  logs_.snapshotEvents(a, job["snapshot_id"].asString());
  if (job["provider"] != "mock") requireCloudPermission(db_, a.channelId);
  if (body.isMember("retry_failed_chunks") && !body["retry_failed_chunks"].isBool()) throw badRequest("retry_failed_chunks must be a boolean");
  auto params = job["params"];
  params["retry_failed_chunks"] = json::toBool(body, "retry_failed_chunks", json::toBool(params, "retry_failed_chunks", llm_.retryFailedVnChunks()));
  auto result = db_.queryOne("UPDATE vn_script_jobs SET status='pending',attempts=0,error=NULL,params=$2::jsonb,updated_at=now() WHERE id=$1 AND status='failed' RETURNING id,status,snapshot_id", {id, json::dump(params)});
  if (result.isNull()) throw badRequest("job is no longer failed");
  logs_.audit(a, "vnscript.retry", result);
  cv_.notify_all();
  return result;
}

// The user's answers to a part's questions ({part_index, answers:{q1:"..."}} or {part_index, skip:true}). When every
// waiting part has its answers the job is queued again: completed parts are reused, the answered ones resumed.
Json::Value VnScriptService::answer(const ChannelAccess &a, const std::string &id, const Json::Value &body) {
  auto job = get(a, id);
  if (job["status"] != "waiting") throw badRequest("this script job is not waiting for answers");
  if (!body.isObject() || !body["part_index"].isIntegral()) throw badRequest("part_index is required");
  const int part = body["part_index"].asInt();
  auto row = db_.queryOne("SELECT questions, answers FROM vn_script_chunks WHERE job_id=$1 AND part_index=$2", {id, (int64_t)part});
  if (row.isNull() || !row["questions"].isObject()) throw notFound("this part asked no question");
  if (row["answers"].isObject()) throw badRequest("this part's questions are already answered");
  Json::Value answers(Json::objectValue);
  if (json::toBool(body, "skip")) answers["skip"] = true;
  else {
    if (!body["answers"].isObject()) throw badRequest("answers must be an object of question id to answer, or skip must be true");
    int given = 0;
    for (const auto &q : row["questions"]["items"]) {
      auto qid = json::str(q, "id");
      if (body["answers"][qid].isString() && !text::trim(body["answers"][qid].asString()).empty()) { answers[qid] = clip(text::trim(body["answers"][qid].asString()), 2000); ++given; }
    }
    if (!given) throw badRequest("answer at least one question, or skip the part");
  }
  db_.exec("UPDATE vn_script_chunks SET answers=$3::jsonb WHERE job_id=$1 AND part_index=$2", {id, (int64_t)part, json::dump(answers)});
  auto open = db_.queryOne("SELECT count(*) AS n FROM vn_script_chunks WHERE job_id=$1 AND questions IS NOT NULL AND answers IS NULL", {id})["n"].asInt64();
  if (open == 0) {
    db_.exec("UPDATE vn_script_jobs SET status='pending', attempts=0, error=NULL, params=params || '{\"resuming\":true}'::jsonb, updated_at=now() WHERE id=$1 AND status='waiting'", {id});
    cv_.notify_all();
  }
  Json::Value audit; audit["job_id"] = id; audit["part_index"] = part; audit["skip"] = json::toBool(body, "skip");
  logs_.audit(a, "vnscript.answer", audit);
  return get(a, id);
}

// Resume only missing backgrounds in this draft. The script and successful images stay intact.
void VnScriptService::start() {
  if (running_.exchange(true)) return;
  thread_ = std::thread([this] { loop(); });
}
void VnScriptService::stop() {
  if (!running_.exchange(false)) return;
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}
bool VnScriptService::processNext() {
  auto staleSeconds = std::max<int64_t>(600, (int64_t)llm_.limitsForTask("vn_script").timeoutMs * 4 / 1000 + 120);
  db_.exec("UPDATE vn_script_jobs SET status=CASE WHEN attempts<max_attempts THEN 'pending' ELSE 'failed' END, error='worker interrupted' WHERE status='running' AND updated_at<now()-make_interval(secs => $1::double precision)", {staleSeconds});
  auto j = db_.queryOne("UPDATE vn_script_jobs SET status='running', attempts=attempts+1, updated_at=now() WHERE id=(SELECT id FROM vn_script_jobs WHERE status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *");
  if (j.isNull()) return false;
  run(j);
  return true;
}
void VnScriptService::loop() {
  while (running_) {
    try {
      if (processNext()) continue;
    } catch (const std::exception &e) {
      ALOG_ERROR << "vn script worker: " << e.what();
    }
    std::unique_lock<std::mutex> lock(mu_);
    cv_.wait_for(lock, std::chrono::seconds(2));
  }
}
void VnScriptService::progress(const std::string &channelId, const std::string &jobId, const Json::Value &p, const std::string &status) {
  Json::Value v;
  v["job_id"] = jobId;
  v["status"] = status;
  v["progress"] = p;
  notifier_.studioEvent(channelId, "studio.vnscript.progress", v, false);
}
void VnScriptService::run(const Json::Value &j) {
  auto id = j["id"].asString(), channel = j["channel_id"].asString();
  try {
    // Re-check at run time: the requester must still be a member, and the cloud policy may have changed.
    // snapshotEvents() enforces the snapshot's scope against the requester's current access.
    auto a = auth_.channelAccess(j["created_by"].asString(), channel);
    Json::Value snap;
    const auto cont = json::str(j["params"], "continues_presentation_id");
    auto in = inputs(a, j["snapshot_id"].asString(), &snap, cont);
    if (j["params"]["media_mode"] == "hybrid" && a.isGm) {
      // Atmosphere previews are still candidates, not automatically approved for publication. A GM may
      // reuse their existing landscape art locally without changing its approval or uploading a copy.
      for (const auto& r : db_.queryJson("SELECT m.id, h.scene_label, v.variant FROM channel_atmospheres h JOIN channel_atmosphere_variants v ON v.atmosphere_id=h.id "
          "JOIN asset_generation_jobs g ON g.id=v.job_id JOIN media_assets m ON m.id=g.result_asset_id WHERE h.channel_id=$1 AND m.channel_id=$1 "
          "AND g.status='completed' AND m.visibility_scope='channel' AND m.approval_status<>'rejected' AND v.variant IN ('day_landscape','night_landscape') ORDER BY h.created_at DESC LIMIT 100", {channel})) {
        bool exists = false; for (const auto& x : in.assets) if (x["id"] == r["id"]) exists = true;
        if (exists) continue;
        Json::Value asset; asset["id"] = r["id"]; asset["type"] = "background";
        asset["ref"] = "B_atmosphere_" + std::to_string(in.assets.size());
        asset["name"] = json::str(r, "scene_label") + " · " + json::str(r, "variant");
        asset["tags"] = Json::Value(Json::arrayValue); in.assets.append(asset);
      }
    }
    Json::Value script;
    if (j["provider"].asString() == "mock") {
      std::vector<Json::Value> flats;
      for (const auto &blk : blocks(in.events)) flats.push_back(mockFlat(in, blk.first, blk.second));
      script = normalize(in, {fromFlat(in, flats)}, "mock");
      script["blocks"] = (int)flats.size();
    } else {
      requireCloudPermission(db_, channel);
      script = planWithModel(a, in, j);
      if (script.isNull()) return;   // waiting for the user's answers
    }
    script["snapshot_id"] = j["snapshot_id"];
    script["snapshot_scope"] = snap["scope"];
    if (db_.queryOne("SELECT status FROM vn_script_jobs WHERE id=$1", {id})["status"] != "running") return;
    if (!cont.empty()) {
      // Continue the existing presentation: the new scenes go after its own, which stay as they are.
      script["continues_presentation_id"] = cont;
      script = fitContinuation(script, db_.queryJson("SELECT title, canonical_scene_key, COALESCE(background_asset_id, (metadata->>'hybrid_background_asset_id')::uuid) AS background_asset_id FROM presentation_scenes WHERE presentation_id=$1 ORDER BY position", {cont}));
      pres_.appendScript(a, cont, j["snapshot_id"].asString(), script);
      if (json::toBool(j["params"], "generate_art", true)) script["generation"] = queueArt(a, script, cont, json::toBool(j["params"], "cloud_authorized"));
      // The lines are in the presentation now, so the job completes even if it was cancelled meanwhile.
      db_.exec("UPDATE vn_script_jobs SET status='completed', script=$2::jsonb, presentation_id=$3, error=NULL, updated_at=now() WHERE id=$1", {id, json::dump(script), cont});
      logs_.audit(a, "vnscript.continued", Json::Value(id));
      progress(channel, id, j["progress"], "completed");
      return;
    }
    // Build the draft presentation with the chosen template, then lay the script over it.
    Json::Value body;
    body["title"] = j["params"]["title"];
    body["settings"]["template"] = j["params"]["template"];
    body["settings"]["media_mode"] = json::str(j["params"], "media_mode", "server");
    body["settings"]["generated"]["job_id"] = id;
    body["settings"]["generated"]["provider"] = script["provider"];
    body["settings"]["generated"]["model"] = j["model"];
    auto p = pres_.create(a, j["snapshot_id"].asString(), body);
    auto pid = p["id"].asString();
    try {
      pres_.applyScript(a, pid, script);
      if (json::toBool(j["params"], "generate_art", true)) script["generation"] = queueArt(a, script, pid, json::toBool(j["params"], "cloud_authorized"));
    } catch (...) {
      db_.exec("DELETE FROM log_presentations WHERE id=$1", {pid});   // no half-built drafts
      throw;
    }
    auto done = db_.queryOne("UPDATE vn_script_jobs SET status='completed', script=$2::jsonb, presentation_id=$3, error=NULL, updated_at=now() WHERE id=$1 AND status='running' RETURNING id",
                             {id, json::dump(script), pid});
    if (done.isNull()) { db_.exec("DELETE FROM log_presentations WHERE id=$1", {pid}); return; }   // cancelled meanwhile
    logs_.audit(a, "vnscript.completed", Json::Value(id));
    progress(channel, id, j["progress"], "completed");
  } catch (const ApiError &e) {
    if (e.code() == "cancelled") return;
    bool retry = e.status() >= 500 && j["attempts"].asInt() < j["max_attempts"].asInt();
    db_.exec("UPDATE vn_script_jobs SET status=$2, error=$3, updated_at=now() WHERE id=$1 AND status='running'", {id, retry ? "pending" : "failed", std::string(e.what())});
    progress(channel, id, db_.queryOne("SELECT progress FROM vn_script_jobs WHERE id=$1", {id})["progress"], retry ? "pending" : "failed");
  } catch (const std::exception &e) {
    db_.exec("UPDATE vn_script_jobs SET status='failed', error=$2, updated_at=now() WHERE id=$1 AND status='running'", {id, std::string(e.what())});
    progress(channel, id, db_.queryOne("SELECT progress FROM vn_script_jobs WHERE id=$1", {id})["progress"], "failed");
  }
}

} // namespace acerciae::logstudio
