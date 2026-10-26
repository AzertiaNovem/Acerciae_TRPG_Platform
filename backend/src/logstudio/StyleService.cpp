#include "StyleService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../knowledge/Visibility.h"

namespace acerciae::logstudio {
static DbParam opt(const std::string& s) { return s.empty() ? dbNull() : DbParam(s); }

Json::Value StyleService::listStyles(const ChannelAccess& a) { return db_.queryJson("SELECT * FROM visual_style_profiles WHERE channel_id=$1 ORDER BY is_default DESC, created_at", {a.channelId}); }
Json::Value StyleService::defaultStyle(const std::string& channelId) { return db_.queryOne("SELECT * FROM visual_style_profiles WHERE channel_id=$1 ORDER BY is_default DESC, created_at LIMIT 1", {channelId}); }
Json::Value StyleService::createStyle(const ChannelAccess& a, const Json::Value& body) {
    if (!a.isGm) throw forbidden("GM role required");
    auto name = json::requireStr(body, "style_name");
    bool first = db_.queryOne("SELECT count(*) AS n FROM visual_style_profiles WHERE channel_id=$1", {a.channelId})["n"].asInt() == 0;
    Json::Value palette = body["color_palette"].isArray() ? body["color_palette"] : Json::Value(Json::arrayValue);
    return db_.queryOne("INSERT INTO visual_style_profiles(channel_id, style_name, art_direction, color_palette, lighting_style, rendering_style, period_setting, reference_asset_ids, negative_constraints, aspect_ratio, is_default) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8::uuid[],$9,$10,$11) RETURNING *",
        {a.channelId, name, json::str(body, "art_direction"), json::dump(palette), json::str(body, "lighting_style"), json::str(body, "rendering_style"), json::str(body, "period_setting"), pgArrayLiteral(json::strArray(body["reference_asset_ids"])), json::str(body, "negative_constraints"), json::str(body, "aspect_ratio", "16:9"), first || json::toBool(body, "is_default")});
}
Json::Value StyleService::updateStyle(const ChannelAccess& a, const std::string& id, const Json::Value& body) {
    if (!a.isGm) throw forbidden("GM role required");
    auto cur = db_.queryOne("SELECT * FROM visual_style_profiles WHERE id=$1 AND channel_id=$2", {id, a.channelId});
    if (cur.isNull()) throw notFound("style profile not found");
    return db_.tx([&](pqxx::work& w) {
        if (json::toBool(body, "is_default")) Db::exec(w, "UPDATE visual_style_profiles SET is_default=false WHERE channel_id=$1", {a.channelId});
        return Db::queryOne(w, "UPDATE visual_style_profiles SET style_name=$3, art_direction=$4, color_palette=$5::jsonb, lighting_style=$6, rendering_style=$7, period_setting=$8, reference_asset_ids=$9::uuid[], negative_constraints=$10, aspect_ratio=$11, is_default=$12, version=version+1, updated_at=now() WHERE id=$1 AND channel_id=$2 RETURNING *",
            {id, a.channelId, json::str(body, "style_name", cur["style_name"].asString()), json::str(body, "art_direction", cur["art_direction"].asString()), json::dump(body["color_palette"].isArray() ? body["color_palette"] : cur["color_palette"]), json::str(body, "lighting_style", cur["lighting_style"].asString()), json::str(body, "rendering_style", cur["rendering_style"].asString()), json::str(body, "period_setting", cur["period_setting"].asString()),
             pgArrayLiteral(body.isMember("reference_asset_ids") ? json::strArray(body["reference_asset_ids"]) : json::strArray(cur["reference_asset_ids"])), json::str(body, "negative_constraints", cur["negative_constraints"].asString()), json::str(body, "aspect_ratio", cur["aspect_ratio"].asString()), json::toBool(body, "is_default", cur["is_default"].asBool())});
    });
}
Json::Value StyleService::listCharacterVisuals(const ChannelAccess& a) {
    return db_.queryJson("SELECT cv.*, c.name, c.kind FROM character_visual_profiles cv JOIN characters c ON c.id=cv.character_id WHERE cv.channel_id=$1" + std::string(a.isGm ? "" : " AND c.kind='pc'") + " ORDER BY c.name", {a.channelId});
}
Json::Value StyleService::upsertCharacterVisual(const ChannelAccess& a, const std::string& characterId, const Json::Value& body) {
    auto c = db_.queryOne("SELECT user_id, kind FROM characters WHERE id=$1 AND channel_id=$2", {characterId, a.channelId});
    if (c.isNull()) throw notFound("character not found");
    if (!a.isGm && (c["user_id"].isNull() || c["user_id"].asString() != a.userId)) throw forbidden("not your character");
    auto def = json::str(body, "default_asset_id");
    if (!def.empty()) { auto as = db_.queryOne("SELECT 1 AS x FROM media_assets WHERE id=$1 AND channel_id=$2 AND approval_status='approved'", {def, a.channelId}); if (as.isNull()) throw badRequest("default asset must be an approved asset of this channel"); }
    Json::Value expr = body["expressions"].isObject() ? body["expressions"] : Json::Value(Json::objectValue);
    return db_.queryOne("INSERT INTO character_visual_profiles(character_id, channel_id, description, default_asset_id, expressions, reference_asset_ids, color) VALUES($1,$2,$3,$4,$5::jsonb,$6::uuid[],$7) "
                        "ON CONFLICT (character_id) DO UPDATE SET description=coalesce(nullif($3,''), character_visual_profiles.description), default_asset_id=coalesce($4, character_visual_profiles.default_asset_id), expressions=character_visual_profiles.expressions || $5::jsonb, reference_asset_ids=CASE WHEN $8 THEN $6::uuid[] ELSE character_visual_profiles.reference_asset_ids END, color=coalesce(nullif($7,''), character_visual_profiles.color), version=character_visual_profiles.version+1, updated_at=now() RETURNING *",
        {characterId, a.channelId, json::str(body, "description"), opt(def), json::dump(expr), pgArrayLiteral(json::strArray(body["reference_asset_ids"])), json::str(body, "color"), body.isMember("reference_asset_ids")});
}
}
