#include "Dnd2024Rules.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../dice/Dnd.h"
#include <algorithm>
#include <map>
#include <set>

namespace acerciae::dnd2024 {

namespace {
const char* kAbilities[] = {"STR", "DEX", "CON", "INT", "WIS", "CHA"};

// Names: en, zh-CN, zh-TW (other languages show the English name).
Json::Value names3(const char* en, const char* zh, const char* tw) { Json::Value n; n["en"] = en; n["zh-CN"] = zh; n["zh-TW"] = tw; return n; }
Json::Value list(std::initializer_list<const char*> xs) { Json::Value a(Json::arrayValue); for (auto* x : xs) a.append(x); return a; }

Json::Value cls(const char* en, const char* zh, const char* tw, int hitDie, std::initializer_list<const char*> saves, int count, std::initializer_list<const char*> skills, const char* caster) {
    Json::Value c; c["name"] = en; c["names"] = names3(en, zh, tw); c["hit_die"] = hitDie; c["saves"] = list(saves);
    c["skill_count"] = count; c["skills"] = list(skills); c["caster"] = caster; return c;
}
Json::Value species(const char* en, const char* zh, const char* tw, int speed, int extra, std::initializer_list<const char*> from) {
    Json::Value s; s["name"] = en; s["names"] = names3(en, zh, tw); s["speed"] = speed; s["extra_skills"] = extra; s["skill_from"] = list(from); return s;
}
Json::Value background(const char* en, const char* zh, const char* tw, std::initializer_list<const char*> abilities, std::initializer_list<const char*> skills) {
    Json::Value b; b["name"] = en; b["names"] = names3(en, zh, tw); b["abilities"] = list(abilities); b["skills"] = list(skills); return b;
}
Json::Value slotRows(std::initializer_list<std::initializer_list<int>> rows) {
    Json::Value a(Json::arrayValue);
    for (auto& r : rows) { Json::Value x(Json::arrayValue); for (int v : r) x.append(v); a.append(x); }
    return a;
}

const Json::Value* findByName(const Json::Value& arr, const std::string& name) {
    auto key = text::lower(text::trim(name));
    if (key.empty()) return nullptr;
    for (const auto& x : arr) {
        if (text::lower(x["name"].asString()) == key) return &x;
        for (const auto& l : x["names"].getMemberNames()) if (text::lower(x["names"][l].asString()) == key) return &x;
    }
    return nullptr;
}
std::string clip(const std::string& s, size_t n) { return text::utf8Prefix(text::trim(s), n); }
int num(const Json::Value& v, int lo, int hi, int dflt) { if (!v.isNumeric() || v.isBool()) return dflt; return std::max(lo, std::min(hi, v.asInt())); }
Json::Value violation(const std::string& code, const std::string& message) { Json::Value v; v["code"] = code; v["message"] = message; return v; }
} // namespace

const Json::Value& rules() {
    static const Json::Value r = [] {
        Json::Value out;
        // SRD 5.2: hit die, saving throw proficiencies, skill choices (count, list) and spellcasting progression.
        out["classes"] = Json::Value(Json::arrayValue);
        auto& C = out["classes"];
        C.append(cls("Barbarian", "野蛮人", "野蠻人", 12, {"STR", "CON"}, 2, {"Animal Handling", "Athletics", "Intimidation", "Nature", "Perception", "Survival"}, "none"));
        C.append(cls("Bard", "吟游诗人", "吟遊詩人", 8, {"DEX", "CHA"}, 3, {}, "full"));
        C.append(cls("Cleric", "牧师", "牧師", 8, {"WIS", "CHA"}, 2, {"History", "Insight", "Medicine", "Persuasion", "Religion"}, "full"));
        C.append(cls("Druid", "德鲁伊", "德魯伊", 8, {"INT", "WIS"}, 2, {"Animal Handling", "Arcana", "Insight", "Medicine", "Nature", "Perception", "Religion", "Survival"}, "full"));
        C.append(cls("Fighter", "战士", "戰士", 10, {"STR", "CON"}, 2, {"Acrobatics", "Animal Handling", "Athletics", "History", "Insight", "Intimidation", "Persuasion", "Perception", "Survival"}, "none"));
        C.append(cls("Monk", "武僧", "武僧", 8, {"STR", "DEX"}, 2, {"Acrobatics", "Athletics", "History", "Insight", "Religion", "Stealth"}, "none"));
        C.append(cls("Paladin", "圣武士", "聖武士", 10, {"WIS", "CHA"}, 2, {"Athletics", "Insight", "Intimidation", "Medicine", "Persuasion", "Religion"}, "half"));
        C.append(cls("Ranger", "游侠", "遊俠", 10, {"STR", "DEX"}, 3, {"Animal Handling", "Athletics", "Insight", "Investigation", "Nature", "Perception", "Stealth", "Survival"}, "half"));
        C.append(cls("Rogue", "游荡者", "遊蕩者", 8, {"DEX", "INT"}, 4, {"Acrobatics", "Athletics", "Deception", "Insight", "Intimidation", "Investigation", "Perception", "Persuasion", "Sleight of Hand", "Stealth"}, "none"));
        C.append(cls("Sorcerer", "术士", "術士", 6, {"CON", "CHA"}, 2, {"Arcana", "Deception", "Insight", "Intimidation", "Persuasion", "Religion"}, "full"));
        C.append(cls("Warlock", "邪术师", "邪術師", 8, {"WIS", "CHA"}, 2, {"Arcana", "Deception", "History", "Intimidation", "Investigation", "Nature", "Religion"}, "pact"));
        C.append(cls("Wizard", "法师", "法師", 6, {"INT", "WIS"}, 2, {"Arcana", "History", "Insight", "Investigation", "Medicine", "Nature", "Religion"}, "full"));
        // Species: speed and the skill proficiencies a trait grants (Human: Skillful, any one; Elf: Keen Senses).
        out["species"] = Json::Value(Json::arrayValue);
        auto& S = out["species"];
        S.append(species("Dragonborn", "龙裔", "龍裔", 30, 0, {}));
        S.append(species("Dwarf", "矮人", "矮人", 30, 0, {}));
        S.append(species("Elf", "精灵", "精靈", 30, 1, {"Insight", "Perception", "Survival"}));
        S.append(species("Gnome", "侏儒", "侏儒", 30, 0, {}));
        S.append(species("Goliath", "歌利亚", "歌利亞", 35, 0, {}));
        S.append(species("Halfling", "半身人", "半身人", 30, 0, {}));
        S.append(species("Human", "人类", "人類", 30, 1, {}));
        S.append(species("Orc", "兽人", "獸人", 30, 0, {}));
        S.append(species("Tiefling", "提夫林", "提夫林", 30, 0, {}));
        // Backgrounds: the three abilities their increases go to, and their two skill proficiencies.
        out["backgrounds"] = Json::Value(Json::arrayValue);
        auto& B = out["backgrounds"];
        B.append(background("Acolyte", "侍僧", "侍僧", {"INT", "WIS", "CHA"}, {"Insight", "Religion"}));
        B.append(background("Criminal", "罪犯", "罪犯", {"DEX", "CON", "INT"}, {"Sleight of Hand", "Stealth"}));
        B.append(background("Sage", "贤者", "賢者", {"CON", "INT", "WIS"}, {"Arcana", "History"}));
        B.append(background("Soldier", "士兵", "士兵", {"STR", "DEX", "CON"}, {"Athletics", "Intimidation"}));
        // Point buy: 27 points, scores 8 to 15 before background increases.
        out["point_buy"]["budget"] = 27; out["point_buy"]["min"] = 8; out["point_buy"]["max"] = 15;
        const int costs[] = {0, 1, 2, 3, 4, 5, 7, 9};
        for (int s = 8; s <= 15; ++s) out["point_buy"]["costs"][std::to_string(s)] = costs[s - 8];
        out["standard_array"] = list({}); for (int v : {15, 14, 13, 12, 10, 8}) out["standard_array"].append(v);
        out["max_after_background"] = 20;
        // Spell slots per long rest by class level (index 0 = level 1): slots of spell levels 1-9.
        out["slots"]["full"] = slotRows({{2}, {3}, {4, 2}, {4, 3}, {4, 3, 2}, {4, 3, 3}, {4, 3, 3, 1}, {4, 3, 3, 2}, {4, 3, 3, 3, 1}, {4, 3, 3, 3, 2},
                                         {4, 3, 3, 3, 2, 1}, {4, 3, 3, 3, 2, 1}, {4, 3, 3, 3, 2, 1, 1}, {4, 3, 3, 3, 2, 1, 1}, {4, 3, 3, 3, 2, 1, 1, 1}, {4, 3, 3, 3, 2, 1, 1, 1},
                                         {4, 3, 3, 3, 2, 1, 1, 1, 1}, {4, 3, 3, 3, 3, 1, 1, 1, 1}, {4, 3, 3, 3, 3, 2, 1, 1, 1}, {4, 3, 3, 3, 3, 2, 2, 1, 1}});
        out["slots"]["half"] = slotRows({{2}, {2}, {3}, {3}, {4, 2}, {4, 2}, {4, 3}, {4, 3}, {4, 3, 2}, {4, 3, 2},
                                         {4, 3, 3}, {4, 3, 3}, {4, 3, 3, 1}, {4, 3, 3, 1}, {4, 3, 3, 2}, {4, 3, 3, 2}, {4, 3, 3, 3, 1}, {4, 3, 3, 3, 1}, {4, 3, 3, 3, 2}, {4, 3, 3, 3, 2}});
        // Warlock Pact Magic: how many slots, all of one level.
        const int pact[20][2] = {{1, 1}, {2, 1}, {2, 2}, {2, 2}, {2, 3}, {2, 3}, {2, 4}, {2, 4}, {2, 5}, {2, 5}, {3, 5}, {3, 5}, {3, 5}, {3, 5}, {3, 5}, {3, 5}, {4, 5}, {4, 5}, {4, 5}, {4, 5}};
        out["slots"]["pact"] = Json::Value(Json::arrayValue);
        for (auto& p : pact) { Json::Value x; x["slots"] = p[0]; x["level"] = p[1]; out["slots"]["pact"].append(x); }
        out["abilities"] = list({"STR", "DEX", "CON", "INT", "WIS", "CHA"});
        out["skills"] = Json::Value(Json::arrayValue);
        for (const auto& s : dice::dnd::skills()) { Json::Value x; x["name"] = s.name; x["ability"] = s.ability; out["skills"].append(x); }
        out["names"] = dice::dnd::names();
        out["source"] = "System Reference Document 5.2 (CC-BY-4.0)";
        return out;
    }();
    return r;
}

// Spell slots per Long Rest of a class at a level, from the tables ({} for a class without spellcasting).
static Json::Value classSlots(const std::string& cls, int level) {
    Json::Value slots(Json::objectValue);
    const Json::Value* c = findByName(rules()["classes"], cls);
    int i = std::max(1, std::min(20, level)) - 1;
    auto caster = c ? (*c)["caster"].asString() : std::string("none");
    if (caster == "pact") { const auto& p = rules()["slots"]["pact"][i]; slots[std::to_string(p["level"].asInt())] = p["slots"]; }
    else if (caster == "full" || caster == "half") {
        const auto& row = rules()["slots"][caster][i];
        for (Json::ArrayIndex n = 0; n < row.size(); ++n) slots[std::to_string(n + 1)] = row[n];
    }
    return slots;
}

Json::Value normalize(const Json::Value& in) {
    const Json::Value src = in.isObject() ? in : Json::Value(Json::objectValue);
    Json::Value d(Json::objectValue);
    for (auto k : {"class", "subclass", "species", "background"}) d[k] = clip(json::str(src, k), 60);
    d["level"] = num(src["level"], 1, 20, 1);
    auto method = json::str(src, "method", "point_buy");
    d["method"] = method == "standard_array" || method == "manual" ? method : "point_buy";
    for (auto part : {"base", "increases", "improvements"}) {
        Json::Value x(Json::objectValue);
        for (auto* ab : kAbilities) if (src[part].isMember(ab)) x[ab] = std::string(part) == "base" ? num(src[part][ab], 1, 30, 10) : num(src[part][ab], 0, std::string(part) == "increases" ? 2 : 10, 0);
        d[part] = x;
    }
    d["saves"] = Json::Value(Json::arrayValue);
    std::set<std::string> saves; for (const auto& s : src["saves"]) if (s.isString()) saves.insert(s.asString());
    for (auto* ab : kAbilities) if (saves.count(ab)) d["saves"].append(ab);
    d["skills"] = Json::Value(Json::objectValue);
    for (const auto& s : dice::dnd::skills()) if (src["skills"].isMember(s.name)) { int v = num(src["skills"][s.name], 0, 2, 0); if (v) d["skills"][s.name] = v; }
    d["ac"] = num(src["ac"], 0, 40, 10);
    d["hp_max"] = num(src["hp_max"], 0, 999, 0);
    d["speed"] = num(src["speed"], 0, 200, 30);
    d["initiative"] = num(src["initiative"], -10, 20, 0);
    d["hit_dice"] = clip(json::str(src, "hit_dice"), 16);
    auto sa = json::str(src, "spellcasting_ability");
    d["spellcasting_ability"] = std::find(std::begin(kAbilities), std::end(kAbilities), sa) != std::end(kAbilities) ? sa : "";
    d["slots"] = Json::Value(Json::objectValue);
    for (int lv = 1; lv <= 9; ++lv) { auto k = std::to_string(lv); if (src["slots"].isMember(k)) { int v = num(src["slots"][k], 0, 9, 0); if (v) d["slots"][k] = v; } }
    // A caster's card without slots of its own gets the class table's for its level.
    if (d["slots"].empty()) d["slots"] = classSlots(d["class"].asString(), d["level"].asInt());
    d["features"] = clip(json::str(src, "features"), 4000);
    d["spells"] = clip(json::str(src, "spells"), 4000);
    return d;
}

Json::Value scores(const Json::Value& d) {
    Json::Value s(Json::objectValue);
    for (auto* ab : kAbilities) {
        int v = d["base"].isMember(ab) ? d["base"][ab].asInt() : 10;
        v += d["increases"].isMember(ab) ? d["increases"][ab].asInt() : 0;
        v += d["improvements"].isMember(ab) ? d["improvements"][ab].asInt() : 0;
        s[ab] = std::min(30, v);
    }
    return s;
}

Json::Value check(const Json::Value& d) {
    const auto& R = rules();
    Json::Value rep; rep["method"] = d["method"]; rep["budget"] = R["point_buy"]["budget"]; rep["spent"] = 0;
    rep["violations"] = Json::Value(Json::arrayValue);
    auto& V = rep["violations"];
    auto method = d["method"].asString();
    int spent = 0;
    if (method == "manual") V.append(violation("method", "Point buy is on: choose point buy or the standard array for the ability scores."));
    else if (method == "standard_array") {
        std::vector<int> got, want = {15, 14, 13, 12, 10, 8};
        for (auto* ab : kAbilities) got.push_back(d["base"].isMember(ab) ? d["base"][ab].asInt() : 0);
        std::sort(got.rbegin(), got.rend());
        if (got != want) V.append(violation("standard_array", "Assign the standard array 15, 14, 13, 12, 10, 8: each value once."));
    } else {
        for (auto* ab : kAbilities) {
            int v = d["base"].isMember(ab) ? d["base"][ab].asInt() : 8;
            if (v < 8 || v > 15) { V.append(violation("score_range", std::string(ab) + " must be between 8 and 15 before background increases.")); continue; }
            spent += R["point_buy"]["costs"][std::to_string(v)].asInt();
        }
        if (spent > R["point_buy"]["budget"].asInt()) V.append(violation("budget", "The scores cost " + std::to_string(spent) + " points; the budget is 27."));
    }
    rep["spent"] = spent;
    // Background increases: +2 and +1, or +1 to three, among the background's abilities (any for a custom one).
    const auto* bg = findByName(R["backgrounds"], d["background"].asString());
    int sum = 0, twos = 0;
    for (auto* ab : kAbilities) {
        int v = d["increases"].isMember(ab) ? d["increases"][ab].asInt() : 0;
        if (!v) continue;
        sum += v; twos += v == 2;
        if (bg) { bool ok = false; for (const auto& a : (*bg)["abilities"]) ok = ok || a.asString() == ab; if (!ok) V.append(violation("increase_ability", std::string(ab) + " is not one of the " + (*bg)["name"].asString() + " background's abilities.")); }
        int base = d["base"].isMember(ab) ? d["base"][ab].asInt() : 8;
        if (base + v > R["max_after_background"].asInt()) V.append(violation("increase_cap", std::string(ab) + " cannot rise above 20."));
    }
    if (sum > 3 || twos > 1) V.append(violation("increases", "Background increases are +2 and +1, or +1 to three abilities."));
    // Class: known, with its saving throws; skills from the background, the class choices and the species.
    const auto* c = findByName(R["classes"], d["class"].asString());
    if (!d["class"].asString().empty() && !c) V.append(violation("class", "Choose a class from the System Reference Document."));
    if (c) {
        std::set<std::string> want, got;
        for (const auto& s : (*c)["saves"]) want.insert(s.asString());
        for (const auto& s : d["saves"]) got.insert(s.asString());
        if (want != got) V.append(violation("saves", "A " + (*c)["name"].asString() + " is proficient in " + text::join(std::vector<std::string>(want.begin(), want.end()), " and ") + " saving throws."));
    }
    std::set<std::string> left;
    for (const auto& k : d["skills"].getMemberNames()) left.insert(k);
    if (bg) for (const auto& s : (*bg)["skills"]) left.erase(s.asString());
    const auto* sp = findByName(R["species"], d["species"].asString());
    auto inList = [](const Json::Value& arr, const std::string& k) { if (arr.empty()) return true; for (const auto& x : arr) if (x.asString() == k) return true; return false; };
    int speciesLeft = sp ? (*sp)["extra_skills"].asInt() : 0;
    // A species pick first goes to a skill the class cannot give, then the class picks, then any species pick left.
    if (sp && c) for (auto it = left.begin(); it != left.end() && speciesLeft > 0;) {
        if (inList((*sp)["skill_from"], *it) && !inList((*c)["skills"], *it)) { it = left.erase(it); --speciesLeft; } else ++it;
    }
    int classLeft = c ? (*c)["skill_count"].asInt() : 0;
    for (auto it = left.begin(); it != left.end() && classLeft > 0;) { if (inList((*c)["skills"], *it)) { it = left.erase(it); --classLeft; } else ++it; }
    for (auto it = left.begin(); it != left.end() && speciesLeft > 0;) { if (inList((*sp)["skill_from"], *it)) { it = left.erase(it); --speciesLeft; } else ++it; }
    if (!left.empty()) V.append(violation("skills", "More skill proficiencies than the class, background and species give: " + text::join(std::vector<std::string>(left.begin(), left.end()), ", ") + "."));
    rep["scores"] = scores(d);
    return rep;
}

Json::Value mirrorAttrs(const Json::Value& attrsIn, const Json::Value& d) {
    Json::Value attrs = attrsIn.isObject() ? attrsIn : Json::Value(Json::objectValue);
    auto put = [&](const std::string& key, int v) { auto k = dice::dnd::storedKey(attrs, key); attrs[k.empty() ? key : k] = v; };
    auto get = [&](const std::string& key) { return dice::dnd::lookup(attrs, key); };
    auto s = scores(d);
    for (auto* ab : kAbilities) put(ab, s[ab].asInt());
    put("Level", d["level"].asInt());
    for (const auto& sk : dice::dnd::skills()) put(sk.name, d["skills"].isMember(sk.name) ? d["skills"][sk.name].asInt() : 0);
    std::set<std::string> saves; for (const auto& x : d["saves"]) saves.insert(x.asString());
    for (auto* ab : kAbilities) put(std::string(ab) + " Save", saves.count(ab) ? 1 : 0);
    put("AC", d["ac"].asInt()); put("HP Max", d["hp_max"].asInt()); put("Speed", d["speed"].asInt()); put("Initiative", d["initiative"].asInt());
    if (!get("HP").found) put("HP", d["hp_max"].asInt());
    Json::Value slots = d["slots"].isObject() && !d["slots"].empty() ? d["slots"] : classSlots(d["class"].asString(), d["level"].asInt());
    for (int lv = 1; lv <= 9; ++lv) {
        auto k = std::to_string(lv);
        int mx = slots.isMember(k) ? slots[k].asInt() : 0;
        auto cur = get("Slot " + k);
        if (!mx && !get("Slot " + k + " Max").found) continue;
        put("Slot " + k + " Max", mx);
        put("Slot " + k, cur.found ? std::min(cur.value, mx) : mx);
    }
    return attrs;
}

} // namespace acerciae::dnd2024
