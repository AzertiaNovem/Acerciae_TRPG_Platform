#include "InspirationService.h"
#include "../rules/Pbta.h"
#include "../rules/RuleSystem.h"
#include "../retrieval/ContextRetrievalService.h"
#include "../llm/LlmGateway.h"
#include "../knowledge/Visibility.h"
#include "../characters/CharacterSpaceService.h"
#include "../characters/Vitals.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include <algorithm>
#include <set>

namespace acerciae {

namespace {
// Written for Call of Cthulhu; the gateway fills {GAME} and {GM} in for the channel's rule system and adds the output
// language. {DICE} is filled in here.
const char* kSystem = R"(You are a fellow player at an online table of {GAME}, sitting beside a human player who is unsure what their character should say or do next; the {GM} runs the world. Suggest three possible next lines for them: three different ways to play this moment, each written in the character's own voice, exactly as the player would type it into the chat.

How to suggest:
- Stay in character: true to the persona, speaking style and role card below. The character knows only what they saw or heard (the chat log and WHAT YOUR CHARACTER KNOWS); invent no backstory, no world facts and no {GM} secrets.
- Answer the moment: the NEWEST LINE and whatever was asked of this character. If the last lines were addressed to someone else, suggest what fits: back them up, ask, watch, or wait.
- Be a good tablemate: build on the other players' ideas, do not take over the scene, do not solve the mystery alone, and leave the {GM} room to answer.
- Short lines (1-3 sentences): what the character says and does, first person. Never narrate outcomes, the world, or other characters' actions, thoughts or words; never decide whether anything succeeds. Propose and ask; the {GM} decides.
- When an action calls for a check, put the dice command the player can send with it in "roll" ({DICE}); never roll yourself and never state a result. Otherwise leave "roll" empty.
- Make the three options differ in stance (for example cautious, bold, curious; speaking, acting, asking) and name each stance in "angle" in two or three words.
- If THE PLAYER'S HINT is given, every option follows it. Never repeat an option listed under ALREADY SUGGESTED.
- "kind" is "ic" for an in-character line, "ooc" only for a remark the player might make to the table out of character.

Reply with only one JSON object: {"options": [{"text": "...", "kind": "ic", "roll": "", "angle": "..."}, {...}, {...}], "used_fact_ids": ["<ids of the facts you drew on>"]})";

std::string join(const std::vector<std::string>& v, const char* sep) { std::string s; for (auto& x : v) { if (!s.empty()) s += sep; s += x; } return s; }
std::string one(const std::string& s) { return text::trim(s); }
}  // namespace

Json::Value InspirationService::schema() {
    static Json::Value s = json::parse(R"({"type":"object","properties":{
        "options":{"type":"array","items":{"type":"object","required":["text"],"properties":{"text":{"type":"string","minLength":1},"kind":{"type":"string"},"roll":{"type":"string"},"angle":{"type":"string"}}}},
        "draft":{"type":"string"},"used_fact_ids":{"type":"array","items":{"type":"string"}},"notes":{"type":"string"}}})");
    return s;
}

std::string InspirationService::diceShape(const std::string& rs) {
    if (rs == "pbta") return ".move <move-id>, with the fictional declaration in the text";
    if (rs == "dnd2024") return ".ra <skill or ability>, for example .ra Perception";
    return ".ra <skill or characteristic>, for example .ra Spot Hidden";
}

std::string InspirationService::renderLogLine(const Json::Value& e, const std::string& gm) {
    auto name = json::str(e, "character_name"), kind = json::str(e, "kind");
    std::string who = !name.empty() ? name : json::str(e, "actor_role") == "gm" ? gm : "a player";
    if (kind == "narration") who += " (narration)";
    std::string tag = kind == "ooc" ? " (out of character)" : kind == "roll" || kind == "dice_roll" ? " (roll)" : "";
    std::string content = json::str(e, "content");
    std::string flat; bool space = false;
    for (unsigned char c : content) { if (c == ' ' || c == '\n' || c == '\t' || c == '\r') { if (!space) flat += ' '; space = true; } else { flat += (char)c; space = false; } }
    return "#" + std::to_string(json::toInt(e, "seq", 0)) + " " + who + tag + ": " + text::trim(flat);
}

std::string InspirationService::cardSummary(const Json::Value& cardIn, const Json::Value& attrs, const std::string& rs) {
    auto card = CharacterSpaceService::normalizeRoleCard(cardIn.isObject() ? cardIn : Json::Value(Json::objectValue));
    std::vector<std::string> lines;
    const auto& b = card["basic"];
    std::vector<std::string> basics;
    if (!json::str(b, "occupation").empty()) basics.push_back("occupation: " + json::str(b, "occupation"));
    if (!json::str(b, "age").empty()) basics.push_back("age " + json::str(b, "age"));
    if (!json::str(b, "sex").empty()) basics.push_back(json::str(b, "sex"));
    if (!json::str(b, "birthplace").empty()) basics.push_back("from " + json::str(b, "birthplace"));
    if (!json::str(b, "residence").empty()) basics.push_back("lives in " + json::str(b, "residence"));
    if (!basics.empty()) lines.push_back(join(basics, ", "));
    if (rs == "pbta") {
        if (card["pbta"].isObject() && !card["pbta"].empty()) lines.push_back("playbook sheet: " + json::dump(card["pbta"]));
    } else if (rs == "dnd2024") {
        const auto& d = card["dnd"];
        if (d.isObject() && !d.empty()) {
            std::vector<std::string> build;
            for (auto k : {"class", "subclass", "species", "background"}) if (!json::str(d, k).empty()) build.push_back(json::str(d, k));
            if (d["level"].isNumeric()) build.push_back("level " + std::to_string(d["level"].asInt()));
            if (!build.empty()) lines.push_back("build: " + join(build, ", "));
        }
        std::vector<std::string> scores;
        for (auto k : {"STR", "DEX", "CON", "INT", "WIS", "CHA"}) if (attrs.isObject() && attrs[k].isNumeric()) scores.push_back(std::string(k) + " " + std::to_string(attrs[k].asInt()));
        if (!scores.empty()) lines.push_back("abilities: " + join(scores, ", "));
    } else {
        std::vector<std::string> ch;
        for (auto k : {"STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUK"}) if (card["characteristics"][k].isNumeric() && card["characteristics"][k].asInt() > 0) ch.push_back(std::string(k) + " " + std::to_string(card["characteristics"][k].asInt()));
        if (!ch.empty()) lines.push_back("characteristics: " + join(ch, ", "));
        std::vector<std::pair<std::string, int>> skills;
        if (card["skills"].isObject()) for (auto& k : card["skills"].getMemberNames()) if (card["skills"][k].isNumeric() && card["skills"][k].asInt() > 0) skills.push_back({k, card["skills"][k].asInt()});
        std::sort(skills.begin(), skills.end(), [](auto& x, auto& y) { return x.second > y.second; });
        if (skills.size() > 25) skills.resize(25);
        std::vector<std::string> sk; for (auto& [k, v] : skills) sk.push_back(k + " " + std::to_string(v));
        if (!sk.empty()) lines.push_back("skills: " + join(sk, ", "));
    }
    std::vector<std::string> bg;
    if (card["background"].isObject()) for (auto& k : card["background"].getMemberNames()) if (!json::str(card["background"], k.c_str()).empty()) bg.push_back(k + ": " + json::str(card["background"], k.c_str()));
    if (!bg.empty()) lines.push_back("background: " + join(bg, "; "));
    std::vector<std::string> items;
    if (card["items"].isArray()) for (auto& it : card["items"]) if (!json::str(it, "name").empty()) items.push_back(json::str(it, "name") + (json::toInt(it, "qty", 1) > 1 ? " ×" + std::to_string(json::toInt(it, "qty", 1)) : ""));
    if (!items.empty()) lines.push_back("carrying: " + join(items, ", "));
    return lines.empty() ? "(blank card)" : join(lines, "\n");
}

namespace {
std::string condition(const Json::Value& v) {
    auto n = [](const Json::Value& x) { return x.isNumeric() ? std::to_string(x.asInt()) : std::string("?"); };
    auto pair = [&](const Json::Value& x, const Json::Value& max) { return n(x) + (max.isNumeric() ? "/" + n(max) : ""); };
    if (json::str(v, "rule_system") == "pbta") {
        std::vector<std::string> parts;
        for (auto& r : v["resources"]) parts.push_back(json::str(r, "name") + " " + n(r["value"]));
        for (auto& c : v["conditions"]) parts.push_back(json::str(c, "name") + " (marked)");
        return parts.empty() ? "(nothing marked)" : join(parts, ", ");
    }
    if (json::str(v, "rule_system") == "dnd2024") return "HP " + pair(v["hp"], v["hp_max"]) + ", AC " + n(v["ac"]) + ", DEX " + n(v["dex"]);
    return "HP " + pair(v["hp"], v["hp_max"]) + ", SAN " + pair(v["san"], v["san_max"]) + ", DEX " + n(v["dex"]);
}
}  // namespace

Json::Value InspirationService::draft(const ChannelAccess& a, const std::string& chatWindowId, const std::string& characterIdIn, const std::string& hint, int variant, const Json::Value& avoid) {
    std::string characterId = characterIdIn.empty() ? a.primaryCharacterId : characterIdIn;
    if (!a.isGm && !characterId.empty() && std::find(a.characterIds.begin(), a.characterIds.end(), characterId) == a.characterIds.end()) throw forbidden("not your character");
    ChannelAccess view = a; if (!a.isGm && !characterId.empty()) view.characterIds = {characterId};

    auto ch = db_.queryOne("SELECT c.rule_system, c.era, c.name FROM channels c WHERE c.id=$1", {a.channelId});
    const auto rs = rules::canonical(json::str(ch, "rule_system")).empty() ? std::string("coc7e") : rules::canonical(json::str(ch, "rule_system"));
    const auto& profile = rules::profile(rs);
    auto character = characterId.empty() ? Json::Value(Json::objectValue)
        : db_.queryOne("SELECT c.id, c.name, c.kind, c.bio, c.speaking_style, c.role_card, c.sheet, u.display_name AS player_name FROM characters c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.channel_id=$2", {characterId, a.channelId});
    if (!characterId.empty() && character.isNull()) throw notFound("character not found");

    // The scene the window plays, with the lines this character witnessed there (the retrieval's visibility filter).
    auto scene = retrieval_.getCurrentScene(view, chatWindowId, 30);
    Json::Value log = scene.isMember("log") ? scene["log"] : Json::Value(Json::arrayValue);
    scene.removeMember("log"); scene.removeMember("facts");
    // Facts the character's group knows, most recently updated first, bounded.
    std::string sql = "SELECT f.id AS fact_id, f.kind, f.summary, f.status, f.data, CASE WHEN f.player_group_id IS NULL THEN s.title ELSE NULL END AS scene_title FROM knowledge_facts f LEFT JOIN scenes s ON s.id=f.scene_id LEFT JOIN document_entries de ON de.fact_id=f.id AND NOT de.removed LEFT JOIN documents d ON d.id=de.document_id WHERE f.channel_id=$1 AND f.status <> 'retracted' AND " + Visibility::factFilter(view) + (a.isGm ? "" : " AND coalesce(d.gm_only,false)=false") + " ORDER BY f.updated_at DESC LIMIT 30";
    auto facts = db_.queryJson(sql, {a.channelId});
    // Who else is in this window: fellow player characters (NPCs only for the GM, whose secret they are).
    Json::Value companions = chatWindowId.empty() ? Json::Value(Json::arrayValue)
        : db_.queryJson("SELECT c.id, c.name, c.kind, c.role_card->'basic'->>'occupation' AS occupation FROM chat_window_members wm JOIN characters c ON c.id=wm.character_id WHERE wm.chat_window_id=$1 AND c.channel_id=$2 AND c.id<>$3::uuid" + std::string(a.isGm ? "" : " AND c.kind='pc'") + " ORDER BY c.created_at",
                        {chatWindowId, a.channelId, characterId.empty() ? "00000000-0000-0000-0000-000000000000" : characterId});
    Json::Value pbtaCtx; pbta::addContext(db_, a, characterId, pbtaCtx);
    Json::Value pack = pbtaCtx.isMember("pbta_rules") ? db_.queryOne("SELECT pack FROM pbta_packs WHERE channel_id=$1", {a.channelId})["pack"] : Json::Value();

    // The prompt, laid out like the co-player's: who they are, the moment, what they know, the lines, their move.
    const auto name = json::str(character, "name", "the character");
    const auto attrs = character["sheet"]["attrs"].isObject() ? character["sheet"]["attrs"] : Json::Value(Json::objectValue);
    std::vector<std::string> parts;
    parts.push_back("YOU ARE: " + name + (json::str(character, "kind") == "npc" ? " (a character the " + profile.gm + " plays)" : json::str(character, "player_name").empty() ? "" : " (played by " + json::str(character, "player_name") + ")"));
    parts.push_back("PERSONA: " + (one(json::str(character, "bio")).empty() ? std::string("(none written)") : one(json::str(character, "bio"))));
    parts.push_back("SPEAKING STYLE: " + (one(json::str(character, "speaking_style")).empty() ? std::string("(natural)") : one(json::str(character, "speaking_style"))));
    parts.push_back("YOUR ROLE CARD:\n" + cardSummary(character["role_card"], attrs, rs));
    parts.push_back("YOUR CURRENT CONDITION AND INVENTORY: " + condition(vitals::of(character, rs, pack)));
    if (pbtaCtx.isMember("pbta_rules")) parts.push_back("YOUR PLAYBOOK'S MOVES (game reference; a move is triggered by the fiction, its outcome is the " + profile.gm + "'s): " + json::dump(pbtaCtx["pbta_rules"]));
    {
        std::vector<std::string> when;
        if (!one(json::str(ch, "era")).empty()) when.push_back("era " + one(json::str(ch, "era")));
        if (!one(json::str(scene, "narrative_time")).empty()) when.push_back(one(json::str(scene, "narrative_time")));
        if (!one(json::str(scene, "location")).empty()) when.push_back("place: " + one(json::str(scene, "location")));
        if (!one(json::str(scene, "title")).empty()) when.push_back("scene: " + one(json::str(scene, "title")));
        if (!when.empty()) parts.push_back("TODAY IN THE STORY: " + join(when, "; "));
    }
    {
        std::vector<std::string> who;
        for (auto& c : companions) who.push_back(json::str(c, "name") + (json::str(c, "kind") == "npc" ? " (NPC)" : json::str(c, "occupation").empty() ? "" : " (" + json::str(c, "occupation") + ")"));
        parts.push_back("THE OTHER PLAYER CHARACTERS WITH YOU HERE: " + (who.empty() ? std::string("(none)") : join(who, ", ")));
    }
    {
        std::vector<std::string> known;
        for (auto& f : facts) {
            auto title = json::str(f["data"], "title");
            known.push_back("- [" + json::str(f, "fact_id") + "] " + json::str(f, "kind") + ": " + (title.empty() ? "" : title + " — ") + one(json::str(f, "summary")) + (json::str(f, "status") == "resolved" ? " (resolved)" : "") + (json::str(f, "scene_title").empty() ? "" : " (" + json::str(f, "scene_title") + ")"));
        }
        parts.push_back("WHAT YOUR CHARACTER KNOWS (your group's records, most recently updated first; cite their ids in used_fact_ids):\n" + (known.empty() ? std::string("(nothing recorded yet)") : join(known, "\n")));
    }
    if (a.isGm || Visibility::isUuid(a.playerGroupId)) {
        // The reminder planner's private reading of this group's own chat (group_outlooks) and what the members pinned.
        const DbParam group = a.isGm ? dbNull() : DbParam(a.playerGroupId);
        auto o = db_.queryOne("SELECT situation, next_move, needs FROM group_outlooks WHERE channel_id=$1 AND player_group_id IS NOT DISTINCT FROM $2::uuid AND updated_at > now() - interval '2 days'", {a.channelId, group});
        if (!o.isNull()) {
            std::vector<std::string> needs; for (const auto& n : o["needs"]) if (n.isString() && !one(n.asString()).empty()) needs.push_back(one(n.asString()));
            std::vector<std::string> block;
            if (!one(json::str(o, "situation")).empty()) block.push_back("- where the table stands: " + one(json::str(o, "situation")));
            if (!one(json::str(o, "next_move")).empty()) block.push_back("- what it seems about to do: " + one(json::str(o, "next_move")));
            if (!needs.empty()) block.push_back("- what that depends on: " + join(needs, "; "));
            if (!block.empty()) parts.push_back("THE TABLE'S MOMENT (the chronicler's private reading of this group's own chat; a hint about the moment, not a fact):\n" + join(block, "\n"));
        }
        std::vector<std::string> pinned;
        for (const auto& p : db_.queryJson("SELECT citations, why FROM reminders WHERE channel_id=$1 AND player_group_id IS NOT DISTINCT FROM $2::uuid AND kind='pinned' AND status='active' ORDER BY created_at DESC LIMIT 8", {a.channelId, group})) {
            std::string q = p["citations"].isArray() && !p["citations"].empty() && p["citations"][0]["quotes"].isArray() && !p["citations"][0]["quotes"].empty() ? p["citations"][0]["quotes"][0].asString() : "";
            if (!q.empty()) pinned.push_back("- \"" + q + "\" (" + json::str(p, "why") + ")");
        }
        if (!pinned.empty()) parts.push_back("WHAT THE PLAYERS PINNED AS IMPORTANT (lines they marked themselves):\n" + join(pinned, "\n"));
    }
    {
        std::vector<std::string> lines; for (auto& e : log) lines.push_back(renderLogLine(e, profile.gm));
        parts.push_back("CHAT LOG YOUR CHARACTER WITNESSED (newest last):\n" + (lines.empty() ? std::string("(nothing yet: the scene is about to begin)") : join(lines, "\n")));
        if (!lines.empty()) parts.push_back("NEWEST LINE: " + lines.back());
    }
    if (!one(hint).empty()) parts.push_back("THE PLAYER'S HINT (what they have in mind; every option follows it): " + text::utf8Prefix(one(hint), 600));
    if (avoid.isArray() && !avoid.empty()) {
        std::vector<std::string> shown; for (auto& s : avoid) if (s.isString() && !one(s.asString()).empty() && shown.size() < 12) shown.push_back("- " + text::utf8Prefix(one(s.asString()), 300));
        if (!shown.empty()) parts.push_back("ALREADY SUGGESTED (offer different ones):\n" + join(shown, "\n"));
    }
    parts.push_back("Your move? Suggest three options.");

    // The structured context the mock provider reads (a real provider gets only the prompt above).
    Json::Value ctx;
    ctx["character"] = Json::Value(Json::objectValue); ctx["character"]["id"] = character["id"]; ctx["character"]["name"] = character["name"]; ctx["character"]["speaking_style"] = character["speaking_style"];
    ctx["recent_messages"] = log; ctx["known_facts"] = facts; ctx["scene"] = scene; ctx["hint"] = hint; ctx["variant"] = variant; ctx["rule_system"] = rs;
    ctx["avoid"] = avoid.isArray() ? avoid : Json::Value(Json::arrayValue);
    ctx["characters"] = Json::Value(Json::arrayValue);
    {
        std::string visibleText; for (auto& f : facts) visibleText += json::str(f, "summary") + "\n"; for (auto& m : log) visibleText += json::str(m, "content") + "\n";
        for (auto& c : db_.queryJson("SELECT id, name, kind FROM characters WHERE channel_id=$1 ORDER BY created_at, id", {a.channelId}))
            if (a.isGm || c["kind"].asString() == "pc" || text::icontains(visibleText, c["name"].asString())) ctx["characters"].append(c);
    }

    LlmRequest req; req.channelId = a.channelId; req.task = "inspiration"; req.responseSchema = schema(); req.temperature = 0.8;
    req.system = kSystem;
    { auto p = req.system.find("{DICE}"); if (p != std::string::npos) req.system.replace(p, 6, diceShape(rs)); }
    if (pbtaCtx.isMember("pbta_rules")) req.system += "\nThis is a Powered by the Apocalypse game: use the playbook's moves as game reference only. Distinguish a fictional intent, a move trigger and its outcome; only the human triggers a move, only the {GM} decides its consequences.";
    req.tools = ContextRetrievalService::toolSpecs(false);
    req.cache = LlmCache::conversation;   // tool rounds re-read the same context
    req.mockContext = ctx;
    for (auto& k : retrieval_.knowledgeMessages(view, a.isGm ? "GM KNOWLEDGE INDEX (script knowledge first, then the GM's records; a shortcut for searching):" : "KNOWLEDGE INDEX (what this character's group already knows; a shortcut for searching):")) req.messages.push_back(k);
    LlmMessage u; u.role = "user"; u.content = join(parts, "\n\n"); req.messages.push_back(u);
    auto outcome = llm_.runStructured(req, [&](const std::string& n, const Json::Value& args) { return retrieval_.executeTool(view, n, args); }, 3);
    if (!outcome.ok) throw ApiError(502, "llm_error", "inspiration failed: " + outcome.error);
    if (!a.isGm && db_.queryOne("SELECT 1 AS ok WHERE " + Visibility::groupGuard(a)).isNull()) throw conflict("Player group changed; retry the draft");

    // The options, cleaned: at most four, each a line with its kind, an optional dot command and its stance. An
    // answer in the older one-draft shape becomes one option.
    Json::Value out = outcome.data, options(Json::arrayValue);
    Json::Value raw = out["options"].isArray() ? out["options"] : Json::Value(Json::arrayValue);
    if (raw.empty() && !one(json::str(out, "draft")).empty()) { Json::Value o; o["text"] = out["draft"]; raw.append(o); }
    for (auto& o : raw) {
        auto t = one(json::str(o, "text")); if (t.empty()) continue;
        Json::Value x; x["text"] = text::utf8Prefix(t, 1200); x["kind"] = json::str(o, "kind") == "ooc" ? "ooc" : "ic";
        auto roll = one(json::str(o, "roll")); x["roll"] = roll.rfind(".", 0) == 0 ? text::utf8Prefix(roll, 80) : "";
        x["angle"] = text::utf8Prefix(one(json::str(o, "angle")), 40);
        options.append(x);
        if (options.size() >= 4) break;
    }
    if (options.empty()) throw ApiError(502, "llm_error", "inspiration returned nothing usable");
    std::vector<std::string> used;
    std::set<std::string> allowed; for (auto& f : facts) allowed.insert(f["fact_id"].asString());
    for (auto& id : out["used_fact_ids"]) if (id.isString() && allowed.count(id.asString())) used.push_back(id.asString());
    Json::Value result;
    result["options"] = options; result["draft"] = options[0]["text"]; result["used_fact_ids"] = json::fromStrArray(used);
    if (!json::str(out, "notes").empty()) result["notes"] = text::utf8Prefix(json::str(out, "notes"), 400);
    auto row = db_.queryOne("INSERT INTO inspiration_drafts(channel_id, chat_window_id, user_id, character_id, hint, draft, used_fact_ids, llm_mode) VALUES($1,$2,$3,$4,$5,$6,$7::uuid[],$8) RETURNING id, created_at",
        {a.channelId, chatWindowId.empty() ? dbNull() : DbParam(chatWindowId), a.userId, characterId.empty() ? dbNull() : DbParam(characterId), hint, result["draft"].asString(), pgArrayLiteral(used), llm_.mode(a.channelId)});
    result["id"] = row["id"]; result["created_at"] = row["created_at"]; result["llm_mode"] = llm_.mode(a.channelId); result["character_id"] = characterId; result["editable"] = true; result["auto_sent"] = false;
    return result;
}

} // namespace acerciae
