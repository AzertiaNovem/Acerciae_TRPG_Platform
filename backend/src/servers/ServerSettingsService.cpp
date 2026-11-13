#include "ServerSettingsService.h"
#include "../dice/Dice.h"
#include "../ws/Notifier.h"
#include "../knowledge/Visibility.h"
#include "../core/Crypto.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../core/Text.h"
#include <algorithm>
#include "../core/NetGuard.h"
#include "AiPolicyService.h"
#include "../logstudio/MediaService.h"
#include <drogon/utils/Utilities.h>

namespace acerciae {

const std::vector<std::string>& ServerSettingsService::languages() {
    static const std::vector<std::string> l = {"en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "ru", "pt", "it"};
    return l;
}

// Point buy is not here: it is a channel option the GM turns on (channels.point_buy), next to the rule system.
static const char* FEATURES[] = {"consistency", "dice", "inspiration", "log_studio", "atmosphere", "illustrations"};
static constexpr int kFeatureCount = sizeof(FEATURES) / sizeof(FEATURES[0]);

bool ServerSettingsService::isMaintainer(const std::string& userId, const std::string& serverId) {
    auto r = db_.queryOne("SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2", {serverId, userId});
    return !r.isNull() && (r["role"].asString() == "owner" || r["role"].asString() == "admin");
}

Json::Value ServerSettingsService::row(const std::string& serverId) {
    db_.exec("INSERT INTO server_settings(server_id) VALUES($1) ON CONFLICT DO NOTHING", {serverId});
    return db_.queryOne("SELECT ss.*, s.name AS server_name FROM server_settings ss JOIN servers s ON s.id=ss.server_id WHERE ss.server_id=$1", {serverId});
}

Json::Value ServerSettingsService::publicView(const Json::Value& r, const std::string& serverId) {
    Json::Value v;
    v["server_id"] = serverId; v["name"] = r["server_name"]; v["language"] = r["language"];
    for (auto* f : FEATURES) v["features"][f] = r[std::string("feature_") + f].asBool();
    auto text = useRow(serverId, "text");
    v["llm_mode"] = text.mode == "provider" ? "live" : "mock";
    v["images_enabled"] = useRow(serverId, "image_generation").mode != "disabled";
    auto& pol = v["policy"];
    pol["join_policy"] = r["join_policy"]; pol["channel_creation"] = r["channel_creation"];
    pol["guest_invites"] = r["guest_invites"]; pol["main_chat_spectators"] = r["main_chat_spectators"];
    return v;
}

Json::Value ServerSettingsService::get(const Principal& p, const std::string& serverId) {
    auth_.requireServerMember(p.userId, serverId);
    auto r = row(serverId);
    if (r.isNull()) throw notFound("server not found");
    auto v = publicView(r, serverId);
    bool maint = isMaintainer(p.userId, serverId);
    v["is_maintainer"] = maint;
    if (!maint) return v;
    // Providers and model uses; the old single-provider view stays for older clients.
    v["ai"] = aiView(serverId);
    auto legacy = legacyAiView(serverId);
    v["llm"] = legacy["llm"]; v["image"] = legacy["image"]; v["tts"] = legacy["tts"];
    v["ai_policy"] = policy_.usage(serverId);
    v["private_endpoints_allowed"] = net::allowPrivate();
    v["updated_at"] = r["updated_at"];
    Json::Value langs(Json::arrayValue); for (auto& l : languages()) langs.append(l);
    v["languages"] = langs;
    return v;
}

Json::Value ServerSettingsService::update(const Principal& p, const std::string& serverId, const Json::Value& b) {
    auth_.requireServerAdmin(p.userId, serverId);
    auto cur = row(serverId);
    auto str = [&](const Json::Value& obj, const char* k, const std::string& def) { return obj.isObject() && obj[k].isString() ? text::trim(obj[k].asString()) : def; };

    auto name = str(b, "name", cur["server_name"].asString());
    if (name.empty() || name.size() > 80) throw badRequest("server name must be 1-80 chars");
    auto language = str(b, "language", cur["language"].asString());
    if (std::find(languages().begin(), languages().end(), language) == languages().end()) throw badRequest("unsupported language");

    // AI policy
    const Json::Value& pol = b["ai_policy"];
    auto num64 = [&](const char* k, long long def, long long lo, long long hi) -> long long {
        if (!pol.isObject() || !pol.isMember(k)) return def;
        const auto& v = pol[k];
        if (!v.isNumeric()) throw badRequest(std::string(k) + " must be a number");
        double d = v.asDouble();
        if (d < lo || d > hi) throw badRequest(std::string(k) + " must be between " + std::to_string(lo) + " and " + std::to_string(hi));
        return (long long)d;
    };
    long long tokenBudget = num64("token_budget", cur["ai_token_budget"].asInt64(), 0, 1000000000000LL);
    long long imageBudget = num64("image_budget", cur["ai_image_budget"].asInt64(), 0, 10000000);
    long long maxConcurrent = num64("max_concurrent", cur["ai_max_concurrent"].asInt64(), 1, 64);
    auto period = str(pol, "period", cur["ai_budget_period"].asString());
    if (period != "month" && period != "total") throw badRequest("period must be month or total");
    bool resetUsage = json::toBool(pol, "reset_usage", false);

    // Server policy: joining, channel creation, guests, Main Chat spectators
    const Json::Value& sp = b["policy"];
    auto joinPolicy = str(sp, "join_policy", cur["join_policy"].asString());
    if (joinPolicy != "open" && joinPolicy != "invite" && joinPolicy != "closed") throw badRequest("join_policy must be open, invite or closed");
    auto channelCreation = str(sp, "channel_creation", cur["channel_creation"].asString());
    if (channelCreation != "members" && channelCreation != "maintainers") throw badRequest("channel_creation must be members or maintainers");
    bool guestInvites = json::toBool(sp, "guest_invites", cur["guest_invites"].asBool());
    bool spectators = json::toBool(sp, "main_chat_spectators", cur["main_chat_spectators"].asBool());

    // Older clients still send {llm, image, tts}: translated to providers and uses (validated before anything is written).
    applyLegacyAi(p, serverId, b);

    bool feat[kFeatureCount];
    for (int i = 0; i < kFeatureCount; ++i) feat[i] = json::toBool(b["features"], FEATURES[i], cur[std::string("feature_") + FEATURES[i]].asBool());

    db_.tx([&](pqxx::work& w) {
        Db::exec(w, "UPDATE servers SET name=$2 WHERE id=$1", {serverId, name});
        Db::exec(w, "UPDATE server_settings SET language=$2, feature_consistency=$3, feature_dice=$4, feature_inspiration=$5, feature_log_studio=$6, updated_by=$7, updated_at=now(), "
                    "ai_token_budget=$8, ai_image_budget=$9, ai_budget_period=$10, ai_max_concurrent=$11 WHERE server_id=$1",
            {serverId, language, feat[0], feat[1], feat[2], feat[3], p.userId, (int64_t)tokenBudget, (int64_t)imageBudget, period, (int64_t)maxConcurrent});
        Db::exec(w, "UPDATE server_settings SET join_policy=$2, channel_creation=$3, guest_invites=$4, main_chat_spectators=$5 WHERE server_id=$1",
                 {serverId, joinPolicy, channelCreation, guestInvites, spectators});
        Db::exec(w, "UPDATE server_settings SET feature_atmosphere=$2, feature_illustrations=$3 WHERE server_id=$1", {serverId, feat[4], feat[5]});
        if (resetUsage) Db::exec(w, "UPDATE server_settings SET ai_usage_reset_at=now() WHERE server_id=$1", {serverId});
    });
    auto fresh = row(serverId);
    notifier_.serverSettingsChanged(serverId, publicView(fresh, serverId));
    return get(p, serverId);
}

bool ServerSettingsService::featureEnabled(const std::string& serverId, const std::string& feature) {
    if (std::find(std::begin(FEATURES), std::end(FEATURES), feature) == std::end(FEATURES)) return false;
    auto r = db_.queryOne("SELECT feature_" + feature + " AS enabled FROM server_settings WHERE server_id=$1", {serverId});
    return r.isNull() ? feature != "atmosphere" : r["enabled"].asBool();   // Automatic atmosphere generation is opt-in, including before the settings row exists.
}
std::string ServerSettingsService::language(const std::string& serverId) {
    auto r = db_.queryOne("SELECT language FROM server_settings WHERE server_id=$1", {serverId});
    return r.isNull() ? "en" : r["language"].asString();
}
void ServerSettingsService::requireFeature(const std::string& serverId, const std::string& feature) {
    if (!featureEnabled(serverId, feature)) throw ApiError(403, "feature_disabled", "This feature is turned off by the server maintainer");
}

// ---- dice text groups --------------------------------------------------------------------------------
Json::Value ServerSettingsService::builtinTexts() {
    Json::Value v; Json::Value keys(Json::arrayValue);
    for (auto& k : dice::textKeys()) keys.append(k);
    v["keys"] = keys; v["en"] = dice::builtinTexts("en"); v["zh"] = dice::builtinTexts("zh");
    return v;
}
void ServerSettingsService::validateTexts(const Json::Value& texts) {
    if (!texts.isObject()) throw badRequest("texts must be an object of key -> template");
    auto keys = dice::textKeys();
    auto checkOne = [](const std::string& k, const Json::Value& v) {
        if (!v.isString()) throw badRequest("text for " + k + " must be a string or a list of strings");
        if (v.asString().size() > 500) throw badRequest("text for " + k + " is too long (max 500)");
    };
    for (auto& k : texts.getMemberNames()) {
        if (std::find(keys.begin(), keys.end(), k) == keys.end()) throw badRequest("unknown text key: " + k);
        const auto& v = texts[k];
        if (v.isArray()) {
            // Several templates for one reply: the dice pick one at random each time.
            if (v.size() > 20) throw badRequest("text for " + k + " has too many templates (max 20)");
            for (const auto& item : v) checkOne(k, item);
        } else checkOne(k, v);
    }
}
// Empty templates are dropped; a list left with one template is stored as that template.
static Json::Value cleanTexts(const Json::Value& texts) {
    Json::Value out(Json::objectValue);
    for (auto& k : texts.getMemberNames()) {
        const auto& v = texts[k];
        if (v.isArray()) {
            Json::Value list(Json::arrayValue);
            for (const auto& item : v) if (!item.asString().empty()) list.append(item);
            if (list.size() == 1) out[k] = list[0]; else if (!list.empty()) out[k] = list;
        } else if (!v.asString().empty()) out[k] = v;
    }
    return out;
}
static std::string diceName(const Json::Value& b, const std::string& current) {
    auto name = text::trim(json::str(b, "dice_name", current));
    if (name.size() > 60 || name.find_first_of("\r\n\t") != std::string::npos) throw badRequest("the dice name must be at most 60 bytes on one line");
    return name;
}
// The dice avatar, sent like a user avatar: a PNG or JPEG data URL of at most 128 KiB and 512 x 512 pixels.
static void parseDiceAvatar(const std::string& data, std::string& base64, std::string& mime) {
    auto comma = data.find(',');
    auto prefix = data.substr(0, comma);
    if (data.size() > 180000 || comma == std::string::npos || (prefix != "data:image/png;base64" && prefix != "data:image/jpeg;base64"))
        throw badRequest("the dice avatar must be a PNG or JPEG under 128 KiB");
    auto encoded = data.substr(comma + 1);
    auto bytes = drogon::utils::base64Decode(encoded);
    if (bytes.empty() || bytes.size() > 131072 || drogon::utils::base64Encode(bytes) != encoded) throw badRequest("invalid dice avatar encoding");
    mime = logstudio::MediaService::sniffMime(bytes, "avatar");
    int width = 0, height = 0;
    logstudio::MediaService::probeDimensions(bytes, mime, width, height);
    if (prefix != "data:" + mime + ";base64" || width < 1 || height < 1 || width > 512 || height > 512) throw badRequest("the dice avatar must be at most 512 by 512 pixels");
    base64 = encoded;
}
static const char* kGroupColumns = "id, name, base, texts, dice_name, avatar_version, updated_at";

Json::Value ServerSettingsService::listTextGroups(const Principal& p, const std::string& serverId) {
    auth_.requireServerMember(p.userId, serverId);
    return db_.queryJson("SELECT g.id, g.name, g.base, g.texts, g.dice_name, g.avatar_version, g.updated_at, u.display_name AS created_by_name FROM dice_text_groups g LEFT JOIN users u ON u.id=g.created_by WHERE g.server_id=$1 ORDER BY g.created_at", {serverId});
}
Json::Value ServerSettingsService::createTextGroup(const Principal& p, const std::string& serverId, const Json::Value& b) {
    auth_.requireServerAdmin(p.userId, serverId);
    auto name = text::trim(json::requireStr(b, "name"));
    if (name.empty() || name.size() > 60) throw badRequest("name must be 1-60 chars");
    auto base = json::str(b, "base", "en"); if (base != "en" && base != "zh") throw badRequest("base must be en or zh");
    Json::Value texts = b.isMember("texts") ? b["texts"] : Json::Value(Json::objectValue);
    validateTexts(texts);
    auto dname = diceName(b, "");
    std::string avatar, mime;
    if (!json::str(b, "avatar_data", "").empty()) parseDiceAvatar(b["avatar_data"].asString(), avatar, mime);
    auto n = db_.queryOne("SELECT count(*) AS n FROM dice_text_groups WHERE server_id=$1", {serverId});
    if (n["n"].asInt() >= 50) throw badRequest("at most 50 text groups per server");
    try {
        return db_.queryOne(std::string("INSERT INTO dice_text_groups(server_id, name, base, texts, created_by, dice_name, avatar_data, avatar_mime, avatar_version) "
            "VALUES($1,$2,$3,$4::jsonb,$5,$6,NULLIF($7,''),NULLIF($8,''),CASE WHEN $7='' THEN 0 ELSE 1 END) RETURNING ") + kGroupColumns,
            {serverId, name, base, json::dump(cleanTexts(texts)), p.userId, dname, avatar, mime});
    } catch (const pqxx::unique_violation&) { throw conflict("a text group with that name already exists"); }
}
Json::Value ServerSettingsService::updateTextGroup(const Principal& p, const std::string& serverId, const std::string& groupId, const Json::Value& b) {
    auth_.requireServerAdmin(p.userId, serverId);
    if (!Visibility::isUuid(groupId)) throw notFound("text group not found");
    auto cur = db_.queryOne("SELECT * FROM dice_text_groups WHERE id=$1 AND server_id=$2", {groupId, serverId});
    if (cur.isNull()) throw notFound("text group not found");
    auto name = text::trim(json::str(b, "name", cur["name"].asString()));
    if (name.empty() || name.size() > 60) throw badRequest("name must be 1-60 chars");
    auto base = json::str(b, "base", cur["base"].asString()); if (base != "en" && base != "zh") throw badRequest("base must be en or zh");
    Json::Value texts = b.isMember("texts") ? b["texts"] : cur["texts"];
    validateTexts(texts);
    auto dname = diceName(b, cur["dice_name"].asString());
    // avatar_data: a data URL replaces the avatar, "" removes it, absent leaves it as it is.
    bool avatarChange = b.isMember("avatar_data");
    std::string avatar, mime;
    if (avatarChange && !b["avatar_data"].asString().empty()) parseDiceAvatar(b["avatar_data"].asString(), avatar, mime);
    try {
        return db_.queryOne(std::string("UPDATE dice_text_groups SET name=$3, base=$4, texts=$5::jsonb, dice_name=$6, updated_at=now()") +
            (avatarChange ? ", avatar_data=NULLIF($7,''), avatar_mime=NULLIF($8,''), avatar_version=avatar_version+1" : "") +
            " WHERE id=$1 AND server_id=$2 RETURNING " + kGroupColumns,
            avatarChange ? DbParams{groupId, serverId, name, base, json::dump(cleanTexts(texts)), dname, avatar, mime}
                         : DbParams{groupId, serverId, name, base, json::dump(cleanTexts(texts)), dname});
    } catch (const pqxx::unique_violation&) { throw conflict("a text group with that name already exists"); }
}
ServerSettingsService::DiceAvatar ServerSettingsService::diceAvatar(const Principal& p, const std::string& groupId) {
    if (!Visibility::isUuid(groupId)) throw notFound("no dice avatar");
    auto r = db_.queryOne("SELECT g.avatar_data, g.avatar_mime, g.avatar_version FROM dice_text_groups g "
        "JOIN server_members m ON m.server_id=g.server_id AND m.user_id=$2 WHERE g.id=$1 AND g.avatar_data IS NOT NULL", {groupId, p.userId});
    if (r.isNull()) throw notFound("no dice avatar");
    return {r["avatar_mime"].asString(), drogon::utils::base64Decode(r["avatar_data"].asString()), r["avatar_version"].asInt()};
}
Json::Value ServerSettingsService::deleteTextGroup(const Principal& p, const std::string& serverId, const std::string& groupId) {
    auth_.requireServerAdmin(p.userId, serverId);
    if (!Visibility::isUuid(groupId)) throw notFound("text group not found");
    db_.tx([&](pqxx::work& w) {
        Db::exec(w, "UPDATE channels SET dice_text_group='' WHERE server_id=$1 AND dice_text_group=$2", {serverId, groupId});
        Db::exec(w, "DELETE FROM dice_text_groups WHERE id=$1 AND server_id=$2", {groupId, serverId});
    });
    Json::Value v; v["ok"] = true; return v;
}

} // namespace acerciae
