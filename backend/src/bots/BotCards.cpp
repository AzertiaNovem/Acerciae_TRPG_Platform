#include "BotCards.h"
#include "BotMemory.h"
#include "../auth/AuthService.h"
#include "../characters/CharacterSpaceService.h"
#include "../characters/Coc7Rules.h"
#include "../characters/Dnd2024Rules.h"
#include "../chat/ChatService.h"
#include "../dice/DiceService.h"
#include "../llm/LlmGateway.h"
#include "../rules/Pbta.h"
#include "../rules/RuleSystem.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../core/Text.h"
#include <algorithm>
#include <set>
#include <stdexcept>

namespace acerciae {

namespace {
const char* kCharacteristics[] = {"STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUK"};
const char* kBackground[] = {"personal_description", "ideology", "significant_people", "meaningful_locations", "treasured_possessions", "traits"};

// The gateway names the game and the GM for the channel's rules and adds the output language.
const char* kSystem = R"(You are {BOT}, a member of an online tabletop roleplaying community, about to play at a table of {GAME}. Someone asked you to make your character. Make one you would enjoy playing, in keeping with who you are (below): your tastes and your memories shape whom you play, though the character is not you.

Fit the campaign described below and its era. Keep it playable: a person with a reason to get involved, a few strengths and a weakness or two.

Reply with only one JSON object:
)";
const char* kStory = R"( "name": "the character's name", "speaking_style": "how they talk, a few words", "bio": "two or three sentences: who they are",
 "occupation": "...", "age": "...", "sex": "...",
 "items": ["what they carry", ...])";
const char* kCoc = R"({"characteristics": {"STR": 50, "CON": 50, "SIZ": 50, "DEX": 50, "APP": 50, "INT": 50, "POW": 50, "EDU": 50, "LUK": 50},
 "skills": {"<skill name in English, as on the Call of Cthulhu sheet>": <total 1-90>, ...  (the 8 to 12 skills that define them)},
 "background": {"personal_description": "...", "ideology": "...", "significant_people": "...", "meaningful_locations": "...", "treasured_possessions": "...", "traits": "..."},
)";
const char* kCocAfter = R"(}
Characteristics are 15 to 90 (most between 40 and 70); their sum is usually near 460 before Luck.)";
const char* kDnd = R"({"class": "<one of: {CLASSES}>", "species": "<one of: {SPECIES}>", "background": "<one of: {BACKGROUNDS}>",
 "abilities": ["the six abilities STR, DEX, CON, INT, WIS, CHA, most important to the character first"],
 "skills": ["the skills they are best at, in English as in the rules, most wanted first", ...],
 "features": "a line on what they can do", "spells": "the spells they know, if any",
 "story": {"personal_description": "...", "ideology": "...", "significant_people": "...", "meaningful_locations": "...", "treasured_possessions": "...", "traits": "..."},
)";
const char* kDndAfter = R"(}
The character starts at level 1; the abilities get the standard array (15, 14, 13, 12, 10, 8) in your order.)";
const char* kPbta = R"({"book": "<the id of one playbook below>", "stats": {"<stat id>": <modifier -1 to +2>, ...}, "resources": {"<resource id>": <starting amount>, ...},
 "story": {"personal_description": "...", "ideology": "...", "significant_people": "...", "traits": "..."},
)";
const char* kPbtaAfter = R"(}
Use the ids below. Every stat gets a modest modifier (typically one +2, one or two +1, the rest 0 or -1); resources start as the playbook implies.)";

const char* kAbilities[] = {"STR", "DEX", "CON", "INT", "WIS", "CHA"};
// The spellcasting ability of the SRD's casting classes.
const std::map<std::string, std::string> kCasting = {{"Bard", "CHA"}, {"Paladin", "CHA"}, {"Sorcerer", "CHA"}, {"Warlock", "CHA"},
                                                     {"Cleric", "WIS"}, {"Druid", "WIS"}, {"Ranger", "WIS"}, {"Wizard", "INT"}};

int clampInt(const Json::Value& v, int lo, int hi, int def) {
    if (v.isNumeric() && !v.isBool()) return std::clamp(v.asInt(), lo, hi);
    // "+1", " 2 " count as numbers.
    if (v.isString()) { auto t = text::trim(v.asString()); if (!t.empty() && t[0] == '+') t = t.substr(1); try { std::size_t n = 0; int x = std::stoi(t, &n); if (n == t.size()) return std::clamp(x, lo, hi); } catch (...) {} }
    return def;
}
std::string clip(const Json::Value& v, std::size_t max) { return v.isString() ? text::utf8Prefix(text::trim(v.asString()), max) : std::string(); }
std::string replaceAll(std::string s, const std::string& from, const std::string& to) {
    for (std::size_t at = s.find(from); at != std::string::npos; at = s.find(from, at + to.size())) s.replace(at, from.size(), to);
    return s;
}
// An entry of a rules list by its id, name or any localized name, ignoring case.
const Json::Value* named(const Json::Value& list, const Json::Value& want) {
    const auto key = text::lower(text::trim(want.isString() ? want.asString() : std::string()));
    if (key.empty()) return nullptr;
    for (const auto& x : list) {
        if (text::lower(x["id"].asString()) == key || text::lower(x["name"].asString()) == key) return &x;
        for (const auto& l : x["names"].getMemberNames()) if (text::lower(x["names"][l].asString()) == key) return &x;
    }
    return nullptr;
}
bool listed(const Json::Value& list, const std::string& v) { for (const auto& x : list) if (x.asString() == v) return true; return false; }
std::string names(const Json::Value& list) { std::vector<std::string> n; for (const auto& x : list) n.push_back(x["name"].asString()); return text::join(n, ", "); }

// The story part every rule system shares: basic details, background texts (under `key`), what they carry.
Json::Value story(const Json::Value& wish, const char* key) {
    Json::Value card(Json::objectValue);
    card["basic"]["occupation"] = clip(wish["occupation"], 80);
    card["basic"]["age"] = wish["age"].isNumeric() ? std::to_string(wish["age"].asInt()) : clip(wish["age"], 20);
    card["basic"]["sex"] = clip(wish["sex"], 40);
    for (auto k : kBackground) { auto t = clip(wish[key][k], 600); if (!t.empty()) card["background"][k] = t; }
    card["items"] = Json::Value(Json::arrayValue);
    for (const auto& it : wish["items"]) { auto n = it.isObject() ? clip(it["name"], 80) : clip(it, 80); if (!n.empty() && card["items"].size() < 12) { Json::Value i; i["name"] = n; i["qty"] = 1; card["items"].append(i); } }
    return card;
}
}  // namespace

Json::Value BotCards::schema() {
    // Loose on purpose: the builders below take what fits and fill in the rest.
    static const Json::Value s = json::parse(R"({"type":"object","required":["name"],"properties":{
        "name":{"type":"string","minLength":1},"speaking_style":{"type":"string"},"bio":{"type":"string"},
        "occupation":{"type":"string"},"age":{"type":["string","number"]},"sex":{"type":"string"},"items":{"type":"array"}}})");
    return s;
}

Json::Value BotCards::cocCard(const Json::Value& wish, bool pointBuy) {
    Json::Value card = story(wish, "background");
    for (auto k : kCharacteristics) card["characteristics"][k] = clampInt(wish["characteristics"][k], 15, 90, 50);
    // The skills wanted, most wanted first (never Cthulhu Mythos), at most twelve.
    std::vector<std::pair<std::string, int>> wants;
    if (wish["skills"].isObject())
        for (const auto& k : wish["skills"].getMemberNames()) {
            auto name = text::utf8Prefix(text::trim(k), 60);
            if (name.empty() || coc7::family(name) == "Cthulhu Mythos") continue;
            wants.push_back({name, clampInt(wish["skills"][k], 1, 99, 50)});
        }
    std::stable_sort(wants.begin(), wants.end(), [](auto& a, auto& b) { return a.second > b.second; });
    if (wants.size() > 12) wants.resize(12);
    card["skills"] = Json::Value(Json::objectValue);
    if (!pointBuy) { for (auto& [k, v] : wants) card["skills"][k] = v; return card; }
    // Point buy: the custom career with the eight skills wanted most (Credit Rating always takes career points), the
    // career points and then the hobby points spent toward the totals wanted.
    const auto& chars = card["characteristics"];
    const auto* custom = coc7::findCareer("自定义职业");
    int careerLeft = custom ? coc7::careerBudget(*custom, chars) : chars["EDU"].asInt() * 4;
    int hobbyLeft = coc7::hobbyBudget(chars);
    card["career"]["name"] = "自定义职业";
    card["career"]["choices"] = Json::Value(Json::arrayValue);
    card["career"]["specialties"] = Json::Value(Json::arrayValue);
    card["skill_points"] = Json::Value(Json::objectValue);
    for (auto& [k, want] : wants) {
        const bool credit = coc7::family(k) == "Credit Rating";
        const bool career = credit || card["career"]["specialties"].size() < 8;
        if (career && !credit) card["career"]["specialties"].append(k);
        int need = std::max(0, want - coc7::skillBase(k, chars));
        const int c = career ? std::min(need, careerLeft) : 0; careerLeft -= c; need -= c;
        const int h = std::min(need, hobbyLeft); hobbyLeft -= h;
        Json::Value p; p["career"] = c; p["hobby"] = h; p["growth"] = 0;
        card["skill_points"][k] = p;
    }
    auto report = coc7::apply(card);
    // Whatever the rules still refuse (a skill the career cannot take, a name they do not know) loses its points.
    for (const auto& v : report["violations"]) if (v.isMember("skill")) card["skill_points"].removeMember(v["skill"].asString());
    if (!report["violations"].empty()) coc7::apply(card);
    return card;
}

Json::Value BotCards::dndCard(const Json::Value& wish) {
    const auto& R = dnd2024::rules();
    Json::Value card = story(wish, "story");
    // The abilities in the order wanted, then the rest.
    std::vector<std::string> order;
    for (const auto& a : wish["abilities"]) {
        auto k = text::upper(text::trim(a.isString() ? a.asString() : std::string()));
        if (std::find(std::begin(kAbilities), std::end(kAbilities), k) != std::end(kAbilities) && std::find(order.begin(), order.end(), k) == order.end()) order.push_back(k);
    }
    for (auto* k : kAbilities) if (std::find(order.begin(), order.end(), k) == order.end()) order.push_back(k);
    auto rank = [&](const std::string& ab) { return std::find(order.begin(), order.end(), ab) - order.begin(); };
    const auto* cls = named(R["classes"], wish["class"]); if (!cls) cls = named(R["classes"], Json::Value("Fighter"));
    const auto* sp = named(R["species"], wish["species"]); if (!sp) sp = named(R["species"], Json::Value("Human"));
    // An unknown background: the one whose abilities suit the character best.
    const auto* bg = named(R["backgrounds"], wish["background"]);
    if (!bg) { long best = 1 << 20; for (const auto& b : R["backgrounds"]) { long score = 0; for (const auto& a : b["abilities"]) score += rank(a.asString()); if (score < best) { best = score; bg = &b; } } }
    Json::Value d(Json::objectValue);
    d["class"] = (*cls)["name"]; d["species"] = (*sp)["name"]; d["background"] = (*bg)["name"]; d["level"] = 1; d["method"] = "standard_array";
    for (std::size_t i = 0; i < order.size(); ++i) d["base"][order[i]] = R["standard_array"][Json::ArrayIndex(i)];
    // The background's increases: +2 and +1 to the two of its abilities that matter most to the character.
    std::vector<std::string> bgAbilities; for (const auto& a : (*bg)["abilities"]) bgAbilities.push_back(a.asString());
    std::stable_sort(bgAbilities.begin(), bgAbilities.end(), [&](auto& a, auto& b) { return rank(a) < rank(b); });
    d["increases"] = Json::Value(Json::objectValue);
    if (bgAbilities.size() >= 2) { d["increases"][bgAbilities[0]] = 2; d["increases"][bgAbilities[1]] = 1; }
    d["saves"] = (*cls)["saves"];
    // Skills: the background's, then the class's picks among those wanted (then its list in order), then the species' pick.
    std::vector<std::string> wanted;
    for (const auto& w : wish["skills"].isArray() ? wish["skills"] : Json::Value(Json::arrayValue))
        if (const auto* sk = named(R["skills"], w)) wanted.push_back((*sk)["name"].asString());
    if (wish["skills"].isObject()) for (const auto& k : wish["skills"].getMemberNames()) if (const auto* sk = named(R["skills"], Json::Value(k))) wanted.push_back((*sk)["name"].asString());
    std::set<std::string> have;
    for (const auto& s : (*bg)["skills"]) have.insert(s.asString());
    const auto& classList = (*cls)["skills"];
    auto pick = [&](const Json::Value& from, int count, bool preferOutside) {
        std::vector<std::string> pool;
        for (const auto& w : wanted) pool.push_back(w);
        for (const auto& s : from.empty() ? R["skills"] : from) pool.push_back(s.isObject() ? s["name"].asString() : s.asString());
        // The species' pick goes first to a skill the class cannot give, as the rules' check counts it.
        if (preferOutside) std::stable_partition(pool.begin(), pool.end(), [&](const std::string& k) { return !classList.empty() && !listed(classList, k); });
        for (const auto& k : pool) { if (count <= 0) break; if (have.count(k) || (!from.empty() && !listed(from, k))) continue; have.insert(k); --count; }
    };
    pick(classList, (*cls)["skill_count"].asInt(), false);
    const auto classPicked = have;
    pick((*sp)["skill_from"], (*sp)["extra_skills"].asInt(), true);
    auto setSkills = [&](const std::set<std::string>& s) { d["skills"] = Json::Value(Json::objectValue); for (const auto& k : s) d["skills"][k] = 1; };
    setSkills(have);
    // The rules' check pairs skills to their sources greedily; when it cannot place the species' pick, it is left out.
    if (!dnd2024::check(dnd2024::normalize(d))["violations"].empty()) setSkills(classPicked);
    // What follows from the build: speed, hit dice, hit points, armour class, the spellcasting ability (slots: the rules).
    auto mod = [](int score) { return (score >= 10 ? score - 10 : score - 11) / 2; };
    auto sc = dnd2024::scores(dnd2024::normalize(d));
    const int hd = (*cls)["hit_die"].asInt();
    d["speed"] = (*sp)["speed"]; d["hit_dice"] = "1d" + std::to_string(hd);
    d["hp_max"] = std::max(1, hd + mod(sc["CON"].asInt())); d["ac"] = 10 + mod(sc["DEX"].asInt()); d["initiative"] = 0;
    auto casting = kCasting.find((*cls)["name"].asString());
    d["spellcasting_ability"] = casting == kCasting.end() ? "" : casting->second;
    d["features"] = clip(wish["features"], 2000); d["spells"] = clip(wish["spells"], 2000);
    card["dnd"] = dnd2024::normalize(d);
    return card;
}

Json::Value BotCards::pbtaCard(const Json::Value& wish, const Json::Value& pack, const std::set<std::string>& takenBooks) {
    Json::Value card = story(wish, "story");
    // A playbook nobody at the table holds yet, when the one wanted is taken or unknown.
    const auto* book = named(pack["books"], wish["book"]);
    if (!book || takenBooks.count((*book)["id"].asString()))
        for (const auto& b : pack["books"]) if (!takenBooks.count(b["id"].asString())) { book = &b; break; }
    if (!book && !pack["books"].empty()) book = &pack["books"][0];
    Json::Value p(Json::objectValue);
    p["book"] = book ? (*book)["id"] : Json::Value("");
    auto values = [&](const char* key, int lo, int hi) {
        Json::Value out(Json::objectValue);
        if (wish[key].isObject()) for (const auto& k : wish[key].getMemberNames()) if (const auto* f = named(pack[key], Json::Value(k))) out[(*f)["id"].asString()] = clampInt(wish[key][k], lo, hi, 0);
        for (const auto& f : pack[key]) if (!out.isMember(f["id"].asString())) out[f["id"].asString()] = 0;
        return out;
    };
    p["stats"] = values("stats", -1, 3);
    p["resources"] = values("resources", 0, 99);
    p["conditions"] = Json::Value(Json::objectValue);
    card["pbta"] = p;
    return card;
}

void BotCards::say(const std::string& user, const std::string& channelId, const std::string& windowId, const std::string& key, const std::map<std::string, std::string>& vars) {
    Json::Value body; body["content"] = dice_.textsForChannel(channelId).render(key, vars); body["kind"] = "ooc"; body["visibility"] = "window";
    chat_.postMessage(auth_.channelAccess(user, channelId), windowId, body);
}

std::string BotCards::make(const std::string& botId, const std::string& channelId, const std::string& windowId, const std::string& idea) {
    auto bot = db_.queryOne("SELECT b.user_id, b.persona, b.speaking_style, u.display_name AS name, c.rule_system, c.description, c.era, c.bot_brief, c.point_buy "
                            "FROM server_bots b JOIN users u ON u.id=b.user_id JOIN channels c ON c.id=$2 WHERE b.id=$1", {botId, channelId});
    if (bot.isNull()) return "";
    const auto user = bot["user_id"].asString();
    const auto rs = rules::canonical(json::str(bot, "rule_system")).empty() ? std::string("coc7e") : rules::canonical(json::str(bot, "rule_system"));
    // One character per bot and channel.
    if (!db_.queryOne("SELECT id FROM characters WHERE channel_id=$1 AND user_id=$2 AND kind='pc' LIMIT 1", {channelId, user}).isNull()) return "";
    if (rs != "coc7e" && rs != "dnd2024" && rs != "pbta") {
        say(user, channelId, windowId, "bots.card_ask_gm", {{"game", rules::profile(rs).game}});
        return "";
    }
    LlmRequest req;
    req.channelId = channelId; req.task = "bot_card"; req.temperature = 0.9; req.maxTokens = 2000; req.responseSchema = schema();
    const std::string head = std::string(kSystem) + (rs == "coc7e" ? kCoc : rs == "dnd2024" ? kDnd : kPbta) + kStory + (rs == "coc7e" ? kCocAfter : rs == "dnd2024" ? kDndAfter : kPbtaAfter);
    req.system = replaceAll(head, "{BOT}", json::str(bot, "name"));
    Json::Value mock; mock["name"] = bot["name"]; mock["concept"] = idea; mock["rule_system"] = rs;
    // PbtA: the channel's rules as a player sees them, the playbooks nobody holds yet first.
    Json::Value pack; std::set<std::string> takenBooks;
    if (rs == "dnd2024") {
        const auto& R = dnd2024::rules();
        req.system = replaceAll(replaceAll(replaceAll(req.system, "{CLASSES}", names(R["classes"])), "{SPECIES}", names(R["species"])), "{BACKGROUNDS}", names(R["backgrounds"]));
    }
    if (rs == "pbta") {
        pack = pbta::read(db_, auth_.channelAccess(user, channelId));
        for (const auto& r : db_.queryJson("SELECT role_card->'pbta'->>'book' AS book FROM characters WHERE channel_id=$1 AND kind='pc' AND role_card->'pbta'->>'book' IS NOT NULL", {channelId}))
            takenBooks.insert(r["book"].asString());
        Json::Value rules(Json::objectValue);
        rules["name"] = pack["pack"]["name"];
        for (auto key : {"stats", "resources", "conditions"}) { rules[key] = Json::Value(Json::arrayValue); for (const auto& f : pack["pack"][key]) { Json::Value x; x["id"] = f["id"]; x["name"] = f["name"]; rules[key].append(x); } }
        rules["playbooks"] = Json::Value(Json::arrayValue);
        for (int pass = 0; pass < 2; ++pass)
            for (const auto& b : pack["pack"]["books"]) if (takenBooks.count(b["id"].asString()) == (pass == 1)) {
                Json::Value x; x["id"] = b["id"]; x["name"] = b["name"]; if (pass == 1) x["taken"] = true;
                x["moves"] = Json::Value(Json::arrayValue);
                for (const auto& m : pack["pack"]["moves"]) if (m["book"] == b["id"]) { Json::Value mv; mv["name"] = m["name"]; mv["trigger"] = text::utf8Prefix(m["trigger"].asString(), 300); x["moves"].append(mv); }
                rules["playbooks"].append(x);
                mock["books"].append(b["id"]);
            }
        mock["stats"] = Json::Value(Json::arrayValue); for (const auto& f : pack["pack"]["stats"]) mock["stats"].append(f["id"]);
        req.system += "\n\nTHE RULES (" + json::str(rules, "name") + "):\n" + text::utf8Prefix(json::dump(rules), 16000);
    }
    std::vector<std::string> parts{"WHO YOU ARE:\n" + (json::str(bot, "persona").empty() ? std::string("(a friendly, curious regular)") : json::str(bot, "persona"))};
    if (!json::str(bot, "description").empty()) parts.push_back("THE CAMPAIGN:\n" + json::str(bot, "description"));
    if (!json::str(bot, "era").empty()) parts.push_back("ERA: " + json::str(bot, "era"));
    if (!json::str(bot, "bot_brief").empty()) parts.push_back("WHAT THE GM TELLS THE BOTS:\n" + json::str(bot, "bot_brief"));
    const auto remembered = memory_.recall(botId, channelId, windowId, false);
    if (!remembered.empty()) parts.push_back(remembered);
    parts.push_back("WHAT YOU HAVE IN MIND: " + (idea.empty() ? std::string("(nothing yet: surprise them)") : idea));
    LlmMessage ask; ask.role = "user"; ask.content = text::join(parts, "\n\n"); req.messages.push_back(ask);
    req.mockContext = mock;
    auto out = llm_.runStructured(req);
    if (!out.ok) {
        ALOG_WARN << "bots: " << json::str(bot, "name") << " could not make a character: " << out.error;
        say(user, channelId, windowId, "bots.card_failed");
        return "";
    }
    const auto& wish = out.data;
    auto access = auth_.channelAccess(user, channelId);
    Json::Value create; create["name"] = clip(wish["name"], 80); create["kind"] = "pc"; create["speaking_style"] = clip(wish["speaking_style"], 400);
    if (create["name"].asString().empty()) create["name"] = json::str(bot, "name") + "'s character";
    const auto id = chat_.createCharacter(access, create)["id"].asString();
    try {
        Json::Value body; body["name"] = create["name"]; body["speaking_style"] = create["speaking_style"]; body["bio"] = clip(wish["bio"], 2000);
        body["role_card"] = rs == "dnd2024" ? dndCard(wish) : rs == "pbta" ? pbtaCard(wish, pack["pack"], takenBooks) : cocCard(wish, bot["point_buy"].asBool());
        if (rs == "pbta") body["pack_revision"] = pack["revision"];
        space_.updateCard(auth_.channelAccess(user, channelId), id, body);
    } catch (const std::exception& e) {
        ALOG_WARN << "bots: " << json::str(bot, "name") << "'s card was refused: " << e.what();
        db_.tx([&](pqxx::work& w) {
            Db::exec(w, "UPDATE chat_window_members SET character_id=NULL WHERE character_id=$1", {id});
            Db::exec(w, "DELETE FROM entities WHERE character_id=$1", {id});
            Db::exec(w, "DELETE FROM characters WHERE id=$1 AND user_id=$2", {id, user});
        });
        say(user, channelId, windowId, "bots.card_failed");
        return "";
    }
    const auto occupation = clip(wish["occupation"], 80);
    say(user, channelId, windowId, "bots.card_ready", {{"name", create["name"].asString()}, {"occupation", occupation.empty() ? "" : ", " + occupation}});
    return id;
}

} // namespace acerciae
