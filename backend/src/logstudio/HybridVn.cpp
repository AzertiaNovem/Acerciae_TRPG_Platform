#include "PresentationService.h"
#include "MediaService.h"
#include "../core/Json.h"
#include "../core/Errors.h"
#include "../core/Text.h"
#include <set>

namespace acerciae::logstudio {
// A small authenticated handoff, never a server-built media archive. Downloads still use MediaService's
// permission checks and public-bucket direct delivery. No provider endpoints, keys or consent records leave here.
Json::Value PresentationService::hybrid(const ChannelAccess& a, const std::string& id, MediaService& media) {
    auto p = get(a, id); // Re-check snapshot and event visibility, including merged lines.
    const bool gmOnly = p["snapshot_scope"] == "gm_full";
    const auto availablePoses = currentStandees(a.channelId, gmOnly);
    const auto outfitPoses = outfitStandees(a.channelId, gmOnly);
    std::set<std::string> characters, scenes, voiceIds, assetKeys;
    for (const auto& e : p["events"]) {
        if (e["hidden"].asBool()) continue;
        scenes.insert(json::str(e, "scene_id"));
        if (e["speaker_character_id"].isString()) characters.insert(e["speaker_character_id"].asString());
        if (e["voice_profile_id"].isString()) voiceIds.insert(e["voice_profile_id"].asString());
        for (const auto& stage : e["character_asset_ids"]) if (stage["character_id"].isString()) characters.insert(stage["character_id"].asString());
    }
    Json::Value out; out["format"] = "acerciae-hybrid-vn-1";
    out["assets"] = Json::Value(Json::arrayValue);
    auto asset = [&](const Json::Value& value, int version) -> Json::Value {
        if (!value.isString() || value.asString().empty()) return Json::Value();
        try {
            const auto aid = value.asString();
            const auto row = media.get(a, aid);
            if (!gmOnly && row["visibility_scope"] == "gm") return Json::Value();
            MediaService::MediaMeta meta; std::string mime, name;
            if (!media.fetchRow(a, aid, version, mime, name, meta) || mime.rfind("image/", 0) != 0) return Json::Value();
            const auto key = aid + "@" + std::to_string(meta.version);
            if (assetKeys.insert(key).second) {
                Json::Value item; item["key"] = key; item["id"] = aid; item["version"] = meta.version;
                item["mime"] = mime; item["hash"] = meta.contentHash;
                out["assets"].append(item);
            }
            return key;
        } catch (const ApiError& e) {
            if (e.status() == 403 || e.status() == 404) return Json::Value();
            throw;
        }
    };
    Json::Value timeline;
    for (const auto* key : {"id", "title", "snapshot_scope", "created_at", "updated_at"}) timeline[key] = p[key];
    timeline["template"] = p["settings"]["template"];
    timeline["scenes"] = Json::Value(Json::arrayValue);
    for (const auto& scene : p["scenes"]) if (scenes.count(json::str(scene, "id"))) {
        Json::Value s;
        for (const auto* key : {"id", "title", "canonical_scene_key", "environment"}) s[key] = scene[key];
        s["background_brief"] = scene["metadata"]["background_brief"];
        s["background"] = asset(scene["background_asset_id"], scene["background_asset_version"].isInt() ? scene["background_asset_version"].asInt() : 0);
        if (s["background"].isNull() && p["settings"]["media_mode"] == "hybrid") s["background"] = asset(scene["metadata"]["hybrid_background_asset_id"], 0);
        timeline["scenes"].append(s);
    }
    timeline["events"] = Json::Value(Json::arrayValue);
    for (const auto& event : p["events"]) {
        Json::Value e;
        for (const auto* key : {"id", "scene_id", "hidden", "display_kind", "content", "display_text", "tts_text", "speaker_character_id", "speaker_name_override", "speaker_display_name", "speaker_role", "character_name", "dice", "style_instruction", "effect", "voice_profile_id"}) e[key] = event[key];
        e["stage"] = Json::Value(Json::arrayValue);
        if (!event["hidden"].asBool()) for (const auto& stage : event["character_asset_ids"]) {
            Json::Value s;
            for (const auto* key : {"character_id", "expression", "position", "outfit_id"}) if (stage.isMember(key)) s[key] = stage[key];
            // get() substitutes the main portrait for a missing pose. That is a preview fallback, not an
            // existing SAY/IDLE standee; leave the slot missing so the client actually paints it.
            s["image"] = Json::Value();
            auto poses = availablePoses.find(json::str(stage, "character_id"));
            const auto expression = text::lower(text::trim(json::str(stage, "expression")));
            // In an outfit: its own pose for the subtitle when it has one.
            auto worn = outfitPoses.find(json::str(stage, "outfit_id"));
            if (worn != outfitPoses.end()) {
                auto pose = worn->second.find(expression == "default" ? "" : expression);
                if (pose != worn->second.end()) { s["image"] = asset(pose->second["id"], pose->second["version"].asInt()); e["stage"].append(s); continue; }
            }
            if (poses != availablePoses.end()) {
                auto pose = poses->second.find(expression == "default" ? "" : expression);
                if (pose != poses->second.end()) s["image"] = asset(pose->second["id"], pose->second["version"].asInt());
            }
            e["stage"].append(s);
        }
        timeline["events"].append(e);
    }
    out["presentation"] = timeline;
    out["era"] = db_.queryOne("SELECT era FROM channels WHERE id=$1", {a.channelId})["era"];
    out["characters"] = Json::Value(Json::arrayValue);
    for (auto c : db_.queryJson("SELECT id,name,kind,appearance_prompt,portrait_asset_id FROM characters WHERE channel_id=$1 ORDER BY created_at", {a.channelId})) {
        if (!characters.count(json::str(c, "id"))) continue;
        c["portrait"] = asset(c["portrait_asset_id"], 0); c.removeMember("portrait_asset_id");
        out["characters"].append(c);
    }
    // Include assigned voices and the character defaults, with only synthesis configuration.
    out["voices"] = Json::Value(Json::arrayValue);
    out["cast"] = Json::Value(Json::objectValue);
    for (const auto& cid : characters) if (p["settings"]["cast"][cid].isString()) {
        out["cast"][cid] = p["settings"]["cast"][cid]; voiceIds.insert(p["settings"]["cast"][cid].asString());
    }
    if (p["settings"]["cast"]["narrator"].isString()) {
        out["cast"]["narrator"] = p["settings"]["cast"]["narrator"]; voiceIds.insert(out["cast"]["narrator"].asString());
    }
    const auto profiles = db_.queryJson("SELECT id,character_id,provider,voice_id,voice_type,language,dialect,style_instruction,synthesis_parameters FROM voice_profiles WHERE channel_id=$1 ORDER BY created_at", {a.channelId});
    if (!out["cast"].isMember("narrator")) {
        // Match TtsService's unbound narrator fallback (its voice map is ordered by profile ID).
        std::string narrator;
        for (const auto& v : profiles) if (v["character_id"].isNull() && (narrator.empty() || json::str(v, "id") < narrator)) narrator = json::str(v, "id");
        if (!narrator.empty()) { out["cast"]["narrator"] = narrator; voiceIds.insert(narrator); }
    }
    for (const auto& v : profiles)
        if (voiceIds.count(json::str(v, "id")) || characters.count(json::str(v, "character_id"))) out["voices"].append(v);
    // Keep the model's pose directions. All story text comes from the viewer-filtered presentation above.
    out["asset_needs"] = Json::Value(Json::arrayValue);
    for (const auto& job : db_.queryJson("SELECT script->'asset_needs' AS needs FROM vn_script_jobs WHERE presentation_id=$1 AND status='completed' ORDER BY created_at", {id}))
        for (const auto& n : job["needs"]) if (n["kind"] == "standee" && characters.count(json::str(n, "character_id"))) {
            Json::Value need; for (const auto* key : {"kind", "character_id", "subtitle", "brief"}) need[key] = n[key];
            out["asset_needs"].append(need);
        }
    return out;
}
}
