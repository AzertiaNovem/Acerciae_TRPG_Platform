#include "CharacterSpaceService.h"
#include <map>
#include "Coc7Rules.h"
#include "../servers/ServerSettingsService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../dice/Dice.h"
#include "../knowledge/Visibility.h"
#include "../logstudio/CreativeService.h"
#include "../logstudio/MediaService.h"
#include "../ws/Notifier.h"
#include <algorithm>
#include <set>

namespace acerciae {

namespace {
std::string clip(const std::string& s, size_t n) {
    if (s.size() <= n) return s;
    size_t end = n; while (end > 0 && ((unsigned char)s[end] & 0xC0) == 0x80) --end;
    return s.substr(0, end);
}
std::string str(const Json::Value& v, const char* k, size_t n) { return clip(text::trim(json::str(v, k)), n); }
int num(const Json::Value& v, int lo, int hi) { if (!v.isNumeric() || v.isBool()) return 0; int x = v.asInt(); return std::max(lo, std::min(hi, x)); }
const char* kCharacteristics[] = {"STR","CON","SIZ","DEX","APP","INT","POW","EDU","LUK"};
const char* kBackground[] = {"personal_description","ideology","significant_people","meaningful_locations","treasured_possessions","traits","injuries","phobias","arcane","encounters"};
const char* kBasic[] = {"player","occupation","age","sex","residence","birthplace"};
} // namespace

Json::Value CharacterSpaceService::normalizeRoleCard(const Json::Value& in) {
    Json::Value card(Json::objectValue); const Json::Value src = in.isObject() ? in : Json::Value(Json::objectValue);
    Json::Value basic(Json::objectValue); for (auto k : kBasic) basic[k] = str(src["basic"], k, 80); card["basic"] = basic;
    Json::Value ch(Json::objectValue); for (auto k : kCharacteristics) if (src["characteristics"].isMember(k)) ch[k] = num(src["characteristics"][k], 0, 999); card["characteristics"] = ch;
    Json::Value d(Json::objectValue);
    for (auto k : {"hp","hp_max","mp","mp_max","san","san_max","mov","build"}) if (src["derived"].isMember(k)) d[k] = num(src["derived"][k], -99, 999);
    d["db"] = str(src["derived"], "db", 12); card["derived"] = d;
    Json::Value skills(Json::objectValue); int n = 0;
    if (src["skills"].isObject()) for (auto& k : src["skills"].getMemberNames()) { if (n++ >= 200) break; auto name = clip(text::trim(k), 60); if (name.empty()) continue; skills[name] = num(src["skills"][k], 0, 999); }
    card["skills"] = skills;
    // Point-buy mode (server feature coc7_points): the chosen career with its option picks and specialties, and
    // per-skill career/hobby/growth points. Totals are recomputed from these on save.
    if (src["career"].isObject()) {
        Json::Value cr; cr["name"] = str(src["career"], "name", 80);
        cr["choices"] = Json::Value(Json::arrayValue);
        for (const auto& g : src["career"]["choices"]) { if (cr["choices"].size() >= 8) break; Json::Value picks(Json::arrayValue); for (const auto& x : g) if (x.isString() && picks.size() < 8) { auto v = clip(text::trim(x.asString()), 60); if (!v.empty()) picks.append(v); } cr["choices"].append(picks); }
        cr["specialties"] = Json::Value(Json::arrayValue);
        // Slots keep their positions: an empty slot stays empty instead of pulling later ones forward.
        for (const auto& x : src["career"]["specialties"]) if (cr["specialties"].size() < 12) cr["specialties"].append(x.isString() ? clip(text::trim(x.asString()), 60) : std::string());
        while (!cr["specialties"].empty() && cr["specialties"][cr["specialties"].size() - 1].asString().empty()) { Json::Value last; cr["specialties"].removeIndex(cr["specialties"].size() - 1, &last); }
        card["career"] = cr;
    }
    if (src["skill_points"].isObject()) {
        Json::Value sp(Json::objectValue); int m = 0;
        for (auto& k : src["skill_points"].getMemberNames()) {
            if (m++ >= 200) break; auto name = clip(text::trim(k), 60); if (name.empty()) continue;
            const Json::Value& v = src["skill_points"][k]; Json::Value e;
            for (auto f : {"career", "hobby", "growth"}) e[f] = v.isObject() && v[f].isNumeric() ? num(v[f], 0, 999) : 0;
            if (v.isObject() && v["base"].isNumeric()) e["base"] = num(v["base"], 0, 99);
            sp[name] = e;
        }
        card["skill_points"] = sp;
    }
    Json::Value bg(Json::objectValue); for (auto k : kBackground) bg[k] = str(src["background"], k, 2000); card["background"] = bg;
    Json::Value items(Json::arrayValue);
    for (const auto& it : src["items"]) { if (items.size() >= 60) break; Json::Value x; x["name"] = it.isString() ? clip(text::trim(it.asString()), 80) : str(it, "name", 80); if (x["name"].asString().empty()) continue; x["note"] = it.isObject() ? str(it, "note", 300) : ""; x["qty"] = it.isObject() && it["qty"].isNumeric() ? num(it["qty"], 0, 9999) : 1; items.append(x); }
    card["items"] = items;
    Json::Value w(Json::objectValue); for (auto k : {"cash","assets","spending_level"}) w[k] = str(src["wealth"], k, 120); card["wealth"] = w;
    return card;
}

Json::Value CharacterSpaceService::mirrorAttrs(const Json::Value& attrsIn, const Json::Value& card) {
    Json::Value attrs = attrsIn.isObject() ? attrsIn : Json::Value(Json::objectValue);
    auto put = [&](const std::string& raw, int v) { auto key = dice::storedKey(attrs, raw); if (key.empty()) key = dice::canonicalName(raw); if (key.empty()) return; attrs[key] = v; };
    for (auto& k : card["characteristics"].getMemberNames()) put(k, card["characteristics"][k].asInt());
    for (auto& k : {"hp","mp","san","mov"}) if (card["derived"].isMember(k)) put(std::string(k), card["derived"][k].asInt());
    // Two spellings of one skill ("侦查" and "Spot Hidden") mirror once, with the higher value, whatever their order.
    std::map<std::string, std::pair<std::string, int>> best;
    for (auto& k : card["skills"].getMemberNames()) {
        auto canon = dice::canonicalName(k); int v = card["skills"][k].asInt();
        auto it = best.find(canon);
        if (it == best.end() || v > it->second.second) best[canon] = {k, v};
    }
    for (auto& [canon, kv] : best) put(kv.first, kv.second);
    return attrs;
}
std::string CharacterSpaceService::normalizeSubtitle(const std::string& s) {
    auto t = text::upper(text::trim(s)); std::string out;
    for (unsigned char c : t) { if (isalnum(c) || c == '_' || c == '-' || c >= 0x80) out += (char)c; else if (c == ' ') out += '_'; }
    return clip(out, 30);
}
std::string CharacterSpaceService::buildPrompt(const std::string& appearance, const std::string& era, const std::string& when, const std::string& slot, const std::string& subtitle) {
    std::string p = text::trim(appearance);
    if (!era.empty()) p += ". Period: " + era;
    if (!when.empty()) p += ". Moment in the story: " + when;
    if (slot == "avatar") p += ". Framing: head-and-shoulders avatar, square, centred face, plain background.";
    else if (slot == "portrait") p += ". Framing: main character portrait, waist-up, neutral expression, consistent identity.";
    else p += ". Framing: full-body visual-novel standee on a plain background, expression/pose: " + (subtitle.empty() ? std::string("IDLE") : subtitle) + ". Keep the same face, hair and attire as the main portrait.";
    return clip(p, 5000);
}

Json::Value CharacterSpaceService::characterFor(const ChannelAccess& a, const std::string& characterId, bool write) {
    auto c = db_.queryOne("SELECT c.*, u.display_name AS player_name FROM characters c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.channel_id=$2", {characterId, a.channelId});
    if (c.isNull()) throw notFound("character not found");
    bool owner = c["user_id"].isString() && c["user_id"].asString() == a.userId;
    if (!a.isGm && c["kind"].asString() == "npc") throw notFound("character not found");
    if (write && !a.isGm && !owner) throw forbidden("only the Keeper or the character's actor may edit this character");
    c["editable"] = a.isGm || owner;
    return c;
}

bool CharacterSpaceService::pointsMode(const ChannelAccess& a) { return settings_.featureEnabled(a.serverId, "coc7_points"); }
Json::Value CharacterSpaceService::pointsReport(const ChannelAccess& a, const Json::Value& card) {
    Json::Value rep; rep["enabled"] = pointsMode(a);
    if (!rep["enabled"].asBool()) return rep;
    rep["language"] = settings_.language(a.serverId);   // skill names are shown in the server language
    Json::Value copy = card; auto r = coc7::apply(copy);
    for (auto& k : r.getMemberNames()) rep[k] = r[k];
    return rep;
}

Json::Value CharacterSpaceService::space(const ChannelAccess& a, const std::string& characterId) {
    auto c = characterFor(a, characterId, false);
    Json::Value out; out["character"] = c;
    out["character"]["role_card"] = normalizeRoleCard(c["role_card"]);
    auto asset = [&](const Json::Value& id) { if (!id.isString()) return Json::Value(); return db_.queryOne("SELECT id, version, mime, width, height, source_type, approval_status FROM media_assets WHERE id=$1 AND channel_id=$2", {id.asString(), a.channelId}); };
    out["avatar"] = asset(c["avatar_asset_id"]); out["portrait"] = asset(c["portrait_asset_id"]);
    out["subtitles"] = Json::Value(Json::arrayValue);
    auto vis = db_.queryOne("SELECT expressions, description, color FROM character_visual_profiles WHERE character_id=$1", {characterId});
    if (!vis.isNull() && vis["expressions"].isObject()) for (auto& k : vis["expressions"].getMemberNames()) { auto as = asset(vis["expressions"][k]); if (as.isNull()) continue; as["subtitle"] = k; out["subtitles"].append(as); }
    out["jobs"] = db_.queryJson("SELECT id, kind, status, error, params->'attach' AS attach, created_at, finished_at FROM asset_generation_jobs WHERE channel_id=$1 AND character_id=$2 AND params ? 'attach' ORDER BY created_at DESC LIMIT 12", {a.channelId, characterId});
    auto ch = db_.queryOne("SELECT c.era, s.narrative_time FROM channels c LEFT JOIN scenes s ON s.id=c.current_scene_id WHERE c.id=$1", {a.channelId});
    out["era"] = ch["era"]; out["narrative_time"] = ch["narrative_time"];
    out["attrs"] = c["sheet"]["attrs"].isObject() ? c["sheet"]["attrs"] : Json::Value(Json::objectValue);
    out["generation_available"] = creative_.available(a.channelId);
    out["points"] = pointsReport(a, out["character"]["role_card"]);
    return out;
}

Json::Value CharacterSpaceService::updateCard(const ChannelAccess& a, const std::string& characterId, const Json::Value& body) {
    auto c = characterFor(a, characterId, true);
    auto card = body.isMember("role_card") ? normalizeRoleCard(body["role_card"]) : normalizeRoleCard(c["role_card"]);
    if (pointsMode(a) && !a.isGm) {
        // Growth points record improvement the Keeper granted (or .en rolled): a player cannot set them.
        auto before = normalizeRoleCard(c["role_card"]);
        for (auto& k : card["skill_points"].getMemberNames()) {
            const auto& old = before["skill_points"];
            card["skill_points"][k]["growth"] = old.isMember(k) ? old[k]["growth"] : Json::Value(0);
        }
    }
    if (pointsMode(a)) {
        auto rep = coc7::apply(card);
        if (!rep["violations"].empty()) {
            std::string msg; for (const auto& v : rep["violations"]) msg += (msg.empty() ? "" : "; ") + v["message"].asString();
            throw ApiError(400, "points_rule", msg);
        }
    }
    Json::Value sheet = c["sheet"].isObject() ? c["sheet"] : Json::Value(Json::objectValue);
    sheet["attrs"] = mirrorAttrs(sheet["attrs"], card);
    auto name = clip(text::trim(json::str(body, "name", c["name"].asString())), 80); if (name.empty()) throw badRequest("name required");
    auto row = db_.queryOne("UPDATE characters SET name=$2, speaking_style=$3, bio=$4, role_card=$5::jsonb, sheet=$6::jsonb, updated_at=now() WHERE id=$1 RETURNING *",
        {characterId, name, clip(json::str(body, "speaking_style", c["speaking_style"].asString()), 400), clip(json::str(body, "bio", c["bio"].asString()), 6000), json::dump(card), json::dump(sheet)});
    db_.exec("UPDATE entities SET name=$2 WHERE character_id=$1 AND player_group_id IS NULL AND name<>$2", {characterId, name});
    notifier_.characterUpdated(a.channelId, row);
    return space(a, characterId);
}

Json::Value CharacterSpaceService::updateAppearance(const ChannelAccess& a, const std::string& characterId, const Json::Value& body) {
    auto c = characterFor(a, characterId, true);
    auto mode = json::str(body, "asset_mode", c["asset_mode"].asString());
    if (mode != "uploaded" && mode != "generated") throw badRequest("asset_mode must be uploaded or generated");
    auto prompt = clip(text::trim(json::str(body, "appearance_prompt", c["appearance_prompt"].asString())), 3000);
    auto row = db_.queryOne("UPDATE characters SET asset_mode=$2, appearance_prompt=$3, updated_at=now() WHERE id=$1 RETURNING *", {characterId, mode, prompt});
    db_.exec("INSERT INTO character_visual_profiles(character_id, channel_id, description) VALUES($1,$2,$3) ON CONFLICT (character_id) DO UPDATE SET description=CASE WHEN $3<>'' THEN $3 ELSE character_visual_profiles.description END, version=character_visual_profiles.version+1, updated_at=now()", {characterId, a.channelId, prompt});
    notifier_.characterUpdated(a.channelId, row);
    return space(a, characterId);
}

void CharacterSpaceService::attach(const std::string& channelId, const std::string& characterId, const std::string& slot, const std::string& subtitle, const std::string& assetId) {
    if (slot == "avatar") db_.exec("UPDATE characters SET avatar_asset_id=$2, updated_at=now() WHERE id=$1", {characterId, assetId});
    else if (slot == "portrait") {
        db_.exec("UPDATE characters SET portrait_asset_id=$2, updated_at=now() WHERE id=$1", {characterId, assetId});
        db_.exec("INSERT INTO character_visual_profiles(character_id, channel_id, default_asset_id) VALUES($1,$2,$3) ON CONFLICT (character_id) DO UPDATE SET default_asset_id=$3, version=character_visual_profiles.version+1, updated_at=now()", {characterId, channelId, assetId});
    } else {
        Json::Value e(Json::objectValue); e[subtitle] = assetId;
        db_.exec("INSERT INTO character_visual_profiles(character_id, channel_id, expressions) VALUES($1,$2,$3::jsonb) ON CONFLICT (character_id) DO UPDATE SET expressions=character_visual_profiles.expressions || $3::jsonb, version=character_visual_profiles.version+1, updated_at=now()", {characterId, channelId, json::dump(e)});
    }
}

Json::Value CharacterSpaceService::uploadAsset(const ChannelAccess& a, const std::string& characterId, const std::string& slotIn, const std::string& subtitleIn, const std::string& fileName, const std::string& bytes) {
    auto c = characterFor(a, characterId, true);
    auto slot = text::lower(text::trim(slotIn)); auto subtitle = normalizeSubtitle(subtitleIn);
    if (slot != "avatar" && slot != "portrait" && slot != "subtitle") throw badRequest("slot must be avatar, portrait or subtitle");
    if (slot == "subtitle" && subtitle.empty()) throw badRequest("subtitle required (e.g. IDLE, SAY, FIGHT)");
    Json::Value meta; meta["asset_type"] = slot == "subtitle" ? "standee" : "portrait"; meta["character_id"] = characterId; meta["expression"] = slot == "subtitle" ? subtitle : slot;
    meta["name"] = c["name"].asString() + " · " + (slot == "subtitle" ? subtitle : slot);
    auto asset = media_.upload(a, fileName, bytes, "", meta);
    if (asset["mime"].asString().rfind("image/", 0) != 0) { media_.remove(a, asset["id"].asString()); throw badRequest("an image is required"); }
    attach(a.channelId, characterId, slot, subtitle, asset["id"].asString());
    notifier_.characterUpdated(a.channelId, db_.queryOne("SELECT * FROM characters WHERE id=$1", {characterId}));
    return space(a, characterId);
}

Json::Value CharacterSpaceService::generate(const ChannelAccess& a, const std::string& characterId, const Json::Value& body) {
    auto c = characterFor(a, characterId, true);
    if (c["asset_mode"].asString() != "generated") throw conflict("switch the character to generated mode first");
    auto appearance = text::trim(c["appearance_prompt"].asString());
    auto ch = db_.queryOne("SELECT c.era, s.narrative_time FROM channels c LEFT JOIN scenes s ON s.id=c.current_scene_id WHERE c.id=$1", {a.channelId});
    std::vector<std::pair<std::string, std::string>> targets;   // slot, subtitle
    std::set<std::string> slots; for (auto& s : json::strArray(body["slots"])) slots.insert(text::lower(s));
    if (slots.count("portrait")) targets.push_back({"portrait", ""});
    if (slots.count("avatar")) targets.push_back({"avatar", ""});
    std::set<std::string> seen; for (auto& s : json::strArray(body["subtitles"])) { auto n = normalizeSubtitle(s); if (!n.empty() && seen.insert(n).second && seen.size() <= 12) targets.push_back({"subtitle", n}); }
    if (targets.empty()) throw badRequest("choose at least one of portrait, avatar or a subtitle");
    if (appearance.empty() && (slots.count("portrait") || slots.count("avatar"))) throw badRequest("write the appearance prompt first");
    if (!seen.empty() && !slots.count("portrait") && json::str(c, "portrait_asset_id").empty()) throw badRequest("generate or upload the main portrait before generating poses");
    std::string portraitJob;
    Json::Value out; out["jobs"] = Json::Value(Json::arrayValue);
    for (auto& [slot, sub] : targets) {
        auto prompt = buildPrompt(appearance, json::str(ch, "era"), json::str(ch, "narrative_time"), slot, sub);
        auto job = creative_.createForCharacter(a, c, slot == "subtitle" ? "standee" : slot, slot, sub, prompt, json::toBool(body, "allow_cloud"), slot == "subtitle" ? portraitJob : "");
        if (slot == "portrait") portraitJob = job["id"].asString();
        out["jobs"].append(job);
    }
    out["space"] = space(a, characterId);
    return out;
}

Json::Value CharacterSpaceService::removeAsset(const ChannelAccess& a, const std::string& characterId, const std::string& assetId) {
    characterFor(a, characterId, true);
    if (!Visibility::isUuid(assetId)) throw badRequest("invalid asset id");
    db_.tx([&](pqxx::work& w) {
        Db::exec(w, "UPDATE characters SET avatar_asset_id=NULL WHERE id=$1 AND avatar_asset_id=$2", {characterId, assetId});
        Db::exec(w, "UPDATE characters SET portrait_asset_id=NULL WHERE id=$1 AND portrait_asset_id=$2", {characterId, assetId});
        Db::exec(w, "UPDATE character_visual_profiles SET default_asset_id=NULL WHERE character_id=$1 AND default_asset_id=$2", {characterId, assetId});
        auto vis = Db::queryOne(w, "SELECT expressions FROM character_visual_profiles WHERE character_id=$1", {characterId});
        if (!vis.isNull() && vis["expressions"].isObject()) { Json::Value e(Json::objectValue); for (auto& k : vis["expressions"].getMemberNames()) if (vis["expressions"][k].asString() != assetId) e[k] = vis["expressions"][k]; Db::exec(w, "UPDATE character_visual_profiles SET expressions=$2::jsonb WHERE character_id=$1", {characterId, json::dump(e)}); }
    });
    try { media_.remove(a, assetId); } catch (const ApiError& e) { if (e.status() != 404 && e.status() != 403) throw; }
    notifier_.characterUpdated(a.channelId, db_.queryOne("SELECT * FROM characters WHERE id=$1", {characterId}));
    return space(a, characterId);
}

} // namespace acerciae
