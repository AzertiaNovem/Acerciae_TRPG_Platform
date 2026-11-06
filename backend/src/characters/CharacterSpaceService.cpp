#include "../rules/Pbta.h"
#include "CharacterSpaceService.h"
#include <map>
#include "Coc7Rules.h"
#include "Dnd2024Rules.h"
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
// The Call of Cthulhu number part of a card; everything else but `dnd` is the story part.
const char* kCocNumbers[] = {"characteristics","derived","skills","career","skill_points","wealth"};
const char* kCocMain[] = {"STR","CON","SIZ","DEX","APP","INT","POW","EDU"};
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
    // Point-buy mode (the channel's point_buy, CoC): the chosen career with its option picks and specialties, and
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
    // D&D channels: the character's build (class, species, background, scores, proficiencies …), see Dnd2024Rules.
    if (src["pbta"].isObject()) card["pbta"]=src["pbta"];
    if (src["dnd"].isObject()) card["dnd"] = dnd2024::normalize(src["dnd"]);
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
Json::Value CharacterSpaceService::numbers(const Json::Value& cardIn, const std::string& ruleSystem) {
    const auto card = normalizeRoleCard(cardIn);
    Json::Value n(Json::objectValue);
    if (ruleSystem == "dnd2024") n["dnd"] = dnd2024::normalize(card["dnd"]);
    else if (ruleSystem == "pbta") n["pbta"] = card["pbta"].isObject() ? card["pbta"] : Json::Value(Json::objectValue);
    else for (auto k : kCocNumbers) if (card.isMember(k)) n[k] = card[k];
    return n;
}
bool CharacterSpaceService::hasNumbers(const Json::Value& card, const std::string& ruleSystem) {
    return numbers(card, ruleSystem) != numbers(Json::Value(Json::objectValue), ruleSystem);
}
bool CharacterSpaceService::built(const Json::Value& cardIn, const std::string& ruleSystem) {
    const auto card = normalizeRoleCard(cardIn);
    if (ruleSystem == "dnd2024") return !dnd2024::normalize(card["dnd"])["class"].asString().empty();
    if (ruleSystem == "pbta") return card["pbta"].isObject() && card["pbta"]["book"].isString() && !card["pbta"]["book"].asString().empty();
    for (auto k : kCocMain) if (!card["characteristics"].isMember(k)) return false;
    return true;
}
Json::Value CharacterSpaceService::withNumbers(const Json::Value& card, const Json::Value& nums, const std::string& ruleSystem) {
    Json::Value out = normalizeRoleCard(card);
    for (auto k : kCocNumbers) out.removeMember(k);
    out.removeMember("dnd"); out.removeMember("pbta");
    if (ruleSystem == "dnd2024") out["dnd"] = nums["dnd"];
    else if (ruleSystem == "pbta") { if (nums["pbta"].isObject() && !nums["pbta"].empty()) out["pbta"] = nums["pbta"]; }
    else for (auto k : kCocNumbers) if (nums.isMember(k)) out[k] = nums[k];
    out = normalizeRoleCard(out);   // a D&D card still carries the blank Call of Cthulhu fields the client expects
    if (ruleSystem == "dnd2024" && !out["dnd"].isObject()) out["dnd"] = dnd2024::normalize(Json::Value());
    return out;
}

namespace {
// Dice values beyond what a blank card of the system mirrors (a blank D&D build still mirrors AC 10, Speed 30, …).
bool hasValues(const Json::Value& attrs, const std::string& ruleSystem) {
    static const Json::Value blankDnd = dnd2024::mirrorAttrs(Json::Value(Json::objectValue), dnd2024::normalize(Json::Value()));
    const Json::Value empty(Json::objectValue);
    const Json::Value& blank = ruleSystem == "dnd2024" ? blankDnd : empty;
    if (!attrs.isObject()) return false;
    for (const auto& k : attrs.getMemberNames()) if (!blank.isMember(k) || blank[k] != attrs[k]) return true;
    return false;
}
} // namespace

Json::Value CharacterSpaceService::transitionCards(pqxx::work& w, const std::string& channelId, const std::string& from, const std::string& to, const std::string& actorId) {
    Json::Value out; out["from"] = from; out["to"] = to; out["archived"] = 0; out["pending"] = 0;
    out["rebuild"] = Json::Value(Json::arrayValue); out["rows"] = Json::Value(Json::arrayValue);
    if (from == to) return out;
    for (const auto& c : Db::queryJson(w, "SELECT id, kind, card_pending, role_card, sheet FROM characters WHERE channel_id=$1 ORDER BY created_at, id FOR UPDATE", {channelId})) {
        const auto id = c["id"].asString();
        Json::Value sheet = c["sheet"].isObject() ? c["sheet"] : Json::Value(Json::objectValue);
        const Json::Value attrs = sheet["attrs"].isObject() ? sheet["attrs"] : Json::Value(Json::objectValue);
        const bool kept = hasNumbers(c["role_card"], from) || hasValues(attrs, from);
        if (kept) {
            Db::exec(w, "INSERT INTO character_card_archives(character_id, channel_id, rule_system, numbers, attrs, reason, archived_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,'rule_change',$6)",
                     {id, channelId, from, json::dump(numbers(c["role_card"], from)), json::dump(attrs), actorId.empty() ? dbNull() : DbParam(actorId)});
            out["archived"] = out["archived"].asInt() + 1;
        }
        // The story stays; the numbers start blank for the new system. A character still waiting for a rebuild keeps
        // waiting (its numbers of the earlier system are in the archive, ready to be brought back if the GM returns).
        const bool pending = kept || c["card_pending"].asBool();
        sheet["attrs"] = Json::Value(Json::objectValue);
        auto row = Db::queryOne(w, "UPDATE characters SET role_card=$2::jsonb, sheet=$3::jsonb, card_pending=$4, updated_at=now() WHERE id=$1 RETURNING *",
                                {id, json::dump(withNumbers(c["role_card"], Json::Value(Json::objectValue), to)), json::dump(sheet), pending});
        if (pending) {
            out["pending"] = out["pending"].asInt() + 1;
            if (row["kind"].asString() != "npc") { Json::Value r; r["id"] = id; r["name"] = row["name"]; out["rebuild"].append(r); }
        }
        out["rows"].append(row);
    }
    return out;
}

Json::Value CharacterSpaceService::restoreArchive(const ChannelAccess& a, const std::string& characterId, const std::string& archiveId) {
    characterFor(a, characterId, true);
    if (!Visibility::isUuid(archiveId)) throw badRequest("invalid archive id");
    auto row = db_.tx([&](pqxx::work& w) {
        // Read under a share lock: a switch of the rules (which locks the channel row) waits for this, or this for it.
        const auto rs = Db::queryOne(w, "SELECT rule_system FROM channels WHERE id=$1 FOR SHARE", {a.channelId})["rule_system"].asString();
        auto arch = Db::queryOne(w, "SELECT * FROM character_card_archives WHERE id=$1 AND character_id=$2 FOR UPDATE", {archiveId, characterId});
        if (arch.isNull()) throw notFound("archived card not found");
        if (arch["rule_system"].asString() != rs) throw conflict("this card was made for another rule system; only a card of the channel's current system can come back");
        auto cur = Db::queryOne(w, "SELECT role_card, sheet FROM characters WHERE id=$1 FOR UPDATE", {characterId});
        Json::Value sheet = cur["sheet"].isObject() ? cur["sheet"] : Json::Value(Json::objectValue);
        const Json::Value attrs = sheet["attrs"].isObject() ? sheet["attrs"] : Json::Value(Json::objectValue);
        // Whatever was built meanwhile is set aside, not lost.
        if (hasNumbers(cur["role_card"], rs) || hasValues(attrs, rs))
            Db::exec(w, "INSERT INTO character_card_archives(character_id, channel_id, rule_system, numbers, attrs, reason, archived_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,'restore',$6)",
                     {characterId, a.channelId, rs, json::dump(numbers(cur["role_card"], rs)), json::dump(attrs), a.userId});
        Json::Value nums = arch["numbers"];
        if (rs == "pbta") {
            // The playbooks may have changed since: the card comes back only if it still fits the channel's pack.
            try { nums["pbta"] = pbta::normalizeCard(nums["pbta"], pbta::lockedPack(w, a.channelId)["pack"]); }
            catch (const ApiError& e) { throw conflict("this card no longer fits the channel's playbooks (" + std::string(e.what()) + "); rebuild it instead"); }
        }
        auto card = withNumbers(cur["role_card"], nums, rs);
        const Json::Value old = arch["attrs"].isObject() ? arch["attrs"] : Json::Value(Json::objectValue);
        sheet["attrs"] = rs == "dnd2024" ? dnd2024::mirrorAttrs(old, card["dnd"]) : rs == "pbta" ? old : mirrorAttrs(old, card);
        Db::exec(w, "DELETE FROM character_card_archives WHERE id=$1", {archiveId});
        return Db::queryOne(w, "UPDATE characters SET role_card=$2::jsonb, sheet=$3::jsonb, card_pending=false, updated_at=now() WHERE id=$1 RETURNING *", {characterId, json::dump(card), json::dump(sheet)});
    });
    notifier_.characterUpdated(a.channelId, row);
    return space(a, characterId);
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
    else p += ". Framing: full-body visual-novel standee isolated on a transparent background with a real alpha channel, expression/pose: " + (subtitle.empty() ? std::string("IDLE") : subtitle) + ". Keep the same face, hair and attire as the main portrait. Keep the entire silhouette, hands and feet inside the frame. No scenery, solid backdrop, checkerboard pattern or ground shadow.";
    return clip(p, 5000);
}

Json::Value CharacterSpaceService::characterFor(const ChannelAccess& a, const std::string& characterId, bool write) {
    auto c = db_.queryOne("SELECT c.*, u.display_name AS player_name FROM characters c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.channel_id=$2", {characterId, a.channelId});
    if (c.isNull()) throw notFound("character not found");
    bool owner = c["user_id"].isString() && c["user_id"].asString() == a.userId;
    if (!a.isGm && c["kind"].asString() == "npc") throw notFound("character not found");
    if (write && !a.isGm && !owner) throw forbidden("only the GM or the character's actor may edit this character");
    c["editable"] = a.isGm || owner;
    return c;
}

// Point buy is the GM's choice for the channel (channels.point_buy); its rules follow the channel's rule system.
bool CharacterSpaceService::pointsMode(const ChannelAccess& a) {
    auto r = db_.queryOne("SELECT point_buy FROM channels WHERE id=$1", {a.channelId});
    return !r.isNull() && r["point_buy"].asBool();
}
std::string CharacterSpaceService::ruleSystem(const ChannelAccess& a) {
    auto r = db_.queryOne("SELECT rule_system FROM channels WHERE id=$1", {a.channelId});
    return r.isNull() ? "coc7e" : r["rule_system"].asString();
}
Json::Value CharacterSpaceService::pointsReport(const ChannelAccess& a, const Json::Value& card) {
    Json::Value rep; rep["enabled"] = pointsMode(a); rep["rule_system"] = ruleSystem(a);
    if (rep["rule_system"]=="pbta") rep["enabled"]=false;
    if (!rep["enabled"].asBool()) return rep;
    if (rep["rule_system"] == "dnd2024") {
        auto r = dnd2024::check(card["dnd"].isObject() ? card["dnd"] : dnd2024::normalize(Json::Value()));
        for (auto& k : r.getMemberNames()) rep[k] = r[k];
        return rep;
    }
    rep["language"] = settings_.language(a.serverId);   // skill names are shown in the server language
    Json::Value copy = card; auto r = coc7::apply(copy);
    for (auto& k : r.getMemberNames()) rep[k] = r[k];
    return rep;
}

Json::Value CharacterSpaceService::space(const ChannelAccess& a, const std::string& characterId) {
    auto c = characterFor(a, characterId, false);
    Json::Value out; out["character"] = c;
    out["character"]["role_card"] = normalizeRoleCard(c["role_card"]);
    auto asset = [&](const Json::Value& id) { if (!id.isString()) return Json::Value(); return db_.queryOne("SELECT id, version, content_hash AS hash, mime, width, height, source_type, approval_status FROM media_assets WHERE id=$1 AND channel_id=$2", {id.asString(), a.channelId}); };
    out["avatar"] = asset(c["avatar_asset_id"]); out["portrait"] = asset(c["portrait_asset_id"]);
    out["subtitles"] = Json::Value(Json::arrayValue);
    auto vis = db_.queryOne("SELECT expressions, description, color FROM character_visual_profiles WHERE character_id=$1", {characterId});
    if (!vis.isNull() && vis["expressions"].isObject()) for (auto& k : vis["expressions"].getMemberNames()) { auto as = asset(vis["expressions"][k]); if (as.isNull()) continue; as["subtitle"] = k; out["subtitles"].append(as); }
    out["jobs"] = db_.queryJson("SELECT id, kind, status, error, params->'attach' AS attach, created_at, finished_at FROM asset_generation_jobs WHERE channel_id=$1 AND character_id=$2 AND params ? 'attach' ORDER BY created_at DESC LIMIT 12", {a.channelId, characterId});
    auto ch = db_.queryOne("SELECT c.era, s.narrative_time FROM channels c LEFT JOIN scenes s ON s.id=c.current_scene_id WHERE c.id=$1", {a.channelId});
    out["era"] = ch["era"]; out["narrative_time"] = ch["narrative_time"];
    out["attrs"] = c["sheet"]["attrs"].isObject() ? c["sheet"]["attrs"] : Json::Value(Json::objectValue);
    out["rule_system"] = ruleSystem(a);
    if (out["rule_system"]=="pbta") { out["pbta_rules"]=pbta::read(db_,a); out["attrs"]=Json::Value(Json::objectValue); }
    out["generation_available"] = creative_.available(a.channelId);
    out["points"] = pointsReport(a, out["character"]["role_card"]);
    // Numbers of earlier rule systems, read-only: what the character was before the GM switched the rules.
    out["card_archives"] = db_.queryJson("SELECT ar.id, ar.rule_system, ar.numbers, ar.attrs, ar.reason, ar.archived_at, u.display_name AS archived_by_name "
        "FROM character_card_archives ar LEFT JOIN users u ON u.id=ar.archived_by WHERE ar.character_id=$1 ORDER BY ar.archived_at DESC, ar.id LIMIT 20", {characterId});
    return out;
}

Json::Value CharacterSpaceService::updateCard(const ChannelAccess& a, const std::string& characterId, const Json::Value& body) {
    auto c = characterFor(a, characterId, true);
    const auto rs = ruleSystem(a);
    if (body.isMember("rule_system") && body["rule_system"] != rs) throw conflict("Channel rules changed. Reopen the character.");
    if (body.isMember("card_rebuilt") && !body["card_rebuilt"].isBool()) throw badRequest("card_rebuilt must be a boolean");
    const bool waive = a.isGm && json::toBool(body, "card_rebuilt");
    // Only the channel's own system's numbers are kept: a client still holding the numbers of the system the channel
    // left (an open editor, an older app) cannot write them back next to the new ones. Those live in the archive.
    auto card = forSystem(body.isMember("role_card") ? body["role_card"] : c["role_card"], rs);
    if (rs == "pbta") {
        auto row = db_.tx([&](pqxx::work& w) {
            const auto pack = pbta::lockedPack(w, a.channelId);
            if (body["pack_revision"] != pack["revision"]) throw conflict("Open the current PbtA sheet before saving");
            auto current = Db::queryOne(w, "SELECT role_card, card_pending FROM characters WHERE id=$1 FOR UPDATE", {characterId});
            // The story part the client sent (or the stored one), the PbtA numbers checked against the channel's pack.
            auto story = normalizeRoleCard(current["role_card"]);
            for (auto key : {"basic", "background", "items"}) if (body["role_card"].isMember(key)) story[key] = card[key];
            // A GM waiving the rebuild of a character without a playbook saves its story alone.
            Json::Value nums(Json::objectValue);
            if (!(waive && !body["role_card"]["pbta"].isObject())) nums["pbta"] = pbta::normalizeCard(body["role_card"]["pbta"], pack["pack"]);
            auto merged = withNumbers(story, nums, "pbta");
            const bool pending = current["card_pending"].asBool() && !built(merged, "pbta") && !waive;
            auto name = str(body, "name", 80); if (!body.isMember("name")) name = c["name"].asString();
            if (name.empty()) throw badRequest("name required");
            auto result = Db::queryOne(w, "UPDATE characters SET name=$2,speaking_style=$3,bio=$4,role_card=$5::jsonb,card_pending=$6,updated_at=now() WHERE id=$1 RETURNING *",
                {characterId, name, clip(json::str(body, "speaking_style", c["speaking_style"].asString()), 400), clip(json::str(body, "bio", c["bio"].asString()), 6000), json::dump(merged), pending});
            Db::exec(w, "UPDATE entities SET name=$2 WHERE character_id=$1 AND player_group_id IS NULL AND name<>$2", {characterId, name});
            return result;
        });
        notifier_.characterUpdated(a.channelId, row);
        return space(a, characterId);
    }
    const bool dnd = rs == "dnd2024";
    if (dnd) {
        // Ability improvements after level 1 (feats, Ability Score Improvements) are the GM's to grant under point buy.
        if (pointsMode(a) && !a.isGm) {
            auto before = normalizeRoleCard(c["role_card"]);
            card["dnd"]["improvements"] = before["dnd"].isObject() ? before["dnd"]["improvements"] : Json::Value(Json::objectValue);
        }
        if (pointsMode(a)) {
            auto rep = dnd2024::check(card["dnd"]);
            if (!rep["violations"].empty()) {
                std::string msg; for (const auto& v : rep["violations"]) msg += (msg.empty() ? "" : "; ") + v["message"].asString();
                throw ApiError(400, "points_rule", msg);
            }
        }
    }
    if (!dnd && pointsMode(a) && !a.isGm) {
        // Growth points record improvement the GM granted (or .en rolled): a player cannot set them.
        auto before = normalizeRoleCard(c["role_card"]);
        for (auto& k : card["skill_points"].getMemberNames()) {
            const auto& old = before["skill_points"];
            card["skill_points"][k]["growth"] = old.isMember(k) ? old[k]["growth"] : Json::Value(0);
        }
    }
    if (!dnd && pointsMode(a)) {
        auto rep = coc7::apply(card);
        if (!rep["violations"].empty()) {
            std::string msg; for (const auto& v : rep["violations"]) msg += (msg.empty() ? "" : "; ") + v["message"].asString();
            throw ApiError(400, "points_rule", msg);
        }
    }
    Json::Value sheet = c["sheet"].isObject() ? c["sheet"] : Json::Value(Json::objectValue);
    sheet["attrs"] = dnd ? dnd2024::mirrorAttrs(sheet["attrs"], card["dnd"]) : mirrorAttrs(sheet["attrs"], card);
    auto name = clip(text::trim(json::str(body, "name", c["name"].asString())), 80); if (name.empty()) throw badRequest("name required");
    // The rebuild flag goes once the numbers are rebuilt (D&D: a class; Call of Cthulhu: the eight characteristics), or
    // when the GM waives it (an NPC that will never roll, a card kept outside the platform).
    const bool pending = c["card_pending"].asBool() && !built(card, rs) && !waive;
    // Written only while the channel still plays the system this card was checked against: a save that lands after the
    // GM switched the rules would otherwise put the old system's numbers back.
    auto row = db_.queryOne("UPDATE characters SET name=$2, speaking_style=$3, bio=$4, role_card=$5::jsonb, sheet=$6::jsonb, card_pending=$7, updated_at=now() "
                            "WHERE id=$1 AND EXISTS (SELECT 1 FROM channels WHERE id=characters.channel_id AND rule_system=$8 FOR SHARE) RETURNING *",
        {characterId, name, clip(json::str(body, "speaking_style", c["speaking_style"].asString()), 400), clip(json::str(body, "bio", c["bio"].asString()), 6000), json::dump(card), json::dump(sheet), pending, rs});
    if (row.isNull()) throw conflict("Channel rules changed. Reopen the character.");
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
    media_.adoptCharacterImage(channelId, characterId, slot, subtitle, assetId);   // the older image of the slot is deleted
}

void CharacterSpaceService::adoptLibraryUpload(const ChannelAccess& a, const Json::Value& asset) {
    auto cid = json::str(asset, "character_id"), type = json::str(asset, "asset_type");
    if (cid.empty() || (type != "standee" && type != "portrait") || json::str(asset, "approval_status") != "approved") return;
    auto c = db_.queryOne("SELECT user_id FROM characters WHERE id=$1 AND channel_id=$2", {cid, a.channelId});
    if (c.isNull() || !(a.isGm || json::str(c, "user_id") == a.userId)) return;
    auto expr = text::lower(text::trim(json::str(asset, "expression")));
    if (expr == "avatar" || (type == "portrait" && (expr.empty() || expr == "portrait" || expr == "default"))) attach(a.channelId, cid, expr == "avatar" ? "avatar" : "portrait", "", asset["id"].asString());
    else if (auto sub = normalizeSubtitle(expr); !sub.empty() && expr != "default") attach(a.channelId, cid, "subtitle", sub, asset["id"].asString());
    else return;
    notifier_.characterUpdated(a.channelId, db_.queryOne("SELECT * FROM characters WHERE id=$1", {cid}));
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
