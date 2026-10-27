#include "Coc7Rules.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../dice/Dice.h"
#include <algorithm>
#include <map>
#include <set>

namespace acerciae::coc7 {
namespace {
const std::set<std::string> kFamilies = {"Art/Craft", "Fighting (Brawl)", "Firearms (Handgun)", "Language (Other)", "Science", "Pilot", "Survival", "Lore"};
// The family a canonical name belongs to when it is written as a specialisation.
std::string familyOfCanonical(const std::string& canon) {
    if (canon == "Fighting (Brawl)") return "Fighting";
    if (canon == "Firearms (Handgun)" || canon == "Firearms (Rifle/Shotgun)") return "Firearms";
    return canon;
}
// Bases of the specialisations the core book prices differently from their family.
int specialBase(const std::string& fam, const std::string& spec) {
    static const std::map<std::string, std::map<std::string, int>> t = {
        {"Fighting", {{"brawl", 25}, {"斗殴", 25}, {"axe", 15}, {"chainsaw", 10}, {"flail", 10}, {"garrote", 15}, {"spear", 20}, {"sword", 20}, {"whip", 5}, {"剑", 20}, {"矛", 20}, {"鞭", 5}, {"链锯", 10}}},
        {"Firearms", {{"handgun", 20}, {"手枪", 20}, {"rifle/shotgun", 25}, {"rifle", 25}, {"shotgun", 25}, {"步枪", 25}, {"霰弹枪", 25}, {"步/霰", 25}, {"bow", 15}, {"弓", 15}, {"弓术", 15}, {"smg", 15}, {"flamethrower", 10}, {"heavy weapons", 10}, {"machine gun", 10}}},
    };
    auto f = t.find(fam);
    if (f == t.end()) return -1;
    auto x = f->second.find(text::lower(text::trim(spec)));
    return x == f->second.end() ? -1 : x->second;
}
int familyBase(const std::string& fam) {
    if (fam == "Fighting" || fam == "Firearms") return 0;
    if (fam == "Art/Craft") return 5;
    if (fam == "Survival") return 10;
    return 1;   // Language (Other), Science, Pilot, Lore
}
int ch(const Json::Value& c, const char* k) { return c[k].isNumeric() ? c[k].asInt() : 0; }

std::vector<Career> load() {
    std::vector<Career> out;
    auto doc = json::parse(kCareersJson);
    auto canon = [](Json::Value& e) {
        auto raw = e["skill"].asString();
        auto c = dice::canonicalName(raw);
        // Family members are stored by family so "格斗" and "Fighting (Sword)" compare equal.
        e["skill"] = familyOfCanonical(c);
        e["label"] = raw;
    };
    for (auto& j : doc["careers"]) {
        Career c; c.id = j["id"].asInt(); c.name = j["name"].asString();
        if (j["credit"].isArray() && j["credit"].size() == 2) { c.creditMin = j["credit"][0].asInt(); c.creditMax = j["credit"][1].asInt(); }
        c.points = j["points"]; c.formula = j["formula"].asString(); c.description = j["description"].asString();
        c.fixed = j["fixed"]; for (auto& e : c.fixed) canon(e);
        c.choices = j["choices"]; for (auto& g : c.choices) for (auto& e : g["from"]) canon(e);
        c.free = j["free"].asInt();
        if (c.id == 1) c.free = 8;   // 自定义职业: up to eight skills of the player's choice, with the Keeper's blessing
        out.push_back(std::move(c));
    }
    return out;
}
} // namespace

const std::vector<Career>& careers() { static const std::vector<Career> v = load(); return v; }
const Career* findCareer(const std::string& name) {
    auto n = text::trim(name);
    for (auto& c : careers()) if (c.name == n) return &c;
    return nullptr;
}
std::string family(const std::string& key) {
    auto canon = dice::canonicalName(key);
    if (dice::baseCode(canon)) return familyOfCanonical(canon);
    auto t = text::trim(key);
    auto p = t.find(" (");
    if (p == std::string::npos) p = t.find("（");
    if (p == std::string::npos) return canon;
    auto fam = familyOfCanonical(dice::canonicalName(t.substr(0, p)));
    return fam;
}
static std::string specOf(const std::string& key) {
    auto t = text::trim(key);
    auto p = t.find(" ("); size_t open = 2;
    if (p == std::string::npos) { p = t.find("（"); open = 3; }
    if (p == std::string::npos) return "";
    auto s = t.substr(p + open);
    auto fullWidthClose = [&] { return s.size() >= 3 && s.compare(s.size() - 3, 3, "）") == 0; };
    while (!s.empty() && (s.back() == ')' || fullWidthClose())) { if (s.back() == ')') s.pop_back(); else s.erase(s.size() - 3); }
    return text::trim(s);
}
int skillBase(const std::string& key, const Json::Value& c, int customBase) {
    auto canon = dice::canonicalName(key);
    if (auto code = dice::baseCode(canon)) {
        if (*code == -2) return ch(c, "DEX") / 2;
        if (*code == -3) return ch(c, "EDU");
        return *code;
    }
    auto fam = family(key);
    if (fam == canon) return customBase;   // not a specialisation of anything we know
    int sp = specialBase(fam, specOf(key));
    return sp >= 0 ? sp : familyBase(fam);
}
int careerBudget(const Career& career, const Json::Value& c) {
    int total = 0;
    for (const auto& term : career.points) {
        int best = 0;
        for (const auto& a : term["attrs"]) best = std::max(best, ch(c, a.asCString()));
        total += best * json::toInt(term, "mult", 0);
    }
    return total;
}
int hobbyBudget(const Json::Value& c) { return ch(c, "INT") * 2; }

const Json::Value& rules() {
    static const Json::Value v = [] {
        Json::Value r;
        r["skills"] = Json::Value(Json::arrayValue);
        for (auto& d : dice::skillDefs()) { Json::Value s; s["name"] = d.name; s["base"] = d.base == -2 ? Json::Value("DEX/2") : d.base == -3 ? Json::Value("EDU") : Json::Value(d.base); r["skills"].append(s); }
        r["families"] = Json::Value(Json::arrayValue);
        for (auto f : {"Art/Craft", "Fighting", "Firearms", "Language (Other)", "Science", "Pilot", "Survival", "Lore"}) { Json::Value x; x["name"] = f; x["base"] = familyBase(f); r["families"].append(x); }
        r["careers"] = Json::Value(Json::arrayValue);
        for (auto& c : careers()) {
            Json::Value j; j["id"] = c.id; j["name"] = c.name;
            if (c.creditMin >= 0) { j["credit"].append(c.creditMin); j["credit"].append(c.creditMax); } else j["credit"] = Json::Value();
            j["points"] = c.points; j["formula"] = c.formula; j["fixed"] = c.fixed; j["choices"] = c.choices; j["free"] = c.free; j["description"] = c.description;
            r["careers"].append(j);
        }
        r["hobby_formula"] = "INT×2";
        return r;
    }();
    return v;
}

Json::Value apply(Json::Value& card) {
    Json::Value rep;
    const Json::Value& chars = card["characteristics"];
    int total = 0; for (auto k : {"STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU"}) total += ch(chars, k);
    rep["characteristics_total"] = total; rep["luck"] = ch(chars, "LUK");
    rep["violations"] = Json::Value(Json::arrayValue); rep["warnings"] = Json::Value(Json::arrayValue);
    auto violate = [&](const char* code, const std::string& msg, const std::string& skill = "") { Json::Value v; v["code"] = code; v["message"] = msg; if (!skill.empty()) v["skill"] = skill; rep["violations"].append(v); };
    auto warn = [&](const char* code, const std::string& msg) { Json::Value v; v["code"] = code; v["message"] = msg; rep["warnings"].append(v); };

    const Career* career = nullptr;
    auto careerName = json::str(card["career"], "name");
    if (!careerName.empty()) { career = findCareer(careerName); if (!career) violate("unknown_career", "choose a career from the list: " + careerName); }
    rep["career"] = career ? Json::Value(career->name) : Json::Value();
    rep["career_budget"] = career ? careerBudget(*career, chars) : 0;
    rep["hobby_budget"] = hobbyBudget(chars);

    // What career points may go to: fixed skills, the chosen options of each group, the player's specialties.
    std::set<std::string> allowed;
    auto member = [](const Json::Value& list, const std::string& fam) { for (const auto& e : list) if (e["skill"].asString() == fam) return true; return false; };
    if (career) {
        allowed.insert("Credit Rating");   // every career: the range above must be reached with career points
        for (const auto& e : career->fixed) allowed.insert(e["skill"].asString());
        const Json::Value& picks = card["career"]["choices"];
        for (Json::ArrayIndex g = 0; g < career->choices.size(); ++g) {
            const auto& group = career->choices[g];
            const Json::Value chosen = picks.isArray() && g < picks.size() && picks[g].isArray() ? picks[g] : Json::Value(Json::arrayValue);
            if ((int)chosen.size() > json::toInt(group, "pick", 1)) violate("invalid_choice", "option group " + std::to_string(g + 1) + " allows " + std::to_string(json::toInt(group, "pick", 1)) + " pick(s)");
            for (const auto& s : chosen) {
                auto fam = family(s.asString());
                if (!member(group["from"], fam)) { violate("invalid_choice", s.asString() + " is not an option of group " + std::to_string(g + 1), s.asString()); continue; }
                allowed.insert(fam);
            }
        }
        const Json::Value& spec = card["career"]["specialties"];
        if ((int)spec.size() > career->free) violate("too_many_specialties", career->name + " allows " + std::to_string(career->free) + " specialt" + (career->free == 1 ? "y" : "ies"));
        for (const auto& s : spec) allowed.insert(family(s.asString()));
    }
    rep["allowed"] = Json::Value(Json::arrayValue); for (auto& a : allowed) rep["allowed"].append(a);

    int careerSpent = 0, hobbySpent = 0;
    if (!card["skills"].isObject()) card["skills"] = Json::Value(Json::objectValue);
    const Json::Value& sp = card["skill_points"];
    if (sp.isObject()) for (const auto& key : sp.getMemberNames()) {
        const Json::Value& e = sp[key];
        int c = json::toInt(e, "career", 0), h = json::toInt(e, "hobby", 0), g = json::toInt(e, "growth", 0);
        auto canon = dice::canonicalName(key);
        if (canon == "Cthulhu Mythos" && (c || h)) violate("mythos", "Cthulhu Mythos cannot take skill points", key);
        if (c > 0 && !allowed.count(family(key)) && !allowed.count(canon)) violate("career_points_not_allowed", key + " is not one of the career's skills", key);
        int base = skillBase(key, chars, json::toInt(e, "base", 0));
        int totalSkill = base + c + h + g;
        if (totalSkill > 99) violate("over_99", key + " exceeds 99", key);
        careerSpent += c; hobbySpent += h;
        card["skills"][key] = totalSkill;
    }
    rep["career_spent"] = careerSpent; rep["hobby_spent"] = hobbySpent;
    if (careerSpent > rep["career_budget"].asInt()) violate("career_over", "career points " + std::to_string(careerSpent) + " exceed the budget " + std::to_string(rep["career_budget"].asInt()));
    if (hobbySpent > rep["hobby_budget"].asInt()) violate("hobby_over", "hobby points " + std::to_string(hobbySpent) + " exceed the budget " + std::to_string(rep["hobby_budget"].asInt()));
    if (career && career->creditMin >= 0) {
        int cr = card["skills"]["Credit Rating"].isNumeric() ? card["skills"]["Credit Rating"].asInt() : 0;
        if (cr < career->creditMin || cr > career->creditMax) warn("credit_rating", "Credit Rating " + std::to_string(cr) + " is outside " + career->name + "'s range " + std::to_string(career->creditMin) + "–" + std::to_string(career->creditMax));
    }
    return rep;
}
} // namespace acerciae::coc7
