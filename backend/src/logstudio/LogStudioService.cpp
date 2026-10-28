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
#include <regex>
#include "../core/Zip.h"
#include "StudioPolicy.h"

namespace acerciae::logstudio {

static DbParam opt(const std::string& s) { return s.empty() ? dbNull() : DbParam(s); }

static std::string htmlEscape(const std::string& s) {
    std::string o; o.reserve(s.size());
    for (char c : s) { switch (c) { case '&': o += "&amp;"; break; case '<': o += "&lt;"; break; case '>': o += "&gt;"; break; case '"': o += "&quot;"; break; default: o += c; } }
    return o;
}

// Derive the map from the selected events, never from unrelated (possibly secret) speakers.
static Json::Value snapshotMap(const std::vector<LogEvent>& events, const Json::Value& source) {
    Json::Value out(Json::objectValue);
    for (const auto& e : events) {
        auto& m=out[e.speakerKey]; m["display_name"]=e.speakerDisplayName; m["role"]=e.speakerRole;
        if(!e.speakerCharacterId.empty()) m["character_id"]=e.speakerCharacterId;
        auto color=json::str(source[e.speakerKey],"color");
        if(std::regex_match(color,std::regex("#[0-9a-fA-F]{6}"))) m["color"]=color;
    }
    return out;
}

void LogStudioService::audit(const ChannelAccess& a, const std::string& action, const Json::Value& target) {
    // The system identity (campaign log sync) has no user row; its actions are logged without one.
    db_.exec("INSERT INTO studio_audit_log(channel_id, user_id, action, target) VALUES($1,$2,$3,$4::jsonb)", {a.channelId, a.userId.empty() || a.userId == "00000000-0000-0000-0000-000000000000" ? dbNull() : DbParam(a.userId), action, json::dump(target)});
}

std::string LogStudioService::scopeSql(const ChannelAccess& a, const std::string& le) {
    if (a.isGm) return "";
    return " AND " + visibleLogFilter(a, storyState(db_, a.channelId), le);
}
static std::map<std::string, std::string> sceneLabels(Db& db, const std::string& channelId) {
    std::map<std::string, std::string> out;
    for (auto& r : db.queryJson("SELECT id, sequence FROM scenes WHERE channel_id=$1", {channelId})) out[r["id"].asString()] = "Scenario " + r["sequence"].asString();
    return out;
}
void LogStudioService::maskScenes(const std::string& channelId, std::vector<LogEvent>& events) {
    auto labels = sceneLabels(db_, channelId);
    for (auto& e : events) {
        auto it = labels.find(e.sceneId);
        std::string label = it == labels.end() ? "" : it->second;
        e.sceneTitle = label;
        if (e.eventType == "scene_change") e.content = label.empty() ? "Scenario" : label;
        if (e.metadata.isObject()) e.metadata.removeMember("location");
    }
}
void LogStudioService::maskScenes(const std::string& channelId, Json::Value& rows) {
    auto labels = sceneLabels(db_, channelId);
    for (auto& r : rows) {
        auto it = labels.find(json::str(r, "scene_id"));
        std::string label = it == labels.end() ? "" : it->second;
        if (r.isMember("scene_title")) r["scene_title"] = label;
        if (json::str(r, "event_type") == "scene_change") r["content"] = label.empty() ? "Scenario" : label;
        if (r["metadata"].isObject()) r["metadata"].removeMember("location");
    }
}

Json::Value LogStudioService::projectRow(const ChannelAccess& a, const std::string& projectId) {
    auto p = db_.queryOne("SELECT * FROM log_projects WHERE id=$1 AND channel_id=$2", {projectId, a.channelId});
    if (p.isNull()) throw notFound("log project not found");
    if(!a.isGm) {
        Json::Value map(Json::objectValue);
        for(const auto& r:db_.queryJson("SELECT DISTINCT speaker_key FROM log_events WHERE project_id=$1"+scopeSql(a,"log_events"),{projectId})) {
            auto key=r["speaker_key"].asString(); if(p["character_map"].isMember(key)) map[key]=p["character_map"][key];
        }
        p["character_map"]=map;
    }
    return p;
}

// ---- projects --------------------------------------------------------------------------------------
Json::Value LogStudioService::settings(const ChannelAccess& a) { return db_.queryOne("SELECT studio_cloud_allowed,tts_budget_chars FROM channels WHERE id=$1",{a.channelId}); }
Json::Value LogStudioService::saveSettings(const ChannelAccess& a,const Json::Value& b) {
    if(!a.isGm) throw forbidden("GM role required"); auto cur=settings(a);
    if(b.isMember("tts_budget_chars")&&!b["tts_budget_chars"].isIntegral()) throw badRequest("tts_budget_chars must be an integer");
    auto budget=b.isMember("tts_budget_chars")?b["tts_budget_chars"].asInt64():cur["tts_budget_chars"].asInt64();
    if(budget<0||budget>100000000) throw badRequest("budget must be 0..100000000 characters");
    if(b.isMember("studio_cloud_allowed")&&!b["studio_cloud_allowed"].isBool()) throw badRequest("studio_cloud_allowed must be boolean");
    auto row=db_.queryOne("UPDATE channels SET studio_cloud_allowed=$2,tts_budget_chars=$3 WHERE id=$1 RETURNING studio_cloud_allowed,tts_budget_chars",{a.channelId,json::toBool(b,"studio_cloud_allowed",cur["studio_cloud_allowed"].asBool()),budget});
    audit(a,"settings.update",row);return row;
}
Json::Value LogStudioService::listProjects(const ChannelAccess& a) {
    auto rows=db_.queryJson("SELECT id FROM log_projects WHERE channel_id=$1 ORDER BY created_at DESC",{a.channelId});
    Json::Value out(Json::arrayValue);
    for(const auto& row:rows) {
        auto id=row["id"].asString(); auto p=projectRow(a,id);
        p["event_count"]=db_.queryOne("SELECT count(*) AS n FROM log_events WHERE project_id=$1"+scopeSql(a,"log_events"),{id})["n"];
        auto snaps=listSnapshots(a,id); p["snapshot_count"]=(int)snaps.size(); int presentations=0;
        for(const auto& snap:snaps) presentations+=snap["presentation_count"].asInt();
        p["presentation_count"]=presentations;
        p["published_count"]=db_.queryOne("SELECT count(*) AS n FROM published_logs WHERE project_id=$1 AND NOT revoked"+std::string(a.isGm?"":" AND visibility='players'"),{id})["n"];
        out.append(p);
    }
    return out;
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
    p["event_count"] = db_.queryOne("SELECT count(*) AS n FROM log_events WHERE project_id=$1"+scopeSql(a,"log_events"), {projectId})["n"];
    p["snapshots"] = listSnapshots(a, projectId);
    p["speakers"] = db_.queryJson("SELECT speaker_key, max(speaker_display_name) AS display_name, max(speaker_role) AS role, max(speaker_character_id::text) AS character_id, count(*) AS n FROM log_events WHERE project_id=$1"+scopeSql(a,"log_events")+" GROUP BY speaker_key ORDER BY n DESC", {projectId});
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
                Db::exec(w, "UPDATE log_events SET speaker_character_id=CASE WHEN $6::boolean THEN $3::uuid ELSE speaker_character_id END, speaker_display_name=coalesce(nullif($4,''), speaker_display_name), speaker_role=coalesce(nullif($5,''), speaker_role) WHERE project_id=$1 AND speaker_key=$2",
                    {projectId, key, opt(json::str(m, "character_id")), json::str(m, "display_name"), json::str(m, "role"),m.isMember("character_id")});
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
static const std::string EVENT_COLS = "id AS event_id, channel_id AS campaign_id, sequence_number, event_type, content, speaker_key, speaker_display_name, speaker_character_id, speaker_role, extract(epoch from occurred_at)::bigint AS timestamp, time_text, scene_key, scene_title, scene_id, chat_window_id, visibility_scope, audience, source_kind, source_event_id, source_message_id, source_reference, dice, media, metadata, raw_text, unrecognised";

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
    sql += scopeSql(a, "log_events");
    if (!sceneKey.empty()) { p.push_back(sceneKey); sql += " AND scene_key=$3"; }
    sql += " ORDER BY sequence_number LIMIT " + std::to_string(std::max(1, std::min(limit, 2000)));
    auto rows = db_.queryJson(sql, p);
    if (masksScenes(a, storyState(db_, a.channelId))) maskScenes(a.channelId, rows);
    return rows;
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
    auto rows = db_.queryJson("SELECT scene_key, max(scene_title) AS scene_title, max(scene_id::text) AS scene_id, min(sequence_number) AS from_seq, max(sequence_number) AS to_seq, count(*) AS n FROM log_events WHERE project_id=$1"+scopeSql(a,"log_events")+" GROUP BY scene_key ORDER BY min(sequence_number)", {projectId});
    if (masksScenes(a, storyState(db_, a.channelId))) maskScenes(a.channelId, rows);
    return rows;
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
                      "c.name AS character_name, u.display_name AS actor_name, s.title AS scene_title, m.content AS message_content, m.kind AS message_kind FROM events e LEFT JOIN characters c ON c.id=e.character_id LEFT JOIN users u ON u.id=e.actor_user_id LEFT JOIN scenes s ON s.id=e.scene_id LEFT JOIN messages m ON m.id=e.message_id "
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
        if (kind == "scene.created") e.visibilityScope = "gm";   // prepared, not yet played
        if (kind != "message.posted") { e.eventType = "scene_change"; e.content = e.sceneTitle.empty() ? json::str(r["payload"], "content") : e.sceneTitle; e.speakerRole = "system"; e.speakerKey = "system"; e.speakerDisplayName = "Scene"; e.metadata["location"] = r["payload"]["location"]; events.push_back(e); continue; }
        e.content = r["message_content"].isString() ? r["message_content"].asString() : json::str(r["payload"], "content");
        bool gm = r["actor_role"].asString() == "gm";
        e.speakerRole = gm ? (r["character_id"].isNull() ? "gm" : "npc") : "pc";
        e.speakerCharacterId = r["character_id"].isNull() ? "" : r["character_id"].asString();
        e.speakerDisplayName = r["character_name"].isNull() ? (gm ? "GM" : r["actor_name"].asString()) : r["character_name"].asString();
        e.speakerKey = e.speakerCharacterId.empty() ? (gm ? "gm" : "user:" + r["actor_name"].asString()) : e.speakerCharacterId;
        auto mk = r["message_kind"].isNull() ? "ic" : r["message_kind"].asString();
        if (mk == "ooc") e.eventType = "ooc"; else if (mk == "roll") { e.eventType = "dice_roll"; if (r["payload"]["dice"].isObject()) {
            const auto& actual = r["payload"]["dice"]; e.metadata["dice_result"] = actual;
            DiceInfo d; d.raw = json::str(actual,"text"); d.expression = json::str(actual,"expr"); d.checkName = json::str(actual,"attr");
            for (const auto& roll : actual["rolls"]) { if (roll["roll"].isInt()) d.rolls.push_back(roll["roll"].asInt()); }
            if (actual["rolls"].size() == 1) { auto one=actual["rolls"][0]; if (one["total"].isInt()) d.total=one["total"].asInt(); else if (one["roll"].isInt()) d.total=one["roll"].asInt(); d.outcome=json::str(one,"level"); }
            e.dice=d;
        } else e.dice = parseDice(e.content); } else if (mk == "narration") e.eventType = "narration";
        // The Keeper without a character narrates; the Keeper speaking as an NPC talks like anyone else.
        else e.eventType = gm && e.speakerCharacterId.empty() ? "narration" : classifyMessage(e.content, false, false);
        if (vis == "gm_only") e.eventType = "secret";
        events.push_back(e);
    }
    db_.tx([&](pqxx::work& w) { insertEvents(w, projectId, a.channelId, events, ""); Db::exec(w, "UPDATE log_projects SET version=version+1, updated_at=now() WHERE id=$1", {projectId}); });
    Json::Value out; out["added"] = (int)events.size(); out["selection"] = sel; out["project_id"] = projectId;
    audit(a, "project.sync", out);
    return out;
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
    auto story = storyState(db_, a.channelId);
    sql += " AND " + scopeLogFilter(story, scope, scopeChar, "log_events") + scopeSql(a, "log_events");
    sql += " ORDER BY sequence_number";
    auto rows = db_.queryJson(sql, p);
    std::vector<std::string> ids;
    for (auto& r : rows) ids.push_back(r["id"].asString());
    auto snap = db_.tx([&](pqxx::work& w) {
        Db::exec(w,"SELECT id FROM log_projects WHERE id=$1 FOR UPDATE",{projectId});
        auto v = Db::queryOne(w, "SELECT coalesce(max(version),0)+1 AS v FROM log_snapshots WHERE project_id=$1", {projectId})["v"].asInt();
        auto s = Db::queryOne(w, "INSERT INTO log_snapshots(project_id, channel_id, version, title, selection, scope, scope_character_id, event_count, created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) RETURNING *",
            {projectId, a.channelId, (int64_t)v, json::str(body, "title", "Snapshot v" + std::to_string(v)), json::dump(sel), scope, opt(scopeChar), (int64_t)ids.size(), a.userId});
        int pos = 0; for (auto& id : ids) Db::exec(w, "INSERT INTO log_snapshot_events(snapshot_id, position, log_event_id, frozen_event) SELECT $1,$2,id,to_jsonb(e) || jsonb_build_object('event_id',id,'timestamp',extract(epoch from occurred_at)::bigint) FROM log_events e WHERE id=$3", {s["id"].asString(), (int64_t)pos++, id});
        // A players' snapshot made before the end never carries scenario titles or locations.
        if (scope != "gm_full" && !story.ended)
            Db::exec(w, "UPDATE log_snapshot_events se SET frozen_event = se.frozen_event || jsonb_build_object("
                        "'scene_title', coalesce('Scenario ' || sc.sequence, ''), "
                        "'content', CASE WHEN se.frozen_event->>'event_type'='scene_change' THEN coalesce('Scenario ' || sc.sequence, 'Scenario') ELSE se.frozen_event->>'content' END, "
                        "'metadata', coalesce(se.frozen_event->'metadata', '{}'::jsonb) - 'location') "
                        "FROM log_events e LEFT JOIN scenes sc ON sc.id=e.scene_id WHERE se.snapshot_id=$1 AND e.id=se.log_event_id", {s["id"].asString()});
        auto proj=Db::queryOne(w,"SELECT title,character_map FROM log_projects WHERE id=$1",{projectId});
        auto selected=ids.empty()?std::vector<LogEvent>{}:loadEvents(w,projectId,ids);
        Json::Value meta; meta["project_title"]=proj["title"]; meta["character_map"]=snapshotMap(selected,proj["character_map"]);
        Db::exec(w,"UPDATE log_snapshots SET frozen_metadata=$2::jsonb WHERE id=$1",{s["id"].asString(),json::dump(meta)});
        s["frozen_metadata"]=meta; return s;
    });
    audit(a, "snapshot.create", snap);
    return snap;
}
Json::Value LogStudioService::listSnapshots(const ChannelAccess& a, const std::string& projectId) {
    projectRow(a, projectId);
    std::string sql = "SELECT s.*, (SELECT count(*) FROM log_presentations p WHERE p.snapshot_id=s.id) AS presentation_count FROM log_snapshots s WHERE project_id=$1";
    if (!a.isGm) sql += storyState(db_, a.channelId).ended ? " AND s.scope<>'gm_full'" : " AND (s.scope='pl_public' OR (s.scope='character' AND s.scope_character_id = ANY(" + Visibility::uuidArray(a.characterIds) + ")))";
    return db_.queryJson(sql + " ORDER BY version DESC", {projectId});
}
std::vector<LogEvent> LogStudioService::snapshotEvents(const ChannelAccess& a, const std::string& snapshotId, Json::Value* snapOut) {
    auto s = db_.queryOne("SELECT * FROM log_snapshots WHERE id=$1 AND channel_id=$2", {snapshotId, a.channelId});
    if (s.isNull()) throw notFound("snapshot not found");
    if (!a.isGm && s["scope"].asString() == "gm_full") throw forbidden("GM snapshot");
    auto story = storyState(db_, a.channelId);
    if (!a.isGm && !story.ended && s["scope"].asString() == "character" && std::find(a.characterIds.begin(), a.characterIds.end(), s["scope_character_id"].asString()) == a.characterIds.end()) throw forbidden("snapshot belongs to another character");
    if (snapOut) *snapOut = s;
    // Each line is re-checked for the viewer now: a line hidden later, or never theirs, does not come back.
    auto rows = db_.queryJson("SELECT se.frozen_event FROM log_events e JOIN log_snapshot_events se ON se.log_event_id=e.id WHERE se.snapshot_id=$1 AND " +
                              visibleLogFilter(a, story, "e") + " ORDER BY se.position", {snapshotId});
    std::vector<LogEvent> out;
    for (auto& r : rows) out.push_back(LogEvent::fromJson(r["frozen_event"]));
    if (masksScenes(a, story)) maskScenes(a.channelId, out);
    return out;
}
Json::Value LogStudioService::getSnapshot(const ChannelAccess& a, const std::string& snapshotId, bool withEvents) {
    Json::Value s; auto events = snapshotEvents(a, snapshotId, &s);
    s["visible_event_count"] = (int)events.size();
    if (withEvents) { s["events"] = Json::Value(Json::arrayValue); for (auto& e : events) s["events"].append(e.toJson()); }
    auto proj = db_.queryOne("SELECT title, character_map FROM log_projects WHERE id=$1", {s["project_id"].asString()});
    s["project_title"] = s["frozen_metadata"].isMember("project_title")?s["frozen_metadata"]["project_title"]:proj["title"]; s["character_map"] = snapshotMap(events,s["frozen_metadata"].isMember("character_map")?s["frozen_metadata"]["character_map"]:proj["character_map"]);
    s.removeMember("frozen_metadata");
    return s;
}

// ---- exports ---------------------------------------------------------------------------------------
std::string LogStudioService::renderStyledHtml(const Json::Value& snap, const std::vector<LogEvent>& events, const Json::Value& style, const Json::Value& cmap) {
    static const char* palette[] = {"#7c9cff","#5bd1b9","#f0b35b","#ef6b73","#c9a4ff","#6fcf97","#ff9f6e","#9ad0ff"};
    std::map<std::string, std::string> colors; int ci = 0;
    auto colorFor = [&](const LogEvent& e) -> std::string {
        if (cmap.isObject() && cmap.isMember(e.speakerKey) && !json::str(cmap[e.speakerKey], "color").empty()) { auto color=json::str(cmap[e.speakerKey],"color"); if(std::regex_match(color,std::regex("#[0-9a-fA-F]{6}"))) return color; }
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
// ---- the campaign log ---------------------------------------------------------------------------------
std::string LogStudioService::campaignProjectId(const std::string& channelId) {
    auto p = db_.queryOne("SELECT id FROM log_projects WHERE channel_id=$1 AND source_kind='channel' ORDER BY created_at LIMIT 1", {channelId});
    if (!p.isNull()) return p["id"].asString();
    auto ch = db_.queryOne("SELECT name FROM channels WHERE id=$1", {channelId});
    return db_.queryOne("INSERT INTO log_projects(channel_id, title, description, source_kind) VALUES($1,$2,'The campaign log: every chat window, the whole campaign.','channel') RETURNING id", {channelId, ch.isNull() ? "Campaign log" : ch["name"].asString()})["id"].asString();
}
int LogStudioService::syncCampaign(const std::string& channelId, const std::string& projectId) {
    ChannelAccess sys; sys.channelId = channelId; sys.isGm = true; sys.userId = "00000000-0000-0000-0000-000000000000";
    auto mode = db_.queryOne("SELECT knowledge_mode FROM channels WHERE id=$1", {channelId}); sys.knowledgeMode = mode.isNull() ? "isolated" : mode["knowledge_mode"].asString();
    Json::Value sel; sel["mode"] = "campaign";
    return syncFromChannel(sys, projectId, sel)["added"].asInt();
}
Json::Value LogStudioService::campaignLog(const ChannelAccess& a) {
    auto pid = campaignProjectId(a.channelId);
    int added = syncCampaign(a.channelId, pid);
    auto story = storyState(db_, a.channelId);
    Json::Value out; out["project"] = getProject(a, pid); out["synced_added"] = added;
    auto st = db_.queryOne("SELECT story_status, story_ended_at, story_reveal_all FROM channels WHERE id=$1", {a.channelId});
    out["story"]["status"] = st["story_status"]; out["story"]["ended_at"] = st["story_ended_at"]; out["story"]["reveal_all"] = st["story_reveal_all"];
    // Players see the windows they are in and any other window with a line they may read.
    std::string lines = "SELECT 1 FROM log_events le WHERE le.project_id=$2 AND le.chat_window_id=w.id AND le.event_type<>'scene_change'" + scopeSql(a, "le");
    out["windows"] = db_.queryJson("SELECT w.id, w.name, w.kind, (SELECT count(*) FROM (" + lines + ") x) AS line_count, (SELECT max(le.occurred_at) FROM log_events le WHERE le.project_id=$2 AND le.chat_window_id=w.id" + scopeSql(a, "le") + ") AS last_at FROM chat_windows w WHERE w.channel_id=$1" +
        std::string(a.isGm ? "" : " AND (EXISTS (SELECT 1 FROM chat_window_members wm WHERE wm.chat_window_id=w.id AND wm.user_id=$3) OR EXISTS (" + lines + "))") + " ORDER BY w.created_at",
        a.isGm ? DbParams{a.channelId, pid} : DbParams{a.channelId, pid, a.userId});
    bool titles = !masksScenes(a, story), summaries = a.isGm || story.revealAll;
    out["scenarios"] = db_.queryJson("SELECT s.id, s.sequence, " + std::string(titles ? "s.title" : "'Scenario '||s.sequence") + " AS title, s.status, " + std::string(summaries ? "s.summary" : "''") + " AS summary, (SELECT count(*) FROM log_events le WHERE le.project_id=$2 AND le.scene_id=s.id AND le.event_type<>'scene_change'" + scopeSql(a, "le") + ") AS line_count FROM scenes s WHERE s.channel_id=$1" + std::string(a.isGm ? "" : " AND EXISTS (SELECT 1 FROM log_events le WHERE le.project_id=$2 AND le.scene_id=s.id" + scopeSql(a, "le") + ")") + " ORDER BY s.sequence", {a.channelId, pid});
    out["last_event_at"] = db_.queryOne("SELECT max(occurred_at) AS last_at FROM log_events WHERE project_id=$1" + scopeSql(a, "log_events"), {pid})["last_at"];
    return out;
}
std::vector<LogEvent> LogStudioService::campaignEvents(const ChannelAccess& a, const std::string& projectId, const std::string& chatWindowId) {
    std::string sql = "SELECT " + EVENT_COLS + " FROM log_events WHERE project_id=$1" + scopeSql(a, "log_events");
    DbParams p{projectId};
    if (!chatWindowId.empty()) { if (!Visibility::isUuid(chatWindowId)) throw badRequest("invalid chat_window_id"); p.push_back(chatWindowId); sql += " AND chat_window_id=$2"; }
    sql += " ORDER BY sequence_number";
    std::vector<LogEvent> out; for (auto& r : db_.queryJson(sql, p)) out.push_back(LogEvent::fromJson(r));
    if (masksScenes(a, storyState(db_, a.channelId))) maskScenes(a.channelId, out);
    return out;
}
// SealDice log JSON as story-painter reads it: {version, items:[{nickname, IMUserId, time, message, isDice, commandId?, commandInfo?}]}.
Json::Value LogStudioService::toSealDiceJson(const std::vector<LogEvent>& events) {
    Json::Value j; j["version"] = 105; j["items"] = Json::Value(Json::arrayValue);
    for (const auto& e : events) {
        if (e.eventType == "scene_change") continue;
        Json::Value it; it["nickname"] = e.speakerDisplayName; it["IMUserId"] = e.speakerCharacterId.empty() ? e.speakerKey : e.speakerCharacterId;
        it["time"] = e.occurredAtUnix ? Json::Value((Json::Int64)*e.occurredAtUnix) : Json::Value(0);
        it["message"] = e.content; it["isDice"] = e.eventType == "dice_roll"; it["isRaw"] = false; it["color"] = "";
        it["role"] = e.speakerRole == "gm" ? "gm" : e.speakerRole == "npc" ? "npc" : "pc";
        if (e.eventType == "ooc") it["isOoc"] = true;
        if (e.metadata.isMember("dice_result")) { it["commandId"] = 0; it["commandInfo"] = e.metadata["dice_result"]; }
        if (!e.chatWindowId.empty()) it["channelId"] = e.chatWindowId;
        j["items"].append(it);
    }
    return j;
}
std::string LogStudioService::exportLog(const ChannelAccess& a, const std::string& format, const std::string& chatWindowId, std::string& mime, std::string& fileName) {
    auto pid = campaignProjectId(a.channelId); syncCampaign(a.channelId, pid);
    auto proj = db_.queryOne("SELECT title, character_map FROM log_projects WHERE id=$1", {pid});
    auto ch = db_.queryOne("SELECT name, era FROM channels WHERE id=$1", {a.channelId});
    auto story = storyState(db_, a.channelId);
    // Players' exports name only the windows they are in or have a readable line from.
    auto windows = db_.queryJson("SELECT w.id, w.name, w.kind FROM chat_windows w WHERE w.channel_id=$1" + std::string(a.isGm ? "" :
        " AND (EXISTS (SELECT 1 FROM chat_window_members wm WHERE wm.chat_window_id=w.id AND wm.user_id=$3) OR EXISTS (SELECT 1 FROM log_events le WHERE le.project_id=$2 AND le.chat_window_id=w.id" + scopeSql(a, "le") + "))") + " ORDER BY w.created_at",
        a.isGm ? DbParams{a.channelId} : DbParams{a.channelId, pid, a.userId});
    std::map<std::string, std::string> windowName; for (auto& w : windows) windowName[w["id"].asString()] = w["name"].asString();
    auto slug = [](std::string s) { std::string o; for (unsigned char c : s) o += (isalnum(c) || c >= 0x80) ? (char)c : '_'; return o.substr(0, 40); };
    std::string base = slug(ch.isNull() ? "campaign" : ch["name"].asString());
    Json::Value target; target["format"] = format; target["chat_window_id"] = chatWindowId; audit(a, "log.export", target);
    auto meta = [&](const std::vector<LogEvent>& events) {
        Json::Value m; m["campaign"] = ch.isNull() ? Json::Value("") : ch["name"]; m["era"] = ch.isNull() ? Json::Value("") : ch["era"]; m["channel_id"] = a.channelId; m["viewer"] = a.isGm ? "gm" : "player";
        m["windows"] = windows; m["character_map"] = snapshotMap(events, proj["character_map"]);
        std::string cols = a.isGm || story.revealAll ? "s.title, s.location, s.narrative_time, s.summary" : story.ended ? "s.title, s.location, s.narrative_time" : "'Scenario '||s.sequence AS title";
        // Players' exports list only scenarios with a line they may read.
        m["scenarios"] = db_.queryJson("SELECT s.id, s.sequence, " + cols + ", s.status FROM scenes s WHERE s.channel_id=$1" + std::string(a.isGm ? "" : " AND EXISTS (SELECT 1 FROM log_events le WHERE le.project_id=$2 AND le.scene_id=s.id" + scopeSql(a, "le") + ")") + " ORDER BY s.sequence", a.isGm ? DbParams{a.channelId} : DbParams{a.channelId, pid});
        m["characters"] = db_.queryJson("SELECT id, name, kind FROM characters WHERE channel_id=$1" + std::string(a.isGm || story.ended ? "" : " AND kind='pc'") + " ORDER BY created_at", {a.channelId});
        m["exported_at"] = text::nowIso(); return m;
    };
    if (format == "json") { auto events = campaignEvents(a, pid, chatWindowId); mime = "application/json; charset=utf-8"; fileName = base + (chatWindowId.empty() ? "" : "-" + slug(windowName[chatWindowId])) + ".acerciae-log.json"; return json::dump(toNativeJson(events, meta(events)), true); }
    if (format == "txt") { auto events = campaignEvents(a, pid, chatWindowId); mime = "text/plain; charset=utf-8"; fileName = base + ".txt"; return toPlainText(events); }
    if (format == "html") { auto events = campaignEvents(a, pid, chatWindowId); mime = "text/html; charset=utf-8"; fileName = base + ".html"; Json::Value snap; snap["project_title"] = proj["title"]; snap["title"] = proj["title"]; snap["version"] = 0; snap["scope"] = a.isGm ? "gm_full" : "player"; return renderStyledHtml(snap, events, Json::Value(Json::objectValue), snapshotMap(events, proj["character_map"])); }
    if (format == "sealdice") {
        if (chatWindowId.empty()) throw badRequest("sealdice exports are per chat window: pass chat_window_id, or use format=zip for all windows");
        auto events = campaignEvents(a, pid, chatWindowId); mime = "application/json; charset=utf-8"; fileName = base + "-" + slug(windowName[chatWindowId]) + ".sealdice.json"; return json::dump(toSealDiceJson(events), true);
    }
    if (format == "zip") {
        auto all = campaignEvents(a, pid, "");
        std::vector<std::pair<std::string, std::string>> files;
        files.push_back({base + ".acerciae-log.json", json::dump(toNativeJson(all, meta(all)), true)});
        files.push_back({base + ".txt", toPlainText(all)});
        for (auto& w : windows) {
            std::vector<LogEvent> part; for (auto& e : all) if (e.chatWindowId == w["id"].asString()) part.push_back(e);
            if (part.empty()) continue;
            files.push_back({"sealdice/" + slug(w["name"].asString()) + ".json", json::dump(toSealDiceJson(part), true)});
        }
        mime = "application/zip"; fileName = base + "-log.zip"; return zip::build(files);
    }
    throw badRequest("unknown export format (json|txt|html|sealdice|zip)");
}

std::string LogStudioService::exportSnapshot(const ChannelAccess& a, const std::string& snapshotId, const std::string& format, std::string& mime, std::string& fileName) {
    Json::Value snap; auto events = snapshotEvents(a, snapshotId, &snap);
    auto proj = db_.queryOne("SELECT title, character_map FROM log_projects WHERE id=$1", {snap["project_id"].asString()});
    snap["project_title"] = proj["title"];
    std::string base = "log-" + snapshotId.substr(0, 8) + "-v" + std::to_string(snap["version"].asInt());
    Json::Value target; target["snapshot_id"] = snapshotId; target["format"] = format; audit(a, "snapshot.export", target);
    if (format == "json") { mime = "application/json; charset=utf-8"; fileName = base + ".json"; Json::Value meta; meta["project"] = snap["frozen_metadata"]["project_title"]; meta["snapshot_version"] = snap["version"]; meta["scope"] = snap["scope"]; meta["character_map"] = snapshotMap(events,snap["frozen_metadata"]["character_map"]); return json::dump(toNativeJson(events, meta), true); }
    if (format == "txt") { mime = "text/plain; charset=utf-8"; fileName = base + ".txt"; return toPlainText(events); }
    if (format == "sealdice_txt") { mime = "text/plain; charset=utf-8"; fileName = base + ".sealdice.txt"; return makeSealDiceTextAdapter()->exportText(events); }
    if (format == "sealdice") { mime = "application/json; charset=utf-8"; fileName = base + ".sealdice.json"; return json::dump(toSealDiceJson(events), true); }
    if (format == "html") { mime = "text/html; charset=utf-8"; fileName = base + ".html"; return renderStyledHtml(snap, events, Json::Value(Json::objectValue), snapshotMap(events,snap["frozen_metadata"]["character_map"])); }
    throw badRequest("unknown export format (json|txt|sealdice_txt|html)");
}

} // namespace acerciae::logstudio
