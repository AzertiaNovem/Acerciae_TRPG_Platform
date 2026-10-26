#include "PresentationService.h"
#include "LogStudioService.h"
#include "../ws/Notifier.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../knowledge/Visibility.h"
#include <map>
#include <set>

namespace acerciae::logstudio {

static DbParam opt(const std::string& s) { return s.empty() ? dbNull() : DbParam(s); }

Json::Value PresentationService::presentationRow(const ChannelAccess& a, const std::string& id) {
    auto p = db_.queryOne("SELECT p.*, s.scope AS snapshot_scope, s.scope_character_id FROM log_presentations p JOIN log_snapshots s ON s.id=p.snapshot_id WHERE p.id=$1 AND p.channel_id=$2", {id, a.channelId});
    if (p.isNull()) throw notFound("presentation not found");
    if (!a.isGm && p["snapshot_scope"].asString() == "gm_full") throw forbidden("built from a GM snapshot");
    if (!a.isGm && p["snapshot_scope"].asString() == "character" && std::find(a.characterIds.begin(), a.characterIds.end(), p["scope_character_id"].asString()) == a.characterIds.end()) throw forbidden("another character's perspective");
    return p;
}
bool PresentationService::canEdit(const ChannelAccess& a, const Json::Value& p) { return a.isGm || p["created_by"].asString() == a.userId; }
void PresentationService::touch(const std::string& id, const std::string& channelId, const std::string& what) {
    db_.exec("UPDATE log_presentations SET version=version+1, updated_at=now() WHERE id=$1", {id});
    Json::Value n; n["kind"] = "presentation.updated"; n["presentation_id"] = id; n["what"] = what; notifier_.moduleUpdated(channelId, n);
}

Json::Value PresentationService::list(const ChannelAccess& a, const std::string& projectId) {
    std::string sql = "SELECT p.*, s.scope AS snapshot_scope, s.version AS snapshot_version, (SELECT count(*) FROM presentation_events e WHERE e.presentation_id=p.id AND NOT e.hidden) AS line_count, (SELECT count(*) FROM presentation_events e WHERE e.presentation_id=p.id AND e.audio_asset_id IS NOT NULL) AS voiced_count FROM log_presentations p JOIN log_snapshots s ON s.id=p.snapshot_id WHERE p.channel_id=$1";
    DbParams params{a.channelId};
    if (!projectId.empty()) { params.push_back(projectId); sql += " AND p.project_id=$2"; }
    if (!a.isGm) sql += " AND (s.scope='pl_public' OR (s.scope='character' AND s.scope_character_id = ANY(" + Visibility::uuidArray(a.characterIds) + ")))";
    return db_.queryJson(sql + " ORDER BY p.updated_at DESC", params);
}

Json::Value PresentationService::create(const ChannelAccess& a, const std::string& snapshotId, const Json::Value& body) {
    Json::Value snap; auto events = studio_.snapshotEvents(a, snapshotId, &snap);
    Json::Value settings = body.isMember("settings") && body["settings"].isObject() ? body["settings"] : Json::Value(Json::objectValue);
    if (!settings.isMember("animations_enabled")) settings["animations_enabled"] = true;
    if (!settings.isMember("typewriter_cps")) settings["typewriter_cps"] = 28;
    if (!settings.isMember("aspect")) settings["aspect"] = "16:9";
    auto pres = db_.tx([&](pqxx::work& w) {
        auto p = Db::queryOne(w, "INSERT INTO log_presentations(project_id, snapshot_id, channel_id, title, settings, style_profile_id, created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *",
            {snap["project_id"].asString(), snapshotId, a.channelId, json::str(body, "title", json::str(snap, "title", "Presentation")), json::dump(settings), opt(json::str(body, "style_profile_id")), a.userId});
        auto pid = p["id"].asString();
        // Character visual defaults (standee per character) for auto-placement.
        std::map<std::string, std::string> defaultStandee;
        for (auto& r : Db::queryJson(w, "SELECT character_id, default_asset_id FROM character_visual_profiles WHERE channel_id=$1 AND default_asset_id IS NOT NULL", {a.channelId})) defaultStandee[r["character_id"].asString()] = r["default_asset_id"].asString();
        std::string curSceneKey = "\x01"; std::string curSceneId; int scenePos = 0, pos = 0;
        std::map<std::string, std::string> sceneByKey;   // a canonical scene revisited later reuses its presentation scene
        std::vector<std::string> onStage;   // speaker character ids currently placed (max 3: left/center/right)
        for (auto& e : events) {
            if (e.sceneKey != curSceneKey) {
                curSceneKey = e.sceneKey;
                if (sceneByKey.count(e.sceneKey)) curSceneId = sceneByKey[e.sceneKey];
                else {
                    auto s = Db::queryOne(w, "INSERT INTO presentation_scenes(presentation_id, position, title, canonical_scene_key) VALUES($1,$2,$3,$4) RETURNING id", {pid, (int64_t)scenePos++, e.sceneTitle.empty() ? (e.eventType == "scene_change" ? e.content : "Scene " + std::to_string(scenePos)) : e.sceneTitle, e.sceneKey});
                    curSceneId = s["id"].asString(); sceneByKey[e.sceneKey] = curSceneId;
                }
                onStage.clear();
            }
            std::string displayKind = e.eventType == "narration" ? "narration" : e.eventType == "dice_roll" ? "dice" : e.eventType == "ooc" ? "ooc" : e.eventType == "action" ? "action" : e.eventType == "scene_change" ? "scene_change" : e.eventType == "media" ? "media" : e.eventType == "system" ? "system" : "dialogue";
            bool hidden = e.eventType == "ooc" || e.eventType == "system" || e.unrecognised;
            Json::Value placement(Json::arrayValue);
            if (!e.speakerCharacterId.empty() && (displayKind == "dialogue" || displayKind == "action")) {
                if (std::find(onStage.begin(), onStage.end(), e.speakerCharacterId) == onStage.end()) { if (onStage.size() >= 3) onStage.erase(onStage.begin()); onStage.push_back(e.speakerCharacterId); }
                static const char* slots2[] = {"left", "right"}; static const char* slots3[] = {"left", "center", "right"};
                for (size_t i = 0; i < onStage.size(); ++i) { Json::Value c; c["character_id"] = onStage[i]; c["position"] = onStage.size() == 1 ? "center" : onStage.size() == 2 ? slots2[i] : slots3[i]; c["active"] = onStage[i] == e.speakerCharacterId; c["asset_id"] = defaultStandee.count(onStage[i]) ? Json::Value(defaultStandee[onStage[i]]) : Json::Value(); c["expression"] = "default"; placement.append(c); }
            }
            int est = 1200 + (int)text::words(e.content).size() * 320 + (int)e.content.size() * 20; if (est > 20000) est = 20000;
            Db::exec(w, "INSERT INTO presentation_events(presentation_id, scene_id, position, canonical_event_id, display_kind, hidden, speaker_character_id, character_asset_ids, transition, estimated_duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)",
                {pid, curSceneId, (int64_t)pos++, e.eventId, displayKind, hidden, opt(e.speakerCharacterId), json::dump(placement), displayKind == "scene_change" ? "fade" : "none", (int64_t)est});
        }
        return p;
    });
    studio_.audit(a, "presentation.create", pres);
    return get(a, pres["id"].asString());
}

static const std::string PE_COLS = "pe.id, pe.scene_id, pe.position, pe.canonical_event_id, pe.merged_event_ids, pe.segment_index, pe.segment_text, pe.display_kind, pe.hidden, pe.speaker_character_id, pe.speaker_name_override, pe.tts_text, pe.character_asset_ids, pe.expression_ids, pe.dialogue_style, pe.voice_profile_id, pe.audio_asset_id, pe.style_instruction, pe.transition, pe.effect, pe.estimated_duration_ms, pe.actual_audio_duration_ms, pe.ai_suggestion, "
    "le.content, le.event_type, le.speaker_display_name, le.speaker_role, le.visibility_scope, le.audience, le.dice, le.media, le.sequence_number, "
    "ta.duration_ms AS audio_duration_ms, ta.word_timestamps, ta.is_mock AS audio_is_mock, ta.mime AS audio_mime, c.name AS character_name";

Json::Value PresentationService::get(const ChannelAccess& a, const std::string& id) {
    auto p = presentationRow(a, id);
    p["scenes"] = db_.queryJson("SELECT s.*, b.version AS background_current_version FROM presentation_scenes s LEFT JOIN media_assets b ON b.id=s.background_asset_id WHERE s.presentation_id=$1 ORDER BY s.position", {id});
    auto rows = db_.queryJson("SELECT " + PE_COLS + " FROM presentation_events pe LEFT JOIN log_events le ON le.id=pe.canonical_event_id LEFT JOIN tts_audio_assets ta ON ta.id=pe.audio_asset_id LEFT JOIN characters c ON c.id=pe.speaker_character_id WHERE pe.presentation_id=$1 ORDER BY pe.position", {id});
    Json::Value visible(Json::arrayValue);
    for (auto& r : rows) {
        // Canonical visibility is re-checked per viewer at read time: a GM-only line never reaches a player even
        // if a presentation was built by the GM and later shared.
        if (!LogStudioService::eventVisibleTo(a, r["visibility_scope"].isNull() ? "public" : r["visibility_scope"].asString(), json::strArray(r["audience"]))) continue;
        if (!r["segment_text"].isNull()) r["display_text"] = r["segment_text"]; else r["display_text"] = r["content"];
        if (!r["merged_event_ids"].isNull() && r["merged_event_ids"].isArray() && !r["merged_event_ids"].empty()) {
            auto ids = json::strArray(r["merged_event_ids"]);
            auto parts = db_.queryJson("SELECT content, visibility_scope, audience FROM log_events WHERE id = ANY(" + Visibility::uuidArray(ids) + ") ORDER BY sequence_number", {});
            std::string joined; for (auto& pt : parts) if (LogStudioService::eventVisibleTo(a, pt["visibility_scope"].asString(), json::strArray(pt["audience"]))) joined += (joined.empty() ? "" : "\n") + pt["content"].asString();
            r["display_text"] = joined;
        }
        if (!a.isGm) r.removeMember("ai_suggestion");
        visible.append(r);
    }
    p["events"] = visible;
    p["can_edit"] = canEdit(a, p);
    p["character_visuals"] = db_.queryJson("SELECT cv.*, c.name FROM character_visual_profiles cv JOIN characters c ON c.id=cv.character_id WHERE cv.channel_id=$1", {a.channelId});
    return p;
}
Json::Value PresentationService::update(const ChannelAccess& a, const std::string& id, const Json::Value& body) {
    auto p = presentationRow(a, id); if (!canEdit(a, p)) throw forbidden("not your presentation");
    Json::Value settings = p["settings"]; if (body.isMember("settings") && body["settings"].isObject()) for (auto it = body["settings"].begin(); it != body["settings"].end(); ++it) settings[it.name()] = *it;
    auto out = db_.queryOne("UPDATE log_presentations SET title=$2, settings=$3::jsonb, style_profile_id=$4, version=version+1, updated_at=now() WHERE id=$1 RETURNING *", {id, json::str(body, "title", p["title"].asString()), json::dump(settings), opt(json::str(body, "style_profile_id", p["style_profile_id"].isNull() ? "" : p["style_profile_id"].asString()))});
    touch(id, a.channelId, "settings"); return out;
}
Json::Value PresentationService::remove(const ChannelAccess& a, const std::string& id) {
    auto p = presentationRow(a, id); if (!canEdit(a, p)) throw forbidden("not your presentation");
    db_.exec("DELETE FROM log_presentations WHERE id=$1", {id}); Json::Value v; v["deleted"] = true; return v;
}
Json::Value PresentationService::updateScene(const ChannelAccess& a, const std::string& sceneId, const Json::Value& body) {
    auto s = db_.queryOne("SELECT s.*, p.channel_id FROM presentation_scenes s JOIN log_presentations p ON p.id=s.presentation_id WHERE s.id=$1 AND p.channel_id=$2", {sceneId, a.channelId});
    if (s.isNull()) throw notFound("scene not found");
    auto p = presentationRow(a, s["presentation_id"].asString()); if (!canEdit(a, p)) throw forbidden("not your presentation");
    auto bg = json::str(body, "background_asset_id", s["background_asset_id"].isNull() ? "" : s["background_asset_id"].asString());
    DbParam bgVer = dbNull();
    if (!bg.empty()) { auto asset = db_.queryOne("SELECT version, approval_status, asset_type FROM media_assets WHERE id=$1 AND channel_id=$2", {bg, a.channelId}); if (asset.isNull()) throw badRequest("background asset not found"); if (asset["approval_status"].asString() != "approved") throw badRequest("asset is not approved yet"); bgVer = (int64_t)asset["version"].asInt(); }
    auto bgm = json::str(body, "bgm_asset_id", s["bgm_asset_id"].isNull() ? "" : s["bgm_asset_id"].asString());
    Json::Value env = body.isMember("environment") && body["environment"].isObject() ? body["environment"] : s["environment"];
    auto out = db_.queryOne("UPDATE presentation_scenes SET title=$2, background_asset_id=$3, background_asset_version=$4, bgm_asset_id=$5, environment=$6::jsonb, transition_in=$7, locked=$8 WHERE id=$1 RETURNING *",
        {sceneId, json::str(body, "title", s["title"].asString()), opt(bg), bgVer, opt(bgm), json::dump(env), json::str(body, "transition_in", s["transition_in"].asString()), json::toBool(body, "locked", s["locked"].asBool())});
    touch(s["presentation_id"].asString(), a.channelId, "scene"); return out;
}
Json::Value PresentationService::updateEvent(const ChannelAccess& a, const std::string& eventId, const Json::Value& body) {
    auto e = db_.queryOne("SELECT pe.*, p.channel_id FROM presentation_events pe JOIN log_presentations p ON p.id=pe.presentation_id WHERE pe.id=$1 AND p.channel_id=$2", {eventId, a.channelId});
    if (e.isNull()) throw notFound("presentation event not found");
    auto p = presentationRow(a, e["presentation_id"].asString()); if (!canEdit(a, p)) throw forbidden("not your presentation");
    static const std::set<std::string> kinds = {"dialogue","narration","action","ooc","dice","scene_change","system","media"};
    auto kind = json::str(body, "display_kind", e["display_kind"].asString()); if (!kinds.count(kind)) throw badRequest("invalid display_kind");
    Json::Value assets = body.isMember("character_asset_ids") && body["character_asset_ids"].isArray() ? body["character_asset_ids"] : e["character_asset_ids"];
    for (auto& c : assets) if (c.isMember("asset_id") && c["asset_id"].isString() && !c["asset_id"].asString().empty()) { auto as = db_.queryOne("SELECT version, approval_status FROM media_assets WHERE id=$1 AND channel_id=$2", {c["asset_id"].asString(), a.channelId}); if (as.isNull()) throw badRequest("standee asset not found"); if (as["approval_status"].asString() != "approved") throw badRequest("asset is not approved yet"); c["asset_version"] = as["version"]; }
    // tts_text is the separately stored speech adaptation; it never replaces display text.
    bool clearAudio = body.isMember("tts_text") || body.isMember("voice_profile_id") || body.isMember("style_instruction");
    auto out = db_.queryOne("UPDATE presentation_events SET display_kind=$2, hidden=$3, speaker_character_id=$4, speaker_name_override=$5, tts_text=$6, character_asset_ids=$7::jsonb, expression_ids=$8::jsonb, dialogue_style=$9::jsonb, voice_profile_id=$10, style_instruction=$11, transition=$12, effect=$13, scene_id=$14, audio_asset_id = CASE WHEN $15 THEN NULL ELSE audio_asset_id END, actual_audio_duration_ms = CASE WHEN $15 THEN NULL ELSE actual_audio_duration_ms END, updated_at=now() WHERE id=$1 RETURNING *",
        {eventId, kind, json::toBool(body, "hidden", e["hidden"].asBool()), opt(json::str(body, "speaker_character_id", e["speaker_character_id"].isNull() ? "" : e["speaker_character_id"].asString())), opt(json::str(body, "speaker_name_override", e["speaker_name_override"].isNull() ? "" : e["speaker_name_override"].asString())),
         body.isMember("tts_text") ? opt(json::str(body, "tts_text")) : (e["tts_text"].isNull() ? dbNull() : DbParam(e["tts_text"].asString())), json::dump(assets), json::dump(body.isMember("expression_ids") ? body["expression_ids"] : e["expression_ids"]), json::dump(body.isMember("dialogue_style") ? body["dialogue_style"] : e["dialogue_style"]),
         opt(json::str(body, "voice_profile_id", e["voice_profile_id"].isNull() ? "" : e["voice_profile_id"].asString())), json::str(body, "style_instruction", e["style_instruction"].asString()), json::str(body, "transition", e["transition"].asString()), json::str(body, "effect", e["effect"].asString()), opt(json::str(body, "scene_id", e["scene_id"].isNull() ? "" : e["scene_id"].asString())), clearAudio});
    touch(e["presentation_id"].asString(), a.channelId, "event"); return out;
}
Json::Value PresentationService::bulkUpdateEvents(const ChannelAccess& a, const std::string& presentationId, const Json::Value& body) {
    auto p = presentationRow(a, presentationId); if (!canEdit(a, p)) throw forbidden("not your presentation");
    int n = 0; for (auto& id : json::strArray(body["event_ids"])) { updateEvent(a, id, body["patch"]); n++; }
    Json::Value out; out["updated"] = n; return out;
}
Json::Value PresentationService::splitEvent(const ChannelAccess& a, const std::string& eventId, const Json::Value& body) {
    auto e = db_.queryOne("SELECT pe.*, le.content, p.channel_id FROM presentation_events pe JOIN log_events le ON le.id=pe.canonical_event_id JOIN log_presentations p ON p.id=pe.presentation_id WHERE pe.id=$1 AND p.channel_id=$2", {eventId, a.channelId});
    if (e.isNull()) throw notFound("presentation event not found");
    auto p = presentationRow(a, e["presentation_id"].asString()); if (!canEdit(a, p)) throw forbidden("not your presentation");
    std::string content = e["segment_text"].isNull() ? e["content"].asString() : e["segment_text"].asString();
    std::vector<int> offsets; for (auto& o : body["offsets"]) if (o.isNumeric()) offsets.push_back(o.asInt());
    std::sort(offsets.begin(), offsets.end());
    std::vector<std::string> segs; size_t prev = 0;
    for (int o : offsets) { if (o <= (int)prev || o >= (int)content.size()) continue; while (o < (int)content.size() && ((unsigned char)content[o] & 0xC0) == 0x80) o++; segs.push_back(content.substr(prev, o - prev)); prev = o; }
    segs.push_back(content.substr(prev));
    if (segs.size() < 2) throw badRequest("no valid split offsets");
    db_.tx([&](pqxx::work& w) {
        auto pos = e["position"].asInt();
        Db::exec(w, "UPDATE presentation_events SET position = position + $3 WHERE presentation_id=$1 AND position > $2", {e["presentation_id"].asString(), (int64_t)pos, (int64_t)(segs.size() - 1)});
        Db::exec(w, "UPDATE presentation_events SET segment_text=$2, segment_index=0, audio_asset_id=NULL, actual_audio_duration_ms=NULL, updated_at=now() WHERE id=$1", {eventId, segs[0]});
        for (size_t i = 1; i < segs.size(); ++i)
            Db::exec(w, "INSERT INTO presentation_events(presentation_id, scene_id, position, canonical_event_id, segment_index, segment_text, display_kind, hidden, speaker_character_id, character_asset_ids, voice_profile_id, style_instruction, transition, estimated_duration_ms) SELECT presentation_id, scene_id, $2, canonical_event_id, $3, $4, display_kind, hidden, speaker_character_id, character_asset_ids, voice_profile_id, style_instruction, 'none', greatest(800, estimated_duration_ms / $5) FROM presentation_events WHERE id=$1",
                {eventId, (int64_t)(pos + i), (int64_t)i, segs[i], (int64_t)segs.size()});
    });
    touch(e["presentation_id"].asString(), a.channelId, "split"); Json::Value out; out["segments"] = (int)segs.size(); return out;
}
Json::Value PresentationService::mergeEvents(const ChannelAccess& a, const std::string& presentationId, const Json::Value& body) {
    auto p = presentationRow(a, presentationId); if (!canEdit(a, p)) throw forbidden("not your presentation");
    auto ids = json::strArray(body["event_ids"]); if (ids.size() < 2) throw badRequest("at least two event ids");
    auto rows = db_.queryJson("SELECT id, position, canonical_event_id, speaker_character_id, segment_text FROM presentation_events WHERE presentation_id=$1 AND id = ANY(" + Visibility::uuidArray(ids) + ") ORDER BY position", {presentationId});
    if ((int)rows.size() != (int)ids.size()) throw badRequest("events not found in this presentation");
    for (Json::ArrayIndex i = 1; i < rows.size(); ++i) { if (rows[i]["position"].asInt() != rows[i-1]["position"].asInt() + 1) throw badRequest("only consecutive lines can be merged"); if (rows[i]["speaker_character_id"] != rows[0]["speaker_character_id"]) throw badRequest("only lines of the same speaker can be merged"); if (!rows[i]["segment_text"].isNull() || !rows[0]["segment_text"].isNull()) throw badRequest("split segments cannot be merged"); }
    std::vector<std::string> canon; for (auto& r : rows) canon.push_back(r["canonical_event_id"].asString());
    db_.tx([&](pqxx::work& w) {
        Db::exec(w, "UPDATE presentation_events SET merged_event_ids=$2::uuid[], audio_asset_id=NULL, actual_audio_duration_ms=NULL, updated_at=now() WHERE id=$1", {rows[0]["id"].asString(), pgArrayLiteral(canon)});
        std::vector<std::string> rest; for (Json::ArrayIndex i = 1; i < rows.size(); ++i) rest.push_back(rows[i]["id"].asString());
        Db::exec(w, "DELETE FROM presentation_events WHERE id = ANY(" + Visibility::uuidArray(rest) + ")");
    });
    touch(presentationId, a.channelId, "merge"); Json::Value out; out["merged_into"] = rows[0]["id"]; return out;
}
Json::Value PresentationService::reorder(const ChannelAccess& a, const std::string& presentationId, const Json::Value& body) {
    auto p = presentationRow(a, presentationId); if (!canEdit(a, p)) throw forbidden("not your presentation");
    auto ids = json::strArray(body["event_ids"]);
    db_.tx([&](pqxx::work& w) { int pos = 0; for (auto& id : ids) Db::exec(w, "UPDATE presentation_events SET position=$3 WHERE id=$1 AND presentation_id=$2", {id, presentationId, (int64_t)pos++}); });
    touch(presentationId, a.channelId, "reorder"); Json::Value out; out["ok"] = true; return out;
}
Json::Value PresentationService::acceptSuggestion(const ChannelAccess& a, const std::string& eventId, bool accept) {
    auto e = db_.queryOne("SELECT pe.*, p.channel_id FROM presentation_events pe JOIN log_presentations p ON p.id=pe.presentation_id WHERE pe.id=$1 AND p.channel_id=$2", {eventId, a.channelId});
    if (e.isNull()) throw notFound("presentation event not found");
    auto p = presentationRow(a, e["presentation_id"].asString()); if (!canEdit(a, p)) throw forbidden("not your presentation");
    if (e["ai_suggestion"].isNull()) throw conflict("no pending suggestion");
    if (accept) {
        Json::Value patch = e["ai_suggestion"]; patch.removeMember("reason"); patch.removeMember("source");
        updateEvent(a, eventId, patch);
    }
    return db_.queryOne("UPDATE presentation_events SET ai_suggestion=NULL, updated_at=now() WHERE id=$1 RETURNING *", {eventId});
}
Json::Value PresentationService::saveProgress(const ChannelAccess& a, const std::string& presentationId, const Json::Value& body) {
    presentationRow(a, presentationId);
    db_.exec("INSERT INTO studio_audit_log(channel_id, user_id, action, target) VALUES($1,$2,'vn.progress',$3::jsonb)", {a.channelId, a.userId, json::dump(Json::Value([&] { Json::Value t; t["presentation_id"] = presentationId; t["position"] = json::toInt(body, "position", 0); return t; }()))});
    Json::Value out; out["saved"] = true; return out;
}
Json::Value PresentationService::getProgress(const ChannelAccess& a, const std::string& presentationId) {
    presentationRow(a, presentationId);
    auto r = db_.queryOne("SELECT target FROM studio_audit_log WHERE channel_id=$1 AND user_id=$2 AND action='vn.progress' AND target->>'presentation_id'=$3 ORDER BY created_at DESC LIMIT 1", {a.channelId, a.userId, presentationId});
    return r.isNull() ? Json::Value(Json::objectValue) : r["target"];
}

} // namespace
