#include "LogStudioService.h"
#include "../ws/Notifier.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../core/Crypto.h"
#include "../knowledge/Visibility.h"
#include <map>
#include <set>
#include <algorithm>

namespace acerciae::logstudio {

static DbParam opt(const std::string& s) { return s.empty() ? dbNull() : DbParam(s); }

static std::string htmlEscape(const std::string& s) {
    std::string o; o.reserve(s.size());
    for (char c : s) { switch (c) { case '&': o += "&amp;"; break; case '<': o += "&lt;"; break; case '>': o += "&gt;"; break; case '"': o += "&quot;"; break; default: o += c; } }
    return o;
}

void LogStudioService::audit(const ChannelAccess& a, const std::string& action, const Json::Value& target) {
    db_.exec("INSERT INTO studio_audit_log(channel_id, user_id, action, target) VALUES($1,$2,$3,$4::jsonb)", {a.channelId, a.userId, action, json::dump(target)});
}

bool LogStudioService::eventVisibleTo(const ChannelAccess& a, const std::string& vis, const std::vector<std::string>& audience) {
    if (a.isGm) return true;
    if (vis == "public") return true;
    if (vis == "gm") return false;
    for (auto& c : a.characterIds) if (std::find(audience.begin(), audience.end(), c) != audience.end()) return true;
    return false;
}

Json::Value LogStudioService::projectRow(const ChannelAccess& a, const std::string& projectId) {
    auto p = db_.queryOne("SELECT * FROM log_projects WHERE id=$1 AND channel_id=$2", {projectId, a.channelId});
    if (p.isNull()) throw notFound("log project not found");
    return p;
}

// ---- projects --------------------------------------------------------------------------------------
Json::Value LogStudioService::listProjects(const ChannelAccess& a) {
    return db_.queryJson(
        "SELECT p.*, (SELECT count(*) FROM log_events e WHERE e.project_id=p.id) AS event_count, (SELECT count(*) FROM log_snapshots s WHERE s.project_id=p.id) AS snapshot_count, "
        "(SELECT count(*) FROM log_presentations pr WHERE pr.project_id=p.id) AS presentation_count, (SELECT count(*) FROM published_logs pl WHERE pl.project_id=p.id AND NOT pl.revoked) AS published_count "
        "FROM log_projects p WHERE p.channel_id=$1 ORDER BY p.created_at DESC", {a.channelId});
}
Json::Value LogStudioService::createProject(const ChannelAccess& a, const Json::Value& body) {
    auto title = json::requireStr(body, "title");
    auto kind = json::str(body, "source_kind", "channel");
    if (kind != "channel" && kind != "import" && kind != "mixed") throw badRequest("invalid source_kind");
    auto p = db_.queryOne("INSERT INTO log_projects(channel_id, title, description, source_kind, created_by) VALUES($1,$2,$3,$4,$5) RETURNING *", {a.channelId, title, json::str(body, "description"), kind, a.userId});
    audit(a, "project.create", p);
    return p;
}
Json::Value LogStudioService::getProject(const ChannelAccess& a, const std::string& projectId) {
    auto p = projectRow(a, projectId);
    p["event_count"] = db_.queryOne("SELECT count(*) AS n FROM log_events WHERE project_id=$1", {projectId})["n"];
    p["snapshots"] = listSnapshots(a, projectId);
    p["imports"] = a.isGm ? listImports(a, projectId) : Json::Value(Json::arrayValue);
    p["speakers"] = db_.queryJson("SELECT speaker_key, max(speaker_display_name) AS display_name, max(speaker_role) AS role, max(speaker_character_id::text) AS character_id, count(*) AS n FROM log_events WHERE project_id=$1 GROUP BY speaker_key ORDER BY n DESC", {projectId});
    p["scenes"] = sceneSummary(a, projectId);
    return p;
}
Json::Value LogStudioService::updateProject(const ChannelAccess& a, const std::string& projectId, const Json::Value& body) {
    if (!a.isGm) throw forbidden("GM role required");
    auto cur = projectRow(a, projectId);
    Json::Value cmap = body.isMember("character_map") && body["character_map"].isObject() ? body["character_map"] : cur["character_map"];
    auto p = db_.queryOne("UPDATE log_projects SET title=$2, description=$3, character_map=$4::jsonb, version=version+1, updated_at=now() WHERE id=$1 RETURNING *",
        {projectId, json::str(body, "title", cur["title"].asString()), json::str(body, "description", cur["description"].asString()), json::dump(cmap)});
    // Apply speaker mapping to canonical events (identity only; never content).
    if (body.isMember("character_map")) {
        db_.tx([&](pqxx::work& w) {
            for (auto it = cmap.begin(); it != cmap.end(); ++it) {
                auto key = it.name(); auto& m = *it;
                Db::exec(w, "UPDATE log_events SET speaker_character_id=$3, speaker_display_name=coalesce(nullif($4,''), speaker_display_name), speaker_role=coalesce(nullif($5,''), speaker_role) WHERE project_id=$1 AND speaker_key=$2",
                    {projectId, key, opt(json::str(m, "character_id")), json::str(m, "display_name"), json::str(m, "role")});
            }
        });
    }
    Json::Value n; n["project_id"] = projectId; n["kind"] = "project.updated"; notifier_.moduleUpdated(a.channelId, n);
    return p;
}
Json::Value LogStudioService::deleteProject(const ChannelAccess& a, const std::string& projectId) {
    if (!a.isGm) throw forbidden("GM role required");
    projectRow(a, projectId);
    db_.exec("DELETE FROM log_projects WHERE id=$1", {projectId});
    audit(a, "project.delete", Json::Value(projectId));
    Json::Value v; v["deleted"] = true; return v;
}

// ---- events ----------------------------------------------------------------------------------------
static const std::string EVENT_COLS = "id AS event_id, sequence_number, event_type, content, speaker_key, speaker_display_name, speaker_character_id, speaker_role, extract(epoch from occurred_at)::bigint AS timestamp, time_text, scene_key, scene_title, scene_id, chat_window_id, visibility_scope, audience, source_kind, source_event_id, source_message_id, source_reference, dice, media, metadata, raw_text, unrecognised";

std::vector<LogEvent> LogStudioService::loadEvents(pqxx::work& w, const std::string& projectId, const std::vector<std::string>& ids) {
    std::vector<LogEvent> out;
    Json::Value rows = ids.empty()
        ? Db::queryJson(w, "SELECT " + EVENT_COLS + " FROM log_events WHERE project_id=$1 ORDER BY sequence_number", {projectId})
        : Db::queryJson(w, "SELECT " + EVENT_COLS + " FROM log_events WHERE project_id=$1 AND id = ANY(" + Visibility::uuidArray(ids) + ") ORDER BY sequence_number", {projectId});
    for (auto& r : rows) out.push_back(LogEvent::fromJson(r));
    return out;
}

Json::Value LogStudioService::listEvents(const ChannelAccess& a, const std::string& projectId, int limit, long long afterSeq, const std::string& sceneKey) {
    projectRow(a, projectId);
    std::string sql = "SELECT " + EVENT_COLS + " FROM log_events WHERE project_id=$1 AND sequence_number > $2";
    DbParams p{projectId, afterSeq};
    if (!a.isGm) sql += " AND (visibility_scope='public' OR (visibility_scope='character' AND audience && " + Visibility::uuidArray(a.characterIds) + "))";
    if (!sceneKey.empty()) { p.push_back(sceneKey); sql += " AND scene_key=$3"; }
    sql += " ORDER BY sequence_number LIMIT " + std::to_string(std::max(1, std::min(limit, 2000)));
    return db_.queryJson(sql, p);
}
Json::Value LogStudioService::updateEvent(const ChannelAccess& a, const std::string& projectId, const std::string& eventId, const Json::Value& body) {
    if (!a.isGm) throw forbidden("GM role required");
    projectRow(a, projectId);
    auto cur = db_.queryOne("SELECT * FROM log_events WHERE id=$1 AND project_id=$2", {eventId, projectId});
    if (cur.isNull()) throw notFound("event not found");
    static const std::set<std::string> types = {"dialogue","action","narration","dice_roll","system","ooc","scene_change","media","secret"};
    auto type = json::str(body, "event_type", cur["event_type"].asString());
    if (!types.count(type)) throw badRequest("invalid event_type");
    static const std::set<std::string> roles = {"gm","pc","npc","dice","system","hidden"};
    auto role = json::str(body, "speaker_role", cur["speaker_role"].asString());
    if (!roles.count(role)) throw badRequest("invalid speaker_role");
    auto vis = json::str(body, "visibility_scope", cur["visibility_scope"].asString());
    if (vis != "public" && vis != "gm" && vis != "character") throw badRequest("invalid visibility_scope");
    // Content is immutable here by design: only classification, identity and grouping may change.
    return db_.queryOne("UPDATE log_events SET event_type=$3, speaker_role=$4, speaker_character_id=$5, speaker_display_name=$6, scene_key=$7, scene_title=$8, visibility_scope=$9 WHERE id=$1 AND project_id=$2 RETURNING " + EVENT_COLS,
        {eventId, projectId, type, role, opt(json::str(body, "speaker_character_id", cur["speaker_character_id"].isNull() ? "" : cur["speaker_character_id"].asString())),
         json::str(body, "speaker_display_name", cur["speaker_display_name"].asString()), json::str(body, "scene_key", cur["scene_key"].asString()), json::str(body, "scene_title", cur["scene_title"].asString()), vis});
}
Json::Value LogStudioService::sceneSummary(const ChannelAccess& a, const std::string& projectId) {
    projectRow(a, projectId);
    return db_.queryJson("SELECT scene_key, max(scene_title) AS scene_title, max(scene_id::text) AS scene_id, min(sequence_number) AS from_seq, max(sequence_number) AS to_seq, count(*) AS n FROM log_events WHERE project_id=$1 GROUP BY scene_key ORDER BY min(sequence_number)", {projectId});
}

Json::Value LogStudioService::splitScene(const ChannelAccess& a, const std::string& projectId, long long fromSeq, const std::string& title) {
    if (!a.isGm) throw forbidden("GM role required");
    projectRow(a, projectId);
    auto at = db_.queryOne("SELECT scene_key FROM log_events WHERE project_id=$1 AND sequence_number=$2", {projectId, fromSeq});
    if (at.isNull()) throw notFound("no event at that sequence number");
    auto oldKey = at["scene_key"].asString();
    auto newKey = "scene:" + crypto::uuid4().substr(0, 8);
    // Events of the old scene from this point until the next scene boundary move into the new scene.
    auto next = db_.queryOne("SELECT min(sequence_number) AS s FROM log_events WHERE project_id=$1 AND sequence_number > $2 AND scene_key <> $3", {projectId, fromSeq, oldKey});
    long long upto = next.isNull() || next["s"].isNull() ? (1LL << 40) : next["s"].asInt64() - 1;
    db_.exec("UPDATE log_events SET scene_key=$4, scene_title=$5 WHERE project_id=$1 AND sequence_number >= $2 AND sequence_number <= $3 AND scene_key=$6", {projectId, fromSeq, upto, newKey, title, oldKey});
    Json::Value out; out["scene_key"] = newKey; out["from_seq"] = (Json::Int64)fromSeq; out["to_seq"] = (Json::Int64)upto; out["title"] = title; return out;
}
Json::Value LogStudioService::mergeScene(const ChannelAccess& a, const std::string& projectId, const std::string& sceneKey, const std::string& intoKey) {
    if (!a.isGm) throw forbidden("GM role required");
    projectRow(a, projectId);
    auto into = db_.queryOne("SELECT max(scene_title) AS t FROM log_events WHERE project_id=$1 AND scene_key=$2", {projectId, intoKey});
    db_.exec("UPDATE log_events SET scene_key=$3, scene_title=$4 WHERE project_id=$1 AND scene_key=$2", {projectId, sceneKey, intoKey, into.isNull() || into["t"].isNull() ? "" : into["t"].asString()});
    Json::Value out; out["merged_into"] = intoKey; return out;
}
Json::Value LogStudioService::renameScene(const ChannelAccess& a, const std::string& projectId, const std::string& sceneKey, const std::string& title) {
    if (!a.isGm) throw forbidden("GM role required");
    projectRow(a, projectId);
    db_.exec("UPDATE log_events SET scene_title=$3 WHERE project_id=$1 AND scene_key=$2", {projectId, sceneKey, title});
    Json::Value out; out["scene_key"] = sceneKey; out["title"] = title; return out;
}
// Scene split suggestions: the AI-maintained channel scenes give boundaries for channel-sourced events; for
// imports, long time gaps (> 45 min) and scene_change-like lines are proposed. Nothing is applied automatically.
Json::Value LogStudioService::suggestScenes(const ChannelAccess& a, const std::string& projectId) {
    projectRow(a, projectId);
    Json::Value out(Json::arrayValue);
    auto rows = db_.queryJson("SELECT sequence_number, scene_key, scene_id, extract(epoch from occurred_at)::bigint AS ts, content, event_type FROM log_events WHERE project_id=$1 ORDER BY sequence_number", {projectId});
    long long prevTs = 0; std::string prevSceneId;
    for (auto& r : rows) {
        long long ts = r["ts"].isNull() ? 0 : r["ts"].asInt64();
        std::string sid = r["scene_id"].isNull() ? "" : r["scene_id"].asString();
        Json::Value s; s["from_seq"] = r["sequence_number"];
        if (!sid.empty() && sid != prevSceneId && !prevSceneId.empty()) { auto sc = db_.queryOne("SELECT title, location FROM scenes WHERE id=$1", {sid}); s["reason"] = "AI scene memory boundary"; s["title"] = sc.isNull() ? "" : sc["title"]; s["location"] = sc.isNull() ? "" : sc["location"]; out.append(s); }
        else if (prevTs && ts && ts - prevTs > 45 * 60) { s["reason"] = "time gap of " + std::to_string((ts - prevTs) / 60) + " minutes"; s["title"] = ""; out.append(s); }
        else if (r["event_type"] == "scene_change") { s["reason"] = "scene change line"; s["title"] = r["content"]; out.append(s); }
        if (ts) prevTs = ts; if (!sid.empty()) prevSceneId = sid;
    }
    return out;
}

void LogStudioService::insertEvents(pqxx::work& w, const std::string& projectId, const std::string& channelId, std::vector<LogEvent>& events, const std::string& importId) {
    auto base = Db::queryOne(w, "SELECT coalesce(max(sequence_number),0) AS m FROM log_events WHERE project_id=$1", {projectId})["m"].asInt64();
    long long seq = base;
    for (auto& e : events) {
        e.sequenceNumber = ++seq;
        auto row = Db::queryOne(w,
            "INSERT INTO log_events(project_id, channel_id, sequence_number, event_type, content, speaker_key, speaker_display_name, speaker_character_id, speaker_role, occurred_at, time_text, scene_key, scene_title, scene_id, chat_window_id, visibility_scope, audience, source_kind, source_event_id, source_message_id, import_id, source_reference, dice, media, metadata, raw_text, unrecognised) "
            "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10::bigint IS NULL THEN NULL ELSE to_timestamp($10::bigint) END, $11,$12,$13,$14,$15,$16,$17::uuid[],$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24::jsonb,$25::jsonb,$26,$27) RETURNING id",
            {projectId, channelId, e.sequenceNumber, e.eventType, e.content, e.speakerKey, e.speakerDisplayName, opt(e.speakerCharacterId), e.speakerRole,
             e.occurredAtUnix ? DbParam((int64_t)*e.occurredAtUnix) : dbNull(), opt(e.timeText), e.sceneKey, e.sceneTitle, opt(e.sceneId), opt(e.chatWindowId), e.visibilityScope, pgArrayLiteral(e.audience),
             e.sourceKind, opt(e.sourceEventId), opt(e.sourceMessageId), opt(importId), json::dump(e.sourceReference), e.dice ? DbParam(json::dump(e.dice->toJson())) : dbNull(), e.media.isNull() ? dbNull() : DbParam(json::dump(e.media)), json::dump(e.metadata), opt(e.rawText), e.unrecognised});
        e.eventId = row["id"].asString();
    }
}

// Pull the real campaign record into canonical events. Scope: GM pulls everything (visibility kept per event),
// so a later snapshot can be filtered for any audience; players may only build from what they can see.
Json::Value LogStudioService::syncFromChannel(const ChannelAccess& a, const std::string& projectId, const Json::Value& sel) {
    auto proj = projectRow(a, projectId);
    std::string sql = "SELECT e.id, e.seq, e.kind, e.payload, e.visibility, e.audience, e.actor_role, e.character_id, e.message_id, e.chat_window_id, e.scene_id, e.created_at, extract(epoch from e.created_at)::bigint AS ts, "
                      "c.name AS character_name, u.display_name AS actor_name, s.title AS scene_title, m.kind AS message_kind FROM events e LEFT JOIN characters c ON c.id=e.character_id LEFT JOIN users u ON u.id=e.actor_user_id LEFT JOIN scenes s ON s.id=e.scene_id LEFT JOIN messages m ON m.id=e.message_id "
                      "WHERE e.channel_id=$1 AND e.kind IN ('message.posted','scene.entered','scene.created') AND " + Visibility::eventFilter(a) +
                      " AND NOT EXISTS (SELECT 1 FROM log_events le WHERE le.project_id=$2 AND le.source_event_id=e.id)";
    DbParams p{a.channelId, projectId};
    auto mode = json::str(sel, "mode", "campaign");
    if (mode == "scenes") { auto ids = json::strArray(sel["scene_ids"]); if (ids.empty()) throw badRequest("scene_ids required"); sql += " AND e.scene_id = ANY(" + Visibility::uuidArray(ids) + ")"; }
    else if (mode == "range") { p.push_back((int64_t)json::toInt(sel, "from_seq", 0)); sql += " AND e.seq >= $" + std::to_string(p.size()); p.push_back((int64_t)json::toInt(sel, "to_seq", 1 << 30)); sql += " AND e.seq <= $" + std::to_string(p.size()); }
    else if (mode == "session") { auto from = json::str(sel, "from"), to = json::str(sel, "to"); if (!from.empty()) { p.push_back(from); sql += " AND e.created_at >= $" + std::to_string(p.size()) + "::timestamptz"; } if (!to.empty()) { p.push_back(to); sql += " AND e.created_at <= $" + std::to_string(p.size()) + "::timestamptz"; } }
    auto wins = json::strArray(sel["chat_window_ids"]); if (!wins.empty()) sql += " AND e.chat_window_id = ANY(" + Visibility::uuidArray(wins) + ")";
    sql += " ORDER BY e.seq";
    auto rows = db_.queryJson(sql, p);
    std::vector<LogEvent> events;
    for (auto& r : rows) {
        LogEvent e; e.sourceKind = "channel_event"; e.sourceEventId = r["id"].asString(); e.sourceMessageId = r["message_id"].isNull() ? "" : r["message_id"].asString();
        e.chatWindowId = r["chat_window_id"].isNull() ? "" : r["chat_window_id"].asString(); e.sceneId = r["scene_id"].isNull() ? "" : r["scene_id"].asString();
        e.sceneKey = e.sceneId.empty() ? "unscened" : e.sceneId; e.sceneTitle = r["scene_title"].isNull() ? "" : r["scene_title"].asString();
        e.occurredAtUnix = r["ts"].asInt64();
        auto vis = r["visibility"].asString(); e.audience = json::strArray(r["audience"]);
        e.visibilityScope = vis == "gm_only" ? "gm" : (vis == "public" ? "public" : (vis == "whisper" || a.knowledgeMode == "isolated") ? "character" : "public");
        if (e.visibilityScope == "character" && e.audience.empty()) e.visibilityScope = "gm";
        auto kind = r["kind"].asString();
        e.sourceReference["channel_event_kind"] = kind; e.sourceReference["seq"] = r["seq"];
        if (kind != "message.posted") { e.eventType = "scene_change"; e.content = e.sceneTitle.empty() ? json::str(r["payload"], "content") : e.sceneTitle; e.speakerRole = "system"; e.speakerKey = "system"; e.speakerDisplayName = "Scene"; e.metadata["location"] = r["payload"]["location"]; events.push_back(e); continue; }
        e.content = json::str(r["payload"], "content");
        bool gm = r["actor_role"].asString() == "gm";
        e.speakerRole = gm ? (r["character_id"].isNull() ? "gm" : "npc") : "pc";
        e.speakerCharacterId = r["character_id"].isNull() ? "" : r["character_id"].asString();
        e.speakerDisplayName = r["character_name"].isNull() ? (gm ? "GM" : r["actor_name"].asString()) : r["character_name"].asString();
        e.speakerKey = e.speakerCharacterId.empty() ? (gm ? "gm" : "user:" + r["actor_name"].asString()) : e.speakerCharacterId;
        auto mk = r["message_kind"].isNull() ? "ic" : r["message_kind"].asString();
        if (mk == "ooc") e.eventType = "ooc"; else if (mk == "roll") { e.eventType = "dice_roll"; e.dice = parseDice(e.content); } else if (mk == "narration") e.eventType = "narration";
        else e.eventType = gm ? "narration" : classifyMessage(e.content, false, false);
        if (vis == "gm_only") e.eventType = "secret";
        events.push_back(e);
    }
    db_.tx([&](pqxx::work& w) { insertEvents(w, projectId, a.channelId, events, ""); Db::exec(w, "UPDATE log_projects SET version=version+1, updated_at=now() WHERE id=$1", {projectId}); });
    Json::Value out; out["added"] = (int)events.size(); out["selection"] = sel; out["project_id"] = projectId;
    audit(a, "project.sync", out);
    return out;
}

// ---- imports ---------------------------------------------------------------------------------------
Json::Value LogStudioService::adapters() const {
    Json::Value v(Json::arrayValue);
    for (auto* ad : registry_.all()) { Json::Value j; j["name"] = ad->name(); j["supported"] = ad->supportedVersions(); v.append(j); }
    return v;
}
Json::Value LogStudioService::previewImport(const ChannelAccess& a, const std::string& projectId, const std::string& fileName, const std::string& bytes, const std::string& adapterName) {
    if (!a.isGm) throw forbidden("GM role required");
    projectRow(a, projectId);
    if (bytes.empty()) throw badRequest("empty file");
    if (bytes.size() > 50 * 1024 * 1024) throw badRequest("file too large (50 MB max)");
    std::string encoding; auto text = normaliseEncoding(bytes, encoding);
    const LogAdapter* ad = adapterName.empty() || adapterName == "auto" ? registry_.detect(text) : registry_.byName(adapterName);
    if (!ad) throw badRequest("could not detect log format; choose an adapter explicitly or convert the file to UTF-8");
    auto parsed = ad->parse(text);
    if (encoding == "unknown-8bit") { ImportIssue is; is.lineNo = 0; is.raw = ""; is.reason = "file is not valid UTF-8 (GBK/GB18030?). Re-save as UTF-8 for correct characters; text was kept byte-for-byte."; is.severity = "warning"; parsed.issues.insert(parsed.issues.begin(), is); }
    // Suggest speaker→character mapping by name similarity to the channel's characters.
    auto chars = db_.queryJson("SELECT id, name, kind, user_id FROM characters WHERE channel_id=$1", {a.channelId});
    Json::Value speakerMap(Json::objectValue);
    for (auto& sp : parsed.speakers) {
        Json::Value m; m["display_name"] = sp.displayName; m["role"] = sp.role; m["im_user_id"] = sp.imUserId; m["message_count"] = sp.messageCount; m["character_id"] = Json::Value();
        for (auto& c : chars) { auto cn = text::lower(c["name"].asString()), sn = text::lower(sp.displayName); if (cn == sn || cn.find(sn) != std::string::npos || sn.find(cn) != std::string::npos) { m["character_id"] = c["id"]; m["suggested"] = true; if (c["kind"].asString() == "npc") m["role"] = "npc"; break; } }
        speakerMap[sp.key] = m;
    }
    Json::Value stats = parsed.stats(); stats["encoding"] = encoding; stats["file_name"] = fileName;
    // Keep the parsed events in the import row (JSON) so commit does not need the file again.
    Json::Value evs(Json::arrayValue); for (auto& e : parsed.events) evs.append(e.toJson());
    stats["parsed"] = evs;
    auto row = db_.tx([&](pqxx::work& w) {
        auto imp = Db::queryOne(w, "INSERT INTO log_imports(project_id, channel_id, adapter, file_name, encoding, status, stats, speaker_map, created_by) VALUES($1,$2,$3,$4,$5,'previewed',$6::jsonb,$7::jsonb,$8) RETURNING id, adapter, file_name, encoding, status, speaker_map, created_at",
            {projectId, a.channelId, ad->name(), fileName.substr(0, 200), encoding, json::dump(stats), json::dump(speakerMap), a.userId});
        for (auto& is : parsed.issues) Db::exec(w, "INSERT INTO log_import_errors(import_id, line_no, raw, reason, severity) VALUES($1,$2,$3,$4,$5)", {imp["id"].asString(), (int64_t)is.lineNo, is.raw, is.reason, is.severity});
        return imp;
    });
    Json::Value out = row; stats.removeMember("parsed"); out["stats"] = stats; out["speakers"] = speakerMap;
    out["preview"] = Json::Value(Json::arrayValue); for (size_t i = 0; i < parsed.events.size() && i < 60; ++i) out["preview"].append(parsed.events[i].toJson());
    out["issues"] = Json::Value(Json::arrayValue); for (auto& is : parsed.issues) { Json::Value j; j["line_no"] = is.lineNo; j["raw"] = is.raw; j["reason"] = is.reason; j["severity"] = is.severity; out["issues"].append(j); }
    out["start_text"] = parsed.startText;
    return out;
}
Json::Value LogStudioService::commitImport(const ChannelAccess& a, const std::string& projectId, const std::string& importId, const Json::Value& speakerMapIn) {
    if (!a.isGm) throw forbidden("GM role required");
    projectRow(a, projectId);
    auto imp = db_.queryOne("SELECT * FROM log_imports WHERE id=$1 AND project_id=$2", {importId, projectId});
    if (imp.isNull()) throw notFound("import not found");
    if (imp["status"].asString() == "committed") throw conflict("import already committed");
    Json::Value speakerMap = speakerMapIn.isObject() && !speakerMapIn.empty() ? speakerMapIn : imp["speaker_map"];
    std::vector<LogEvent> events;
    for (auto& ev : imp["stats"]["parsed"]) {
        auto e = LogEvent::fromJson(ev); e.sourceKind = "import"; e.eventId.clear();
        if (speakerMap.isMember(e.speakerKey)) {
            auto& m = speakerMap[e.speakerKey];
            if (!json::str(m, "character_id").empty()) e.speakerCharacterId = json::str(m, "character_id");
            if (!json::str(m, "display_name").empty()) e.speakerDisplayName = json::str(m, "display_name");
            if (!json::str(m, "role").empty()) { e.speakerRole = json::str(m, "role"); if (e.speakerRole == "gm" && e.eventType == "dialogue") e.eventType = "narration"; if (e.speakerRole == "hidden" && e.eventType != "ooc") { e.eventType = "secret"; e.visibilityScope = "gm"; } }
            if (json::toBool(m, "drop")) continue;
        }
        if (e.eventType == "secret") e.visibilityScope = "gm";
        if (e.sceneKey.empty()) e.sceneKey = "import:" + importId.substr(0, 8);
        events.push_back(e);
    }
    db_.tx([&](pqxx::work& w) {
        insertEvents(w, projectId, a.channelId, events, importId);
        Json::Value stats = imp["stats"]; stats.removeMember("parsed"); stats["committed_events"] = (int)events.size();
        Db::exec(w, "UPDATE log_imports SET status='committed', speaker_map=$2::jsonb, stats=$3::jsonb, committed_at=now() WHERE id=$1", {importId, json::dump(speakerMap), json::dump(stats)});
        // Persist chosen mapping on the project so later imports suggest the same identities.
        auto proj = Db::queryOne(w, "SELECT character_map FROM log_projects WHERE id=$1", {projectId});
        Json::Value cmap = proj["character_map"].isObject() ? proj["character_map"] : Json::Value(Json::objectValue);
        for (auto it = speakerMap.begin(); it != speakerMap.end(); ++it) { Json::Value m; m["character_id"] = (*it)["character_id"]; m["display_name"] = (*it)["display_name"]; m["role"] = (*it)["role"]; cmap[it.name()] = m; }
        Db::exec(w, "UPDATE log_projects SET character_map=$2::jsonb, source_kind=CASE WHEN source_kind='channel' THEN 'mixed' ELSE source_kind END, version=version+1, updated_at=now() WHERE id=$1", {projectId, json::dump(cmap)});
    });
    Json::Value out; out["import_id"] = importId; out["committed_events"] = (int)events.size();
    audit(a, "import.commit", out);
    return out;
}
Json::Value LogStudioService::listImports(const ChannelAccess& a, const std::string& projectId) {
    if (!a.isGm) throw forbidden("GM role required");
    return db_.queryJson("SELECT id, adapter, file_name, encoding, status, (stats - 'parsed') AS stats, created_at, committed_at, (SELECT count(*) FROM log_import_errors e WHERE e.import_id=i.id) AS issue_count FROM log_imports i WHERE project_id=$1 ORDER BY created_at DESC", {projectId});
}
Json::Value LogStudioService::importErrors(const ChannelAccess& a, const std::string& importId) {
    if (!a.isGm) throw forbidden("GM role required");
    return db_.queryJson("SELECT e.* FROM log_import_errors e JOIN log_imports i ON i.id=e.import_id WHERE e.import_id=$1 AND i.channel_id=$2 ORDER BY e.line_no", {importId, a.channelId});
}

// ---- snapshots -------------------------------------------------------------------------------------
Json::Value LogStudioService::createSnapshot(const ChannelAccess& a, const std::string& projectId, const Json::Value& body) {
    projectRow(a, projectId);
    auto scope = json::str(body, "scope", a.isGm ? "gm_full" : "pl_public");
    if (scope != "gm_full" && scope != "pl_public" && scope != "character") throw badRequest("invalid scope");
    if (!a.isGm && scope == "gm_full") throw forbidden("players cannot create GM snapshots");
    std::string scopeChar = json::str(body, "scope_character_id");
    if (scope == "character" && scopeChar.empty()) throw badRequest("scope_character_id required");
    if (!a.isGm && scope == "character" && std::find(a.characterIds.begin(), a.characterIds.end(), scopeChar) == a.characterIds.end()) throw forbidden("not your character");
    Json::Value sel = body.isMember("selection") && body["selection"].isObject() ? body["selection"] : Json::Value(Json::objectValue);
    auto mode = json::str(sel, "mode", "campaign");
    std::string sql = "SELECT id, visibility_scope, audience FROM log_events WHERE project_id=$1";
    DbParams p{projectId};
    if (mode == "scenes") { auto keys = json::strArray(sel["scene_keys"]); if (keys.empty()) throw badRequest("scene_keys required"); sql += " AND scene_key = ANY($2::text[])"; p.push_back(pgArrayLiteral(keys)); }
    else if (mode == "range") { p.push_back((int64_t)json::toInt(sel, "from_seq", 0)); sql += " AND sequence_number >= $" + std::to_string(p.size()); p.push_back((int64_t)json::toInt(sel, "to_seq", 1 << 30)); sql += " AND sequence_number <= $" + std::to_string(p.size()); }
    else if (mode == "events") { auto ids = json::strArray(sel["event_ids"]); if (ids.empty()) throw badRequest("event_ids required"); sql += " AND id = ANY(" + Visibility::uuidArray(ids) + ")"; }
    else if (mode == "session") { auto from = json::str(sel, "from"), to = json::str(sel, "to"); if (!from.empty()) { p.push_back(from); sql += " AND occurred_at >= $" + std::to_string(p.size()) + "::timestamptz"; } if (!to.empty()) { p.push_back(to); sql += " AND occurred_at <= $" + std::to_string(p.size()) + "::timestamptz"; } }
    sql += " ORDER BY sequence_number";
    auto rows = db_.queryJson(sql, p);
    std::vector<std::string> ids;
    for (auto& r : rows) {
        auto vis = r["visibility_scope"].asString(); auto aud = json::strArray(r["audience"]);
        bool keep = scope == "gm_full" ? true : scope == "pl_public" ? vis == "public" : (vis == "public" || (vis == "character" && std::find(aud.begin(), aud.end(), scopeChar) != aud.end()));
        if (!a.isGm && !eventVisibleTo(a, vis, aud)) keep = false;
        if (keep) ids.push_back(r["id"].asString());
    }
    auto snap = db_.tx([&](pqxx::work& w) {
        auto v = Db::queryOne(w, "SELECT coalesce(max(version),0)+1 AS v FROM log_snapshots WHERE project_id=$1", {projectId})["v"].asInt();
        auto s = Db::queryOne(w, "INSERT INTO log_snapshots(project_id, channel_id, version, title, selection, scope, scope_character_id, event_count, created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) RETURNING *",
            {projectId, a.channelId, (int64_t)v, json::str(body, "title", "Snapshot v" + std::to_string(v)), json::dump(sel), scope, opt(scopeChar), (int64_t)ids.size(), a.userId});
        int pos = 0; for (auto& id : ids) Db::exec(w, "INSERT INTO log_snapshot_events(snapshot_id, position, log_event_id) VALUES($1,$2,$3)", {s["id"].asString(), (int64_t)pos++, id});
        return s;
    });
    audit(a, "snapshot.create", snap);
    return snap;
}
Json::Value LogStudioService::listSnapshots(const ChannelAccess& a, const std::string& projectId) {
    std::string sql = "SELECT s.*, (SELECT count(*) FROM log_presentations p WHERE p.snapshot_id=s.id) AS presentation_count FROM log_snapshots s WHERE project_id=$1";
    if (!a.isGm) sql += " AND (s.scope='pl_public' OR (s.scope='character' AND s.scope_character_id = ANY(" + Visibility::uuidArray(a.characterIds) + ")))";
    return db_.queryJson(sql + " ORDER BY version DESC", {projectId});
}
std::vector<LogEvent> LogStudioService::snapshotEvents(const ChannelAccess& a, const std::string& snapshotId, Json::Value* snapOut) {
    auto s = db_.queryOne("SELECT * FROM log_snapshots WHERE id=$1 AND channel_id=$2", {snapshotId, a.channelId});
    if (s.isNull()) throw notFound("snapshot not found");
    if (!a.isGm && s["scope"].asString() == "gm_full") throw forbidden("GM snapshot");
    if (!a.isGm && s["scope"].asString() == "character" && std::find(a.characterIds.begin(), a.characterIds.end(), s["scope_character_id"].asString()) == a.characterIds.end()) throw forbidden("snapshot belongs to another character");
    if (snapOut) *snapOut = s;
    auto rows = db_.queryJson("SELECT " + EVENT_COLS + " FROM log_events e JOIN log_snapshot_events se ON se.log_event_id=e.id WHERE se.snapshot_id=$1 ORDER BY se.position", {snapshotId});
    std::vector<LogEvent> out;
    for (auto& r : rows) { auto e = LogEvent::fromJson(r); if (eventVisibleTo(a, e.visibilityScope, e.audience)) out.push_back(e); }
    return out;
}
Json::Value LogStudioService::getSnapshot(const ChannelAccess& a, const std::string& snapshotId, bool withEvents) {
    Json::Value s; auto events = snapshotEvents(a, snapshotId, &s);
    s["visible_event_count"] = (int)events.size();
    if (withEvents) { s["events"] = Json::Value(Json::arrayValue); for (auto& e : events) s["events"].append(e.toJson()); }
    auto proj = db_.queryOne("SELECT title, character_map FROM log_projects WHERE id=$1", {s["project_id"].asString()});
    s["project_title"] = proj["title"]; s["character_map"] = proj["character_map"];
    return s;
}

// ---- exports ---------------------------------------------------------------------------------------
std::string LogStudioService::renderStyledHtml(const Json::Value& snap, const std::vector<LogEvent>& events, const Json::Value& style, const Json::Value& cmap) {
    static const char* palette[] = {"#7c9cff","#5bd1b9","#f0b35b","#ef6b73","#c9a4ff","#6fcf97","#ff9f6e","#9ad0ff"};
    std::map<std::string, std::string> colors; int ci = 0;
    auto colorFor = [&](const LogEvent& e) -> std::string {
        if (cmap.isObject() && cmap.isMember(e.speakerKey) && !json::str(cmap[e.speakerKey], "color").empty()) return json::str(cmap[e.speakerKey], "color");
        if (e.speakerRole == "gm") return json::str(style, "gm_color", "#d7b26d");
        if (!colors.count(e.speakerKey)) colors[e.speakerKey] = palette[(ci++) % 8];
        return colors[e.speakerKey];
    };
    bool showOoc = json::toBool(style, "show_ooc", true), showTime = json::toBool(style, "show_timestamps", true), showDice = json::toBool(style, "show_dice", true);
    std::string font = json::str(style, "font", "system-ui, 'Noto Sans CJK SC', 'WenQuanYi Zen Hei', sans-serif");
    std::string html = "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\"><title>" + htmlEscape(json::str(snap, "project_title", "Log")) + "</title><style>"
        "body{font-family:" + htmlEscape(font) + ";background:" + json::str(style, "background", "#14171d") + ";color:" + json::str(style, "text_color", "#e8ebf1") + ";max-width:" + json::str(style, "max_width", "820px") + ";margin:0 auto;padding:24px 16px;line-height:1.6;font-size:" + json::str(style, "font_size", "15px") + "}"
        ".msg{margin:0 0 10px;display:grid;grid-template-columns:auto 1fr;gap:8px}.name{font-weight:600;white-space:nowrap}.time{color:#7a8290;font-size:11px;margin-left:6px}.narr .text{font-style:italic;color:#c5ccd8}.ooc .text{color:#7a8290;font-size:13px}.dice .text{font-family:ui-monospace,monospace;background:#1f2430;border-radius:6px;padding:2px 8px;display:inline-block}.scene{margin:28px 0 14px;text-align:center;color:#9aa3b2;font-variant:small-caps;letter-spacing:.08em;border-top:1px solid #2a2f3a;padding-top:12px}.secret{border-left:3px solid #ef6b73;padding-left:8px}.text{white-space:pre-wrap;word-break:break-word}.media{color:#7c9cff}"
        "</style></head><body><h1>" + htmlEscape(json::str(snap, "title", "")) + "</h1>";
    for (auto& e : events) {
        if (e.eventType == "ooc" && !showOoc) continue;
        if (e.eventType == "dice_roll" && !showDice) continue;
        if (e.eventType == "scene_change") { html += "<div class=\"scene\">" + htmlEscape(e.content) + "</div>"; continue; }
        std::string cls = e.eventType == "narration" ? "narr" : e.eventType == "ooc" ? "ooc" : e.eventType == "dice_roll" ? "dice" : e.eventType == "secret" ? "secret" : e.eventType == "media" ? "media" : "";
        std::string ts; if (showTime && e.occurredAtUnix) { std::time_t tt = *e.occurredAtUnix; std::tm tm{}; gmtime_r(&tt, &tm); char buf[32]; std::strftime(buf, sizeof buf, "%H:%M:%S", &tm); ts = buf; } else if (showTime) ts = e.timeText;
        html += "<div class=\"msg " + cls + "\"><span class=\"name\" style=\"color:" + colorFor(e) + "\">" + htmlEscape(e.speakerDisplayName) + "</span><span><span class=\"text\">" + htmlEscape(e.content) + "</span>" + (ts.empty() ? "" : "<span class=\"time\">" + htmlEscape(ts) + "</span>") + "</span></div>";
    }
    html += "<p style=\"color:#555;font-size:11px;margin-top:40px\">Generated by Acerciae Log Studio · snapshot v" + std::to_string(json::toInt(snap, "version", 0)) + " · scope " + htmlEscape(json::str(snap, "scope")) + "</p></body></html>";
    return html;
}
std::string LogStudioService::exportSnapshot(const ChannelAccess& a, const std::string& snapshotId, const std::string& format, std::string& mime, std::string& fileName) {
    Json::Value snap; auto events = snapshotEvents(a, snapshotId, &snap);
    auto proj = db_.queryOne("SELECT title, character_map FROM log_projects WHERE id=$1", {snap["project_id"].asString()});
    snap["project_title"] = proj["title"];
    std::string base = "log-" + snapshotId.substr(0, 8) + "-v" + std::to_string(snap["version"].asInt());
    Json::Value target; target["snapshot_id"] = snapshotId; target["format"] = format; audit(a, "snapshot.export", target);
    if (format == "json") { mime = "application/json; charset=utf-8"; fileName = base + ".json"; Json::Value meta; meta["project"] = proj["title"]; meta["snapshot_version"] = snap["version"]; meta["scope"] = snap["scope"]; meta["character_map"] = proj["character_map"]; return json::dump(toNativeJson(events, meta), true); }
    if (format == "txt") { mime = "text/plain; charset=utf-8"; fileName = base + ".txt"; return toPlainText(events); }
    if (format == "sealdice_txt") { mime = "text/plain; charset=utf-8"; fileName = base + ".sealdice.txt"; return registry_.byName("sealdice_text")->exportText(events); }
    if (format == "html") { mime = "text/html; charset=utf-8"; fileName = base + ".html"; return renderStyledHtml(snap, events, Json::Value(Json::objectValue), proj["character_map"]); }
    throw badRequest("unknown export format (json|txt|sealdice_txt|html)");
}

} // namespace acerciae::logstudio
