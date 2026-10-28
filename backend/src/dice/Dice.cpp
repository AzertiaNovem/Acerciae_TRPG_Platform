#include "Dice.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include <algorithm>
#include <cctype>
#include <climits>
#include <cstring>
#include <mutex>
#include <set>

namespace acerciae::dice {

// ---- rng ---------------------------------------------------------------------------------------------
int RandomRng::roll(int sides) {
    thread_local std::mt19937_64 gen{std::random_device{}()};
    if (sides <= 1) return 1;
    return std::uniform_int_distribution<int>(1, sides)(gen);
}
int SeqRng::roll(int sides) {
    int v = i_ < v_.size() ? v_[i_++] : 1;
    return std::max(1, std::min(v, std::max(1, sides)));
}
namespace {
struct ConstRng : Rng { bool max; explicit ConstRng(bool m) : max(m) {} int roll(int sides) override { return max ? std::max(1, sides) : 1; } };

bool isAsciiSpace(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }
bool isDigit(char c) { return c >= '0' && c <= '9'; }
bool isNonAscii(char c) { return (unsigned char)c >= 0x80; }
std::string replaceAll(std::string s, const std::string& from, const std::string& to) {
    for (std::size_t p = 0; (p = s.find(from, p)) != std::string::npos; p += to.size()) s.replace(p, from.size(), to);
    return s;
}
// Full-width punctuation that Chinese IMEs produce is folded to ASCII before parsing.
std::string foldPunct(std::string s) {
    for (auto [a, b] : std::initializer_list<std::pair<const char*, const char*>>{{"。", "."}, {"．", "."}, {"：", ":"}, {"，", ","}, {"；", ";"}, {"＋", "+"}, {"－", "-"}, {"／", "/"}, {"＃", "#"}, {"（", "("}, {"）", ")"}})
        s = replaceAll(std::move(s), a, b);
    return s;
}
std::string itos(long long v) { return std::to_string(v); }
}

// ---- expressions ---------------------------------------------------------------------------------------
namespace {
struct Part { long long v = 0; std::string d; };
class Parser {
public:
    Parser(std::string s, Rng& rng, int defSides) : s_(std::move(s)), rng_(rng), def_(defSides) {}
    Part run() {
        if (s_.empty() || s_.size() > 200) fail();
        auto r = expr();
        if (p_ != s_.size()) fail();
        return r;
    }
private:
    [[noreturn]] void fail() { throw DiceError("bad expression"); }
    char peek() const { return p_ < s_.size() ? s_[p_] : '\0'; }
    long long number() { long long v = 0; std::size_t start = p_; while (isDigit(peek())) { v = v * 10 + (s_[p_++] - '0'); if (v > 1000000) fail(); } if (p_ == start) fail(); return v; }
    static long long clampv(long long v) { if (v > 1000000000LL || v < -1000000000LL) throw DiceError("bad expression"); return v; }
    Part expr() {
        auto l = term();
        while (peek() == '+' || peek() == '-') { char op = s_[p_++]; auto r = term(); l.v = clampv(op == '+' ? l.v + r.v : l.v - r.v); l.d += op; l.d += r.d; }
        return l;
    }
    Part term() {
        auto l = factor();
        while (peek() == '*' || peek() == '/') {
            char op = s_[p_++]; auto r = factor();
            if (op == '/' && r.v == 0) fail();
            l.v = clampv(op == '*' ? l.v * r.v : l.v / r.v); l.d += op; l.d += r.d;
        }
        return l;
    }
    Part factor() {
        if (peek() == '-') { ++p_; auto f = factor(); f.v = -f.v; f.d = "-" + f.d; return f; }
        if (peek() == '(') { ++p_; auto e = expr(); if (peek() != ')') fail(); ++p_; e.d = "(" + e.d + ")"; return e; }
        long long count = 1; bool hasCount = false;
        if (isDigit(peek())) { count = number(); hasCount = true; }
        if (peek() != 'd' && peek() != 'D') { if (!hasCount) fail(); return Part{count, itos(count)}; }
        ++p_;
        long long sides = def_;
        if (peek() == '%') { ++p_; sides = 100; } else if (isDigit(peek())) sides = number();
        if (count < 1 || count > 100 || sides < 1 || sides > 1000) fail();
        long long keep = count; bool keepHigh = true;
        if (peek() == 'k' || peek() == 'K') {
            ++p_;
            if (peek() == 'h' || peek() == 'H') ++p_; else if (peek() == 'l' || peek() == 'L') { ++p_; keepHigh = false; }
            keep = number(); if (keep < 1 || keep > count) fail();
        }
        std::vector<int> rolls; for (long long i = 0; i < count; ++i) rolls.push_back(rng_.roll((int)sides));
        std::vector<std::size_t> order(rolls.size()); for (std::size_t i = 0; i < order.size(); ++i) order[i] = i;
        std::stable_sort(order.begin(), order.end(), [&](auto a, auto b) { return keepHigh ? rolls[a] > rolls[b] : rolls[a] < rolls[b]; });
        std::set<std::size_t> kept(order.begin(), order.begin() + keep);
        long long total = 0; std::string kd, dd;
        for (std::size_t i = 0; i < rolls.size(); ++i) {
            if (kept.count(i)) { total += rolls[i]; if (!kd.empty()) kd += "+"; kd += itos(rolls[i]); }
            else { dd += "~" + itos(rolls[i]); }
        }
        std::string d = (count == 1 && dd.empty()) ? kd : "[" + kd + dd + "]";
        return Part{total, d};
    }
    std::string s_; Rng& rng_; int def_; std::size_t p_ = 0;
};
std::string stripSpaces(const std::string& s) { std::string o; for (char c : s) if (!isAsciiSpace(c)) o += c; return o; }
}

ExprResult evaluate(const std::string& expr, Rng& rng, int defaultSides) {
    Parser p(stripSpaces(foldPunct(expr)), rng, defaultSides);
    auto r = p.run();
    return ExprResult{(int)r.v, r.d};
}
bool isExpression(const std::string& s) {
    ConstRng one(false);
    try { evaluate(s, one); return true; } catch (const DiceError&) { return false; }
}

// ---- attributes ---------------------------------------------------------------------------------------
namespace {
// base: >=0 fixed CoC7 base value, -1 none (characteristics), -2 half DEX, -3 EDU
struct AttrDef { const char* name; int base; std::vector<const char*> aliases; };
const std::vector<AttrDef>& attrDefs() {
    static const std::vector<AttrDef> defs = {
        {"STR", -1, {"strength", "力量"}}, {"CON", -1, {"constitution", "体质"}}, {"SIZ", -1, {"size", "体型"}},
        {"DEX", -1, {"dexterity", "敏捷"}}, {"APP", -1, {"appearance", "外貌"}}, {"INT", -1, {"intelligence", "idea", "智力", "灵感"}},
        {"POW", -1, {"power", "意志"}}, {"EDU", -1, {"education", "know", "教育", "知识"}}, {"Luck", -1, {"luk", "幸运", "运气"}},
        {"SAN", -1, {"sanity", "理智", "理智值", "san值"}}, {"HP", -1, {"hitpoints", "生命", "生命值", "体力"}},
        {"MP", -1, {"magicpoints", "魔法", "魔法值"}}, {"MOV", -1, {"move", "移动", "移动力"}},
        {"Accounting", 5, {"会计"}}, {"Anthropology", 1, {"人类学"}}, {"Appraise", 5, {"估价"}}, {"Archaeology", 1, {"考古学", "考古"}},
        {"Art/Craft", 5, {"art", "craft", "技艺", "艺术", "手艺"}}, {"Charm", 15, {"魅惑", "取悦"}}, {"Climb", 20, {"攀爬"}},
        {"Credit Rating", 0, {"credit", "cr", "信用", "信用评级", "信誉"}}, {"Cthulhu Mythos", 0, {"mythos", "cm", "克苏鲁神话", "克苏鲁"}},
        {"Disguise", 5, {"乔装"}}, {"Dodge", -2, {"闪避"}}, {"Drive Auto", 20, {"drive", "汽车驾驶", "汽车"}},
        {"Electrical Repair", 10, {"电气维修", "电器维修"}}, {"Fast Talk", 5, {"话术", "快速交谈"}},
        {"Fighting (Brawl)", 25, {"brawl", "fighting", "格斗", "斗殴"}}, {"Firearms (Handgun)", 20, {"handgun", "pistol", "手枪", "射击"}},
        {"Firearms (Rifle/Shotgun)", 25, {"rifle", "shotgun", "步枪", "霰弹枪", "步霰"}}, {"First Aid", 30, {"急救"}},
        {"History", 5, {"历史"}}, {"Intimidate", 15, {"恐吓"}}, {"Jump", 20, {"跳跃"}}, {"Language (Own)", -3, {"ownlanguage", "母语"}},
        {"Law", 5, {"法律"}}, {"Library Use", 20, {"library", "图书馆", "图书馆使用"}}, {"Listen", 20, {"聆听"}},
        {"Locksmith", 1, {"锁匠", "开锁"}}, {"Mechanical Repair", 10, {"机械维修"}}, {"Medicine", 1, {"医学"}},
        {"Natural World", 10, {"博物学", "自然学"}}, {"Navigate", 10, {"导航"}}, {"Occult", 5, {"神秘学"}},
        {"Operate Heavy Machinery", 1, {"heavymachinery", "操作重型机械", "重型机械"}}, {"Persuade", 10, {"说服"}},
        {"Pilot", 1, {"驾驶"}}, {"Psychology", 10, {"心理学"}}, {"Psychoanalysis", 1, {"精神分析"}}, {"Ride", 5, {"骑术", "骑乘"}},
        {"Science", 1, {"科学"}}, {"Sleight of Hand", 10, {"sleight", "妙手"}}, {"Spot Hidden", 25, {"spot", "侦查", "侦察"}},
        {"Stealth", 20, {"潜行"}}, {"Survival", 10, {"生存"}}, {"Swim", 20, {"游泳"}}, {"Throw", 20, {"投掷"}}, {"Track", 10, {"追踪"}},
        // Skills the community COC7 sheet lists beyond the core table.
        {"Language (Other)", 1, {"otherlanguage", "外语", "其他语言"}}, {"Computer Use", 5, {"computer", "计算机", "计算机使用", "电脑"}},
        {"Electronics", 1, {"电子学"}}, {"Animal Handling", 5, {"动物驯养", "驯兽", "驯养"}}, {"Diving", 1, {"潜水"}},
        {"Demolitions", 1, {"爆破"}}, {"Hypnosis", 1, {"催眠"}}, {"Lip Reading", 1, {"读唇"}}, {"Artillery", 1, {"炮术"}}, {"Lore", 1, {"学识"}},
    };
    return defs;
}
const std::map<std::string, const AttrDef*>& aliasIndex() {
    static const std::map<std::string, const AttrDef*> idx = [] {
        std::map<std::string, const AttrDef*> m;
        for (auto& d : attrDefs()) { m[normKey(d.name)] = &d; for (auto* a : d.aliases) m[normKey(a)] = &d; }
        return m;
    }();
    return idx;
}
const AttrDef* defFor(const std::string& raw) {
    auto& idx = aliasIndex();
    auto it = idx.find(normKey(raw));
    return it == idx.end() ? nullptr : it->second;
}
int intOf(const Json::Value& v) { return v.isInt() ? v.asInt() : v.isDouble() ? (int)v.asDouble() : v.isString() ? std::atoi(v.asCString()) : 0; }
}

std::string normKey(const std::string& raw) {
    std::string s = foldPunct(raw), o;
    for (char c : s) {
        if (isAsciiSpace(c) || c == '_' || c == '-' || c == '(' || c == ')' || c == '/' || c == '.' || c == '\'' || c == ':') continue;
        o += isNonAscii(c) ? c : (char)std::tolower((unsigned char)c);
    }
    return o;
}
std::vector<SkillDef> skillDefs() {
    std::vector<SkillDef> out;
    for (auto& d : attrDefs()) if (d.base != -1) out.push_back({d.name, d.base});
    return out;
}
std::optional<int> baseCode(const std::string& raw) {
    auto* d = defFor(raw);
    if (!d || d->base == -1) return std::nullopt;
    return d->base;
}
std::string canonicalName(const std::string& raw) {
    auto* d = defFor(raw);
    return d ? std::string(d->name) : text::trim(raw);
}
std::string storedKey(const Json::Value& attrs, const std::string& raw) {
    if (!attrs.isObject()) return "";
    auto want = normKey(canonicalName(raw)), rawKey = normKey(raw);
    for (auto& k : attrs.getMemberNames()) {
        auto nk = normKey(k);
        if (nk == want || nk == rawKey || normKey(canonicalName(k)) == want) return k;
    }
    return "";
}
AttrValue lookup(const Json::Value& attrs, const std::string& raw) {
    AttrValue r; r.name = canonicalName(raw);
    auto key = storedKey(attrs, raw);
    if (!key.empty()) { r.found = true; r.value = intOf(attrs[key]); r.name = key; return r; }
    auto* d = defFor(raw);
    if (!d) return r;
    if (d->base >= 0) { r.found = true; r.isBase = true; r.value = d->base; }
    else if (d->base == -2) { auto dex = storedKey(attrs, "DEX"); if (!dex.empty()) { r.found = true; r.isBase = true; r.value = intOf(attrs[dex]) / 2; } }
    else if (d->base == -3) { auto edu = storedKey(attrs, "EDU"); if (!edu.empty()) { r.found = true; r.isBase = true; r.value = intOf(attrs[edu]); } }
    return r;
}
Json::Value normalizeSheet(const Json::Value& sheetIn) {
    Json::Value sheet = sheetIn.isObject() ? sheetIn : Json::Value(Json::objectValue);
    Json::Value attrs = sheet["attrs"].isObject() ? sheet["attrs"] : Json::Value(Json::objectValue);
    auto absorb = [&](Json::Value& from) {
        std::vector<std::string> moved;
        for (auto& k : from.getMemberNames()) {
            if (k == "attrs" || !from[k].isNumeric() || from[k].isBool()) continue;
            if (storedKey(attrs, k).empty()) attrs[canonicalName(k)] = intOf(from[k]);
            moved.push_back(k);
        }
        for (auto& k : moved) from.removeMember(k);
    };
    absorb(sheet);
    if (sheet["skills"].isObject()) { absorb(sheet["skills"]); if (sheet["skills"].empty()) sheet.removeMember("skills"); }
    else sheet.removeMember("skills");
    sheet["attrs"] = attrs;
    return sheet;
}

// ---- success levels -----------------------------------------------------------------------------------
Level successLevel(int roll, int value) {
    if (roll == 1) return Level::Critical;
    if (roll >= 100 || (value < 50 && roll >= 96)) return Level::Fumble;
    if (roll <= value / 5) return Level::Extreme;
    if (roll <= value / 2) return Level::Hard;
    if (roll <= value) return Level::Regular;
    return Level::Failure;
}
const char* levelKey(Level l) {
    switch (l) {
        case Level::Critical: return "level.critical"; case Level::Extreme: return "level.extreme"; case Level::Hard: return "level.hard";
        case Level::Regular: return "level.regular"; case Level::Failure: return "level.failure"; default: return "level.fumble";
    }
}
D100 rollD100(Rng& rng, int bonus, int penalty) {
    D100 r;
    int net = bonus - penalty;
    if (net == 0) { r.roll = rng.roll(100); return r; }
    int units = rng.roll(10) - 1;
    int n = std::min(3, std::abs(net));
    int best = -1;
    for (int i = 0; i <= n; ++i) {
        int t = rng.roll(10) - 1; r.tens.push_back(t * 10);
        int v = t * 10 + units; if (v == 0) v = 100;
        if (best < 0 || (net > 0 ? v < best : v > best)) best = v;
    }
    r.roll = best;
    return r;
}

// ---- texts ------------------------------------------------------------------------------------------
const Json::Value& builtinTexts(const std::string& lang) {
    static const Json::Value en = json::parse(R"JSON({
        "attr.value": "{name}'s {attr} is {value}",
        "attr.value_base": "{name}'s {attr} is {value} (base value)",
        "attr.missing": "{name} has no {attr} value yet — set it with .st {attr} 50",
        "check.result": "{name}'s {difficulty}{attr} check{reason}: D100={roll}/{target} — {level}",
        "difficulty.hard": "Hard ",
        "difficulty.extreme": "Extreme ",
        "dice.bonus": " (bonus dice: {tens})",
        "dice.penalty": " (penalty dice: {tens})",
        "level.critical": "Critical Success!",
        "level.extreme": "Extreme Success",
        "level.hard": "Hard Success",
        "level.regular": "Success",
        "level.failure": "Failure",
        "level.fumble": "Fumble!",
        "roll.result": "{name} rolls{reason}: {expr}={result}",
        "roll.hidden_notice": "{name} rolled dice in secret.",
        "sc.result": "{name}'s Sanity check: D100={roll}/{san} — {level}. SAN lost {loss}, now {san_new}",
        "sc.temporary": "Lost {loss} SAN in one go — roll INT; on a success, temporary insanity sets in.",
        "sc.zero": "SAN has reached 0 — permanent insanity.",
        "st.set": "{name}: {list}",
        "st.modify": "{name}: {attr} {old} → {new} ({delta})",
        "st.show": "{name}'s attributes: {list}",
        "st.show_empty": "{name} has no attributes recorded yet.",
        "st.delete": "{name}: removed {list}",
        "st.clear": "{name}: all attributes cleared",
        "en.success": "{name}'s {attr} growth check: D100={roll}/{value} — improved by {gain}, now {new}",
        "en.failure": "{name}'s {attr} growth check: D100={roll}/{value} — no improvement",
        "en.mythos": "Cthulhu Mythos cannot be improved by experience",
        "en.san_bonus": "{attr} reached 90: {name} gains {gain} SAN (2D6), now {new}",
        "hint.roll": "{name} rolls {expr}",
        "hint.target": " ({difficulty}target ≤ {target})",
        "hint.set": "set {list}",
        "reason": " ({reason})",
        "error.no_character": "Choose a character to speak as before using {command}.",
        "error.expression": "Could not read the dice expression “{expr}”.",
        "error.usage": "Usage: {usage}"
    })JSON");
    static const Json::Value zh = json::parse(R"JSON({
        "attr.value": "{name}的{attr}为{value}",
        "attr.value_base": "{name}的{attr}为{value}（基础值）",
        "attr.missing": "{name}还没有{attr}的数值，可以用 .st {attr}50 设置",
        "check.result": "{name}进行{difficulty}{attr}检定{reason}: D100={roll}/{target} {level}",
        "difficulty.hard": "困难",
        "difficulty.extreme": "极难",
        "dice.bonus": "（奖励骰: {tens}）",
        "dice.penalty": "（惩罚骰: {tens}）",
        "level.critical": "大成功！",
        "level.extreme": "极难成功",
        "level.hard": "困难成功",
        "level.regular": "成功",
        "level.failure": "失败",
        "level.fumble": "大失败！",
        "roll.result": "{name}掷骰{reason}: {expr}={result}",
        "roll.hidden_notice": "{name}进行了一次暗骰",
        "sc.result": "{name}的理智检定: D100={roll}/{san} {level}，理智损失{loss}，当前{san_new}",
        "sc.temporary": "单次损失{loss}点理智——请进行智力检定，成功则陷入临时性疯狂。",
        "sc.zero": "理智归零——永久性疯狂。",
        "st.set": "{name}: {list}",
        "st.modify": "{name}: {attr} {old} → {new}（{delta}）",
        "st.show": "{name}的属性: {list}",
        "st.show_empty": "{name}还没有记录任何属性",
        "st.delete": "{name}: 已删除 {list}",
        "st.clear": "{name}: 已清空所有属性",
        "en.success": "{name}的{attr}成长检定: D100={roll}/{value} 成功，增加{gain}点，当前{new}",
        "en.failure": "{name}的{attr}成长检定: D100={roll}/{value} 失败，没有成长",
        "en.mythos": "克苏鲁神话不能通过成长检定提升",
        "en.san_bonus": "{attr}达到90：{name}获得{gain}点理智（2D6），当前{new}",
        "hint.roll": "{name}掷骰 {expr}",
        "hint.target": "（{difficulty}目标 ≤ {target}）",
        "hint.set": "设置 {list}",
        "reason": "（{reason}）",
        "error.no_character": "使用 {command} 之前请先选择要扮演的角色",
        "error.expression": "无法识别骰子表达式「{expr}」",
        "error.usage": "用法: {usage}"
    })JSON");
    return lang.rfind("zh", 0) == 0 ? zh : en;
}
std::vector<std::string> textKeys() { return builtinTexts("en").getMemberNames(); }

std::string TextSet::get(const std::string& key) const {
    if (overrides_.isObject() && overrides_[key].isString() && !overrides_[key].asString().empty()) return overrides_[key].asString();
    auto& b = builtinTexts(base_);
    if (b[key].isString()) return b[key].asString();
    auto& en = builtinTexts("en");
    return en[key].isString() ? en[key].asString() : key;
}
std::string TextSet::render(const std::string& key, const std::map<std::string, std::string>& vars) const {
    auto t = get(key);
    std::string out;
    for (std::size_t i = 0; i < t.size();) {
        if (t[i] == '{') {
            auto j = t.find('}', i);
            if (j != std::string::npos) {
                auto it = vars.find(t.substr(i + 1, j - i - 1));
                if (it != vars.end()) { out += it->second; i = j + 1; continue; }
            }
        }
        out += t[i++];
    }
    return out;
}

// ---- command parsing ----------------------------------------------------------------------------------
std::optional<Command> parseCommand(const std::string& content) {
    auto s = text::trim(content);
    if (s.rfind("。", 0) == 0) s = "." + s.substr(std::strlen("。"));
    else if (s.rfind("．", 0) == 0) s = "." + s.substr(std::strlen("．"));
    if (s.size() < 2 || s[0] != '.') return std::nullopt;
    auto rest = s.substr(1);
    static const std::vector<std::pair<const char*, const char*>> cmds = {
        {"rah", "ra"}, {"rch", "ra"}, {"ra", "ra"}, {"rc", "ra"}, {"rh", "r"}, {"r", "r"}, {"sc", "sc"}, {"st", "st"}, {"en", "en"}};
    for (auto& [lit, name] : cmds) {
        auto n = std::strlen(lit);
        if (rest.size() < n) continue;
        bool match = true;
        for (std::size_t i = 0; i < n; ++i) if (std::tolower((unsigned char)rest[i]) != lit[i]) { match = false; break; }
        if (!match) continue;
        if (rest.size() > n) {
            char c = rest[n];
            bool ok = isAsciiSpace(c) || isDigit(c) || isNonAscii(c) || std::strchr("(%#+-/", c) != nullptr || (std::string(lit) == "r" && (c == 'd' || c == 'D'));
            if (!ok) continue;
        }
        Command cmd; cmd.name = name; cmd.args = text::trim(rest.substr(n)); cmd.raw = "." + std::string(lit);
        cmd.hidden = std::string(lit) == "rah" || std::string(lit) == "rch" || std::string(lit) == "rh";
        return cmd;
    }
    return std::nullopt;
}

// ---- execution ---------------------------------------------------------------------------------------
namespace {
using Vars = std::map<std::string, std::string>;

bool startsWithCi(const std::string& s, const std::string& p) {
    if (s.size() < p.size()) return false;
    for (std::size_t i = 0; i < p.size(); ++i) if (std::tolower((unsigned char)s[i]) != std::tolower((unsigned char)p[i])) return false;
    return true;
}
int takeRepeat(std::string& s) {
    std::size_t i = 0; while (i < s.size() && isDigit(s[i])) ++i;
    if (i == 0 || i >= s.size() || s[i] != '#') return 1;
    int n = std::atoi(s.substr(0, i).c_str());
    s = text::trim(s.substr(i + 1));
    return std::max(1, std::min(n, 10));
}

struct NameSplit { std::string name; std::optional<int> value; int modifier = 0; std::string reason; };
// "spot hidden 60+10 for the clue" -> {Spot Hidden, 60, +10, "for the clue"}. The longest prefix that names a known
// attribute wins; otherwise the name runs up to the first space, digit or sign.
NameSplit splitName(const std::string& restIn, const Json::Value& attrs) {
    NameSplit r;
    auto rest = text::trim(restIn);
    std::vector<std::size_t> cuts;
    for (std::size_t i = 1; i < rest.size(); ++i) {
        char c = rest[i];
        if (isAsciiSpace(c) || isDigit(c) || c == '+' || c == '-') cuts.push_back(i);
    }
    cuts.push_back(rest.size());
    std::size_t chosen = std::string::npos;
    for (auto it = cuts.rbegin(); it != cuts.rend(); ++it) {
        auto cand = text::trim(rest.substr(0, *it));
        if (cand.empty() || isDigit(cand[0])) continue;
        if (!storedKey(attrs, cand).empty() || defFor(cand)) { chosen = *it; break; }
    }
    if (chosen == std::string::npos) {
        chosen = rest.empty() || isDigit(rest[0]) ? 0 : cuts.front();
        if (!rest.empty() && (rest[0] == '+' || rest[0] == '-')) chosen = 0;
    }
    r.name = text::trim(rest.substr(0, chosen));
    std::size_t p = chosen;
    auto skipSpaces = [&] { while (p < rest.size() && isAsciiSpace(rest[p])) ++p; };
    skipSpaces();
    if (p < rest.size() && isDigit(rest[p])) {
        std::size_t q = p; while (q < rest.size() && isDigit(rest[q])) ++q;
        r.value = std::atoi(rest.substr(p, std::min<std::size_t>(q - p, 6)).c_str()); p = q;
    }
    for (;;) {
        std::size_t save = p; skipSpaces();
        if (p < rest.size() && (rest[p] == '+' || rest[p] == '-')) {
            char sign = rest[p++]; skipSpaces();
            std::size_t q = p; while (q < rest.size() && isDigit(rest[q])) ++q;
            if (q == p) { p = save; break; }
            int v = std::atoi(rest.substr(p, std::min<std::size_t>(q - p, 6)).c_str());
            r.modifier += sign == '+' ? v : -v; p = q;
        } else { p = save; break; }
    }
    r.reason = text::trim(rest.substr(std::min(p, rest.size())));
    return r;
}

std::string reasonVar(const TextSet& t, const std::string& reason) { return reason.empty() ? "" : t.render("reason", {{"reason", reason}}); }
[[noreturn]] void usage(const TextSet& t, const std::string& u) { throw DiceError(t.render("error.usage", {{"usage", u}})); }
[[noreturn]] void noCharacter(const TextSet& t, const Command& c) { throw DiceError(t.render("error.no_character", {{"command", c.raw}})); }
ExprResult evalOrThrow(const TextSet& t, const std::string& e, Rng& rng) {
    try { return evaluate(e, rng); } catch (const DiceError&) { throw DiceError(t.render("error.expression", {{"expr", e}})); }
}
std::string resultText(const ExprResult& r) { auto tot = itos(r.total); return r.detail == tot ? tot : r.detail + "=" + tot; }

// ---- .r ----
struct RollArgs { int times = 1; std::string expr = "1d100"; std::string reason; };
RollArgs parseRoll(const std::string& argsIn) {
    RollArgs r; auto s = foldPunct(argsIn); r.times = takeRepeat(s);
    static const std::string allowed = "0123456789dD%+-*/()kKhHlL";
    std::size_t i = 0; while (i < s.size() && allowed.find(s[i]) != std::string::npos) ++i;
    bool boundary = i == s.size() || isAsciiSpace(s[i]) || isNonAscii(s[i]);
    auto prefix = s.substr(0, i);
    if (i > 0 && boundary && isExpression(prefix)) { r.expr = prefix; r.reason = text::trim(s.substr(i)); }
    else r.reason = text::trim(s);
    if (r.expr == "d" || r.expr == "D") r.expr = "1d100";
    return r;
}
Outcome runRoll(const Command& cmd, const Context& ctx, const TextSet& t, Rng& rng) {
    auto a = parseRoll(cmd.args);
    Outcome o; o.hidden = cmd.hidden;
    Json::Value rolls(Json::arrayValue); std::vector<std::string> lines;
    for (int i = 0; i < a.times; ++i) {
        auto r = evalOrThrow(t, a.expr, rng);
        Json::Value j; j["total"] = r.total; j["detail"] = r.detail; rolls.append(j);
        lines.push_back(t.render("roll.result", {{"name", ctx.name}, {"reason", reasonVar(t, a.reason)}, {"expr", a.expr}, {"result", resultText(r)}}));
    }
    o.text = text::join(lines, "\n");
    o.detail["type"] = "roll"; o.detail["expr"] = a.expr; o.detail["reason"] = a.reason; o.detail["rolls"] = rolls;
    return o;
}

// ---- .ra ----
struct CheckArgs { int times = 1; int difficulty = 2; int bonus = 0, penalty = 0; NameSplit target; };
CheckArgs parseCheck(const std::string& argsIn, const Json::Value& attrs) {
    CheckArgs c; auto s = text::trim(foldPunct(argsIn)); c.times = takeRepeat(s);
    for (int guard = 0; guard < 4; ++guard) {
        if (startsWithCi(s, "hard ") ) { c.difficulty = 3; s = text::trim(s.substr(5)); continue; }
        if (startsWithCi(s, "extreme ")) { c.difficulty = 4; s = text::trim(s.substr(8)); continue; }
        if (s.rfind("困难", 0) == 0) { c.difficulty = 3; s = text::trim(s.substr(std::strlen("困难"))); continue; }
        if (s.rfind("极难", 0) == 0) { c.difficulty = 4; s = text::trim(s.substr(std::strlen("极难"))); continue; }
        if (s.size() >= 1 && (s[0] == 'b' || s[0] == 'B' || s[0] == 'p' || s[0] == 'P')) {
            std::size_t i = 1; int n = 1;
            if (i < s.size() && isDigit(s[i])) { n = s[i] - '0'; ++i; }
            if (i == s.size() || isAsciiSpace(s[i]) || isNonAscii(s[i])) {
                ((s[0] == 'b' || s[0] == 'B') ? c.bonus : c.penalty) += std::max(1, std::min(n, 3));
                s = text::trim(s.substr(i)); continue;
            }
        }
        break;
    }
    c.target = splitName(s, attrs);
    return c;
}
struct ResolvedTarget { std::string attr; int value = 0; bool base = false; };
ResolvedTarget resolveTarget(const Command& cmd, const NameSplit& n, const Context& ctx, const TextSet& t, const std::string& usageText) {
    ResolvedTarget r;
    if (n.name.empty() && !n.value) usage(t, usageText);
    r.attr = n.name.empty() ? "D100" : canonicalName(n.name);
    if (n.value) r.value = *n.value;
    else {
        if (!ctx.hasCharacter) noCharacter(t, cmd);
        auto v = lookup(ctx.attrs, n.name);
        if (!v.found) throw DiceError(t.render("attr.missing", {{"name", ctx.name}, {"attr", r.attr}}));
        r.attr = v.name; r.value = v.value; r.base = v.isBase;
    }
    r.value += n.modifier;
    return r;
}
std::string diffVar(const TextSet& t, int d) { return d == 3 ? t.get("difficulty.hard") : d == 4 ? t.get("difficulty.extreme") : ""; }
int targetFor(int value, int d) { return d == 3 ? value / 2 : d == 4 ? value / 5 : value; }
std::string tensList(const D100& r) { std::vector<std::string> v; for (int x : r.tens) v.push_back(itos(x)); return text::join(v, "/"); }

Outcome runCheck(const Command& cmd, const Context& ctx, const TextSet& t, Rng& rng) {
    auto c = parseCheck(cmd.args, ctx.attrs);
    auto tg = resolveTarget(cmd, c.target, ctx, t, ".ra [hard|extreme] [b|p] <skill> [value] [reason]");
    int target = targetFor(tg.value, c.difficulty);
    Outcome o; o.hidden = cmd.hidden;
    Json::Value rolls(Json::arrayValue); std::vector<std::string> lines;
    for (int i = 0; i < c.times; ++i) {
        auto d = rollD100(rng, c.bonus, c.penalty);
        auto lvl = successLevel(d.roll, tg.value);
        // A fumble is judged against the number needed: at Hard or Extreme a target below 50 fumbles on 96+.
        if (lvl != Level::Critical && (d.roll >= 100 || (target < 50 && d.roll >= 96))) lvl = Level::Fumble;
        auto effective = lvl;
        if (lvl != Level::Critical && lvl != Level::Fumble && (int)lvl < c.difficulty) effective = Level::Failure;
        std::string rollText = itos(d.roll);
        if (!d.tens.empty()) rollText += t.render(c.bonus > c.penalty ? "dice.bonus" : "dice.penalty", {{"tens", tensList(d)}});
        lines.push_back(t.render("check.result", {{"name", ctx.name}, {"attr", tg.attr}, {"difficulty", diffVar(t, c.difficulty)}, {"reason", reasonVar(t, c.target.reason)},
                                                  {"roll", rollText}, {"target", itos(target)}, {"value", itos(tg.value)}, {"level", t.get(levelKey(effective))}}));
        Json::Value j; j["roll"] = d.roll; j["level"] = std::string(levelKey(effective)).substr(6); j["success"] = (int)effective >= (int)Level::Regular; rolls.append(j);
    }
    o.text = text::join(lines, "\n");
    o.detail["type"] = "check"; o.detail["attr"] = tg.attr; o.detail["value"] = tg.value; o.detail["target"] = target;
    o.detail["difficulty"] = c.difficulty == 3 ? "hard" : c.difficulty == 4 ? "extreme" : "regular";
    o.detail["bonus"] = c.bonus; o.detail["penalty"] = c.penalty; o.detail["reason"] = c.target.reason; o.detail["rolls"] = rolls;
    return o;
}

// ---- .sc ----
Outcome runSanity(const Command& cmd, const Context& ctx, const TextSet& t, Rng& rng) {
    static const std::string u = ".sc <success loss>/<failure loss> [SAN]";
    auto s = text::trim(foldPunct(cmd.args));
    // "1 / 1d6" is the same as "1/1d6".
    { std::string joined; for (std::size_t k = 0; k < s.size(); ++k) {
        if (isAsciiSpace(s[k])) { std::size_t j = k; while (j < s.size() && isAsciiSpace(s[j])) ++j; if ((j < s.size() && s[j] == '/') || (!joined.empty() && joined.back() == '/')) { k = j - 1; continue; } }
        joined += s[k]; } s = joined; }
    std::size_t sp = 0; while (sp < s.size() && !isAsciiSpace(s[sp])) ++sp;
    auto spec = s.substr(0, sp), rest = text::trim(s.substr(sp));
    auto slash = spec.find('/');
    if (slash == std::string::npos) usage(t, u);
    auto okExpr = spec.substr(0, slash), failExpr = spec.substr(slash + 1);
    if (!isExpression(okExpr)) throw DiceError(t.render("error.expression", {{"expr", okExpr}}));
    if (!isExpression(failExpr)) throw DiceError(t.render("error.expression", {{"expr", failExpr}}));
    int san = 0; std::string sanKey = "SAN";
    if (!rest.empty() && isDigit(rest[0])) san = std::atoi(rest.c_str());
    else {
        if (!ctx.hasCharacter) noCharacter(t, cmd);
        auto v = lookup(ctx.attrs, "SAN");
        if (!v.found) throw DiceError(t.render("attr.missing", {{"name", ctx.name}, {"attr", "SAN"}}));
        san = v.value; sanKey = v.name;
    }
    auto d = rollD100(rng, 0, 0);
    auto lvl = successLevel(d.roll, san);
    bool success = (int)lvl >= (int)Level::Regular;
    // A fumble loses the maximum of the failure expression.
    auto usedExpr = success ? okExpr : failExpr;
    ExprResult loss;
    if (lvl == Level::Fumble) { ConstRng mx(true); loss = evaluate(failExpr, mx); }
    else loss = evalOrThrow(t, usedExpr, rng);
    int lost = std::max(0, loss.total);
    int now = std::max(0, san - lost);
    std::string lossText = itos(lost);
    if (stripSpaces(usedExpr) != lossText) lossText = usedExpr + "=" + lossText;
    Outcome o; o.hidden = cmd.hidden;
    std::vector<std::string> lines{t.render("sc.result", {{"name", ctx.name}, {"roll", itos(d.roll)}, {"san", itos(san)}, {"level", t.get(levelKey(lvl))}, {"loss", lossText}, {"san_new", itos(now)}})};
    if (lost >= 5 && now > 0) lines.push_back(t.render("sc.temporary", {{"loss", itos(lost)}}));
    if (now == 0) lines.push_back(t.get("sc.zero"));
    o.text = text::join(lines, "\n");
    if (ctx.hasCharacter && (rest.empty() || !isDigit(rest[0]))) { o.attrs = ctx.attrs; o.attrs[sanKey] = now; o.attrsChanged = true; }
    o.detail["type"] = "sanity"; o.detail["roll"] = d.roll; o.detail["san"] = san; o.detail["success"] = success; o.detail["level"] = std::string(levelKey(lvl)).substr(6);
    o.detail["loss"] = lost; o.detail["san_new"] = now;
    return o;
}

// ---- .en ----
Outcome runGrowth(const Command& cmd, const Context& ctx, const TextSet& t, Rng& rng) {
    if (!ctx.hasCharacter) noCharacter(t, cmd);
    auto n = splitName(foldPunct(cmd.args), ctx.attrs);
    if (n.name.empty()) usage(t, ".en <skill> [value]");
    int value; std::string key;
    if (n.value) { value = *n.value; key = storedKey(ctx.attrs, n.name); if (key.empty()) key = canonicalName(n.name); }
    else {
        auto v = lookup(ctx.attrs, n.name);
        if (!v.found) throw DiceError(t.render("attr.missing", {{"name", ctx.name}, {"attr", canonicalName(n.name)}}));
        value = v.value; key = v.isBase ? canonicalName(n.name) : v.name;
    }
    if (canonicalName(key) == "Cthulhu Mythos") throw DiceError(t.get("en.mythos"));
    int roll = rng.roll(100);
    Outcome o;
    o.detail["type"] = "growth"; o.detail["attr"] = key; o.detail["roll"] = roll; o.detail["value"] = value;
    if (roll > value || roll > 95) {
        int gain = rng.roll(10);
        o.attrs = ctx.attrs; o.attrs[key] = value + gain; o.attrsChanged = true;
        o.text = t.render("en.success", {{"name", ctx.name}, {"attr", key}, {"roll", itos(roll)}, {"value", itos(value)}, {"gain", itos(gain)}, {"new", itos(value + gain)}});
        o.detail["success"] = true; o.detail["gain"] = gain;
        // Reaching 90 in a skill steadies the mind: +2D6 SAN.
        if (value < 90 && value + gain >= 90) {
            auto san = lookup(ctx.attrs, "SAN");
            if (san.found) {
                int bonus = rng.roll(6) + rng.roll(6);
                std::string sanKey = san.isBase ? std::string("SAN") : san.name;
                o.attrs[sanKey] = san.value + bonus;
                o.text += "\n" + t.render("en.san_bonus", {{"name", ctx.name}, {"attr", key}, {"gain", itos(bonus)}, {"new", itos(san.value + bonus)}});
                o.detail["san_bonus"] = bonus;
            }
        }
    } else {
        o.text = t.render("en.failure", {{"name", ctx.name}, {"attr", key}, {"roll", itos(roll)}, {"value", itos(value)}});
        o.detail["success"] = false;
    }
    return o;
}

// ---- .st ----
struct StPlan {
    enum Kind { Show, Delete, Clear, Modify, Set } kind = Show;
    std::vector<std::string> names;                    // show / delete
    std::vector<std::pair<std::string, int>> sets;     // set
    std::string attr; char sign = '+'; std::string expr;  // modify
};
std::vector<std::string> splitWords(const std::string& s) {
    std::vector<std::string> out; std::string cur;
    for (char c : s) { if (isAsciiSpace(c) || c == ',' || c == ';' || c == '|') { if (!cur.empty()) out.push_back(cur); cur.clear(); } else cur += c; }
    if (!cur.empty()) out.push_back(cur);
    return out;
}
StPlan parseSt(const std::string& argsIn, const TextSet& t) {
    static const std::string u = ".st <name><value>… | .st <name>±<dice> | .st show | .st del <name> | .st clr";
    StPlan p; auto s = text::trim(foldPunct(argsIn));
    auto firstWord = [&](std::initializer_list<const char*> ws) -> std::optional<std::string> {
        for (auto* w : ws) if (startsWithCi(s, w) && (s.size() == std::strlen(w) || isAsciiSpace(s[std::strlen(w)]))) return text::trim(s.substr(std::strlen(w)));
        return std::nullopt;
    };
    if (s.empty()) { p.kind = StPlan::Show; return p; }
    if (auto r = firstWord({"show", "list"})) { p.kind = StPlan::Show; p.names = splitWords(*r); return p; }
    if (auto r = firstWord({"del", "rm", "delete"})) { p.kind = StPlan::Delete; p.names = splitWords(*r); if (p.names.empty()) usage(t, u); return p; }
    if (firstWord({"clr", "clear"})) { p.kind = StPlan::Clear; return p; }
    // name±expr (a single modification): hp-2, san - 1d6, HP+1
    auto hyphenInName = [&](std::size_t i) { return s[i] == '-' && i + 1 < s.size() && std::isalpha((unsigned char)s[i + 1]); };   // fast-talk
    for (std::size_t i = 1; i < s.size(); ++i) {
        if (s[i] != '+' && s[i] != '-') continue;
        if (hyphenInName(i)) continue;
        auto name = text::trim(s.substr(0, i));
        bool nameOk = !name.empty() && std::none_of(name.begin(), name.end(), [](char c) { return isDigit(c); });
        auto expr = text::trim(s.substr(i + 1));
        if (nameOk && isExpression(expr)) { p.kind = StPlan::Modify; p.attr = name; p.sign = s[i]; p.expr = expr; return p; }
        break;
    }
    // bulk: name value pairs, separators optional — "str60 dex 50", "力量60敏捷50", "Spot Hidden 60, Library Use: 70"
    p.kind = StPlan::Set;
    std::size_t i = 0;
    while (i < s.size()) {
        while (i < s.size() && (isAsciiSpace(s[i]) || s[i] == ',' || s[i] == ';' || s[i] == '|')) ++i;
        if (i >= s.size()) break;
        std::size_t start = i;
        while (i < s.size() && !isDigit(s[i]) && s[i] != ':' && s[i] != '=' && s[i] != ',' && s[i] != ';' && s[i] != '|' && s[i] != '+' && (s[i] != '-' || hyphenInName(i))) ++i;
        auto name = text::trim(s.substr(start, i - start));
        while (i < s.size() && (isAsciiSpace(s[i]) || s[i] == ':' || s[i] == '=')) ++i;
        std::size_t ds = i; while (i < s.size() && isDigit(s[i])) ++i;
        if (name.empty() || ds == i || i - ds > 5) usage(t, u);
        p.sets.emplace_back(name, std::atoi(s.substr(ds, i - ds).c_str()));
    }
    if (p.sets.empty() || p.sets.size() > 200) usage(t, u);
    return p;
}
std::string listAttrs(const std::vector<std::pair<std::string, int>>& kv) {
    std::vector<std::string> parts; for (auto& [k, v] : kv) parts.push_back(k + " " + itos(v)); return text::join(parts, ", ");
}
Outcome runSt(const Command& cmd, const Context& ctx, const TextSet& t, Rng& rng) {
    if (!ctx.hasCharacter) noCharacter(t, cmd);
    auto p = parseSt(cmd.args, t);
    Outcome o; o.detail["type"] = "st"; Json::Value attrs = ctx.attrs.isObject() ? ctx.attrs : Json::Value(Json::objectValue);
    switch (p.kind) {
    case StPlan::Show: {
        std::vector<std::pair<std::string, int>> kv;
        if (p.names.empty()) for (auto& k : attrs.getMemberNames()) kv.emplace_back(k, intOf(attrs[k]));
        else for (auto& n : p.names) { auto v = lookup(attrs, n); if (v.found) kv.emplace_back(v.name, v.value); }
        o.text = kv.empty() ? t.render("st.show_empty", {{"name", ctx.name}}) : t.render("st.show", {{"name", ctx.name}, {"list", listAttrs(kv)}});
        o.detail["op"] = "show";
        return o;
    }
    case StPlan::Delete: {
        std::vector<std::string> removed;
        for (auto& n : p.names) { auto k = storedKey(attrs, n); if (!k.empty()) { attrs.removeMember(k); removed.push_back(k); } }
        o.text = t.render("st.delete", {{"name", ctx.name}, {"list", removed.empty() ? "—" : text::join(removed, ", ")}});
        o.attrs = attrs; o.attrsChanged = !removed.empty(); o.detail["op"] = "delete";
        return o;
    }
    case StPlan::Clear:
        o.text = t.render("st.clear", {{"name", ctx.name}}); o.attrs = Json::Value(Json::objectValue); o.attrsChanged = true; o.detail["op"] = "clear";
        return o;
    case StPlan::Modify: {
        auto cur = lookup(attrs, p.attr);
        auto key = cur.found && !cur.isBase ? cur.name : canonicalName(p.attr);
        int old = cur.found ? cur.value : 0;
        auto r = evalOrThrow(t, p.expr, rng);
        int now = p.sign == '+' ? old + r.total : old - r.total;
        attrs[key] = now;
        std::string delta = std::string(1, p.sign) + p.expr;
        if (stripSpaces(p.expr) != itos(r.total)) delta += "=" + std::string(1, p.sign) + itos(r.total);
        o.text = t.render("st.modify", {{"name", ctx.name}, {"attr", key}, {"old", itos(old)}, {"new", itos(now)}, {"delta", delta}});
        o.attrs = attrs; o.attrsChanged = true; o.detail["op"] = "modify"; o.detail["attr"] = key; o.detail["old"] = old; o.detail["new"] = now;
        return o;
    }
    case StPlan::Set: {
        std::vector<std::pair<std::string, int>> applied;
        for (auto& [n, v] : p.sets) {
            auto k = storedKey(attrs, n); if (k.empty()) k = canonicalName(n);
            attrs[k] = v;
            auto it = std::find_if(applied.begin(), applied.end(), [&](auto& x) { return x.first == k; });
            if (it != applied.end()) it->second = v; else applied.emplace_back(k, v);
        }
        if (attrs.size() > 300) usage(t, "at most 300 attributes per character");
        o.text = t.render("st.set", {{"name", ctx.name}, {"list", listAttrs(applied)}});
        o.attrs = attrs; o.attrsChanged = true; o.detail["op"] = "set"; o.detail["count"] = (int)applied.size();
        return o;
    }
    }
    return o;
}
}

Outcome execute(const Command& cmd, const Context& ctx, const TextSet& texts, Rng& rng) {
    if (cmd.name == "r") return runRoll(cmd, ctx, texts, rng);
    if (cmd.name == "ra") return runCheck(cmd, ctx, texts, rng);
    if (cmd.name == "sc") return runSanity(cmd, ctx, texts, rng);
    if (cmd.name == "en") return runGrowth(cmd, ctx, texts, rng);
    if (cmd.name == "st") return runSt(cmd, ctx, texts, rng);
    throw DiceError("unknown command");
}

std::string preview(const Command& cmd, const Context& ctx, const TextSet& t) {
    try {
        auto attrValue = [&](const std::string& raw) {
            if (!ctx.hasCharacter) noCharacter(t, cmd);
            auto v = lookup(ctx.attrs, raw);
            if (!v.found) return t.render("attr.missing", {{"name", ctx.name}, {"attr", canonicalName(raw)}});
            return t.render(v.isBase ? "attr.value_base" : "attr.value", {{"name", ctx.name}, {"attr", v.name}, {"value", itos(v.value)}});
        };
        if (cmd.name == "r") { auto a = parseRoll(cmd.args); return t.render("hint.roll", {{"name", ctx.name}, {"expr", a.expr}}); }
        if (cmd.name == "ra") {
            auto c = parseCheck(cmd.args, ctx.attrs);
            if (c.target.name.empty() && !c.target.value) return "";
            std::string hint; int value;
            if (c.target.value) {
                value = *c.target.value + c.target.modifier;
                hint = t.render("attr.value", {{"name", ctx.name}, {"attr", c.target.name.empty() ? "D100" : canonicalName(c.target.name)}, {"value", itos(value)}});
            } else {
                if (!ctx.hasCharacter) noCharacter(t, cmd);
                auto v = lookup(ctx.attrs, c.target.name);
                if (!v.found) return t.render("attr.missing", {{"name", ctx.name}, {"attr", canonicalName(c.target.name)}});
                value = v.value + c.target.modifier;
                hint = t.render(v.isBase ? "attr.value_base" : "attr.value", {{"name", ctx.name}, {"attr", v.name}, {"value", itos(value)}});
            }
            if (c.difficulty > 2) hint += t.render("hint.target", {{"difficulty", diffVar(t, c.difficulty)}, {"target", itos(targetFor(value, c.difficulty))}});
            return hint;
        }
        if (cmd.name == "sc") return attrValue("SAN");
        if (cmd.name == "en") { auto n = splitName(cmd.args, ctx.attrs); return n.name.empty() ? "" : attrValue(n.name); }
        if (cmd.name == "st") {
            if (!ctx.hasCharacter) noCharacter(t, cmd);
            auto p = parseSt(cmd.args, t);
            if (p.kind == StPlan::Modify) return attrValue(p.attr);
            if (p.kind == StPlan::Set) {
                std::vector<std::pair<std::string, int>> kv; for (auto& [n, v] : p.sets) kv.emplace_back(canonicalName(n), v);
                return t.render("hint.set", {{"list", listAttrs(kv)}});
            }
            return "";
        }
    } catch (const DiceError& e) {
        // Missing character is worth telling while typing; half-typed arguments are not.
        std::string m = e.what();
        if (m == t.render("error.no_character", {{"command", cmd.raw}})) return m;
    }
    return "";
}

} // namespace acerciae::dice
