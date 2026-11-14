#include "Hypertext.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../dice/Dice.h"
#include <algorithm>
#include <cctype>
#include <functional>
#include <map>
#include <set>

namespace acerciae::hypertext {
namespace {

constexpr long long kIntBound = 1000000000;
// Lowercase forms of the Object.prototype members: ids are lowercase, and the web host looks them up in plain objects.
const std::set<std::string> kReserved = {"constructor", "prototype", "__proto__", "tostring", "valueof", "hasownproperty", "isprototypeof",
    "propertyisenumerable", "tolocalestring", "__definegetter__", "__definesetter__", "__lookupgetter__", "__lookupsetter__"};
const char* kIdRule = "must match ^[a-z][a-z0-9_]{0,31}$ and not be a JavaScript prototype name";

bool isInt(const Json::Value& v) { return v.isInt64(); }   // a JSON number with an integral value: 1 and 1.0 alike
bool boundedInt(const Json::Value& v) { return v.isInt64() && v.asInt64() >= -kIntBound && v.asInt64() <= kIntBound; }
bool has(const Json::Value& o, const char* k) { return o.isObject() && o.isMember(k) && !o[k].isNull(); }
const Json::Value& at(const Json::Value& o, const char* k) { static const Json::Value none; return o.isObject() && o.isMember(k) ? o[k] : none; }
bool keyChar(char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'; }
std::string cpPrefix(const std::string& s, size_t n) {
    size_t count = 0;
    for (size_t i = 0; i < s.size(); ++i) if (((unsigned char)s[i] & 0xC0) != 0x80) { if (count == n) return s.substr(0, i); ++count; }
    return s;
}
bool isUuid(const std::string& s) {
    if (s.size() != 36) return false;
    for (size_t i = 0; i < s.size(); ++i) {
        bool dash = i == 8 || i == 13 || i == 18 || i == 23;
        if (dash ? s[i] != '-' : !std::isxdigit((unsigned char)s[i])) return false;
    }
    return true;
}
// A key as it appears in an error path: printable ASCII only, so a hostile key cannot garble the response.
std::string pathKey(const std::string& k) {
    std::string o;
    for (unsigned char c : k) { if (o.size() >= 40) { o += "..."; break; } o += c >= 0x20 && c < 0x7F ? (char)c : '?'; }
    return o;
}
std::string dot(const std::string& p, const std::string& k) { return p + "." + pathKey(k); }
std::string idx(const std::string& p, size_t i) { return p + "[" + std::to_string(i) + "]"; }
// The {{name}} placeholders of s in order; false at a "{{" that does not open one, so a literal "{{" is never valid.
bool placeholders(const std::string& s, std::vector<std::string>& names) {
    for (size_t start = 0, i; (i = s.find("{{", start)) != std::string::npos;) {
        size_t j = i + 2; while (j < s.size() && keyChar(s[j])) ++j;
        if (j == i + 2 || s.compare(j, 2, "}}") != 0) return false;
        names.push_back(s.substr(i + 2, j - i - 2)); start = j + 2;
    }
    return true;
}

// ---- state declarations (normalized or as posted) ----
std::vector<std::pair<std::string, std::string>> valuesOf(const Json::Value& d) {   // {value, label} in schema order
    std::vector<std::pair<std::string, std::string>> out;
    const auto& vs = at(d, "values");
    if (vs.isArray()) for (const auto& v : vs) {
        if (v.isString()) out.push_back({v.asString(), v.asString()});
        else if (v.isObject() && at(v, "value").isString()) out.push_back({v["value"].asString(), at(v, "label").isString() ? v["label"].asString() : v["value"].asString()});
    }
    return out;
}
bool inValues(const Json::Value& d, const std::string& s) { for (auto& [v, l] : valuesOf(d)) if (v == s) return true; return false; }
std::string typeOf(const Json::Value& d) { return at(d, "type").isString() ? d["type"].asString() : ""; }
long long intAt(const Json::Value& d, const char* k, long long def) { return isInt(at(d, k)) ? d[k].asInt64() : def; }
size_t setMax(const Json::Value& d) { return (size_t)std::max<long long>(0, intAt(d, "max", (long long)valuesOf(d).size())); }
size_t textMax(const Json::Value& d) { return (size_t)std::max<long long>(0, intAt(d, "max", 500)); }

Json::Value defaultOf(const Json::Value& d) {
    auto t = typeOf(d);
    if (t == "bool") return false;
    if (t == "int") {
        long long lo = intAt(d, "min", 0), hi = intAt(d, "max", lo), def = intAt(d, "default", lo);
        return Json::Int64(def >= lo && def <= hi ? def : lo);
    }
    if (t == "enum") return at(d, "default").isString() && inValues(d, d["default"].asString()) ? d["default"] : Json::Value();
    if (t == "set") return Json::Value(Json::arrayValue);
    if (t == "text") return "";
    return Json::Value();
}
// Why v is not a value of the declaration d; "" when it is one.
std::string misfit(const Json::Value& d, const Json::Value& v) {
    auto t = typeOf(d);
    if (t == "bool") return v.isBool() ? "" : "must be true or false";
    if (t == "int") {
        if (!isInt(v)) return "must be an integer";
        long long lo = intAt(d, "min", -kIntBound), hi = intAt(d, "max", kIntBound);
        return v.asInt64() >= lo && v.asInt64() <= hi ? "" : "must be between " + std::to_string(lo) + " and " + std::to_string(hi);
    }
    if (t == "enum") return v.isNull() || (v.isString() && inValues(d, v.asString())) ? "" : "must be one of the declared values or null";
    if (t == "set") {
        if (!v.isArray()) return "must be a list of the declared values";
        if (v.size() > setMax(d)) return "must hold at most " + std::to_string(setMax(d)) + " values";
        std::set<std::string> seen;
        for (const auto& x : v) {
            if (!x.isString() || !inValues(d, x.asString())) return "must be a list of the declared values";
            if (!seen.insert(x.asString()).second) return "must not repeat a value";
        }
        return "";
    }
    if (t == "text") {
        if (!v.isString()) return "must be a string";
        if (!allowedText(v.asString(), false)) return "contains a line break, control, bidi override or noncharacter, or is not valid UTF-8";
        return text::utf8Length(v.asString()) <= textMax(d) ? "" : "must be at most " + std::to_string(textMax(d)) + " code points";
    }
    return "has no declared type";
}
// v (already accepted by misfit) as it is stored: integers as integers, a set in schema order.
Json::Value canonical(const Json::Value& d, const Json::Value& v) {
    auto t = typeOf(d);
    if (t == "int") return Json::Int64(v.asInt64());
    if (t == "set") {
        Json::Value out(Json::arrayValue);
        for (auto& [val, label] : valuesOf(d)) for (const auto& x : v) if (x.isString() && x.asString() == val) { out.append(val); break; }
        return out;
    }
    return v;
}
const Json::Value* declOf(const Json::Value& doc, const std::string& key) {
    const auto& s = at(doc, "state");
    return s.isObject() && s.isMember(key) && s[key].isObject() ? &s[key] : nullptr;
}
Json::Value valueOf(const Json::Value& d, const Json::Value& state, const std::string& key) {
    if (state.isObject() && state.isMember(key) && misfit(d, state[key]).empty()) return state[key];
    return defaultOf(d);
}
std::string show(const Json::Value& d, const Json::Value& v) {
    auto t = typeOf(d);
    if (t == "int") return isInt(v) ? std::to_string(v.asInt64()) : "";
    if (t == "text") return v.isString() ? v.asString() : "";
    std::vector<std::string> labels;
    for (auto& [val, label] : valuesOf(d)) {
        bool on = t == "enum" ? v.isString() && v.asString() == val : false;
        if (t == "set" && v.isArray()) for (const auto& x : v) if (x.isString() && x.asString() == val) on = true;
        if (on) labels.push_back(label);
    }
    return text::join(labels, ", ");
}
bool sameValue(const Json::Value& a, const Json::Value& b) {
    if (isInt(a) && isInt(b)) return a.asInt64() == b.asInt64();
    if (a.isString() && b.isString()) return a.asString() == b.asString();
    if (a.isBool() && b.isBool()) return a.asBool() == b.asBool();
    return a.isNull() && b.isNull();
}
// ri/rih join the initiative order as the speaking character only when nothing in the arguments names someone else:
// signed modifiers (+2, -1, +1d4) and the words adv/advantage/dis/disadvantage, nothing more.
bool modifiersOnly(const std::string& args) {
    size_t i = 0, n = args.size();
    auto boundary = [&](size_t k) { return k >= n || std::isspace((unsigned char)args[k]) || args[k] == '+' || args[k] == '-'; };
    while (true) {
        while (i < n && std::isspace((unsigned char)args[i])) ++i;
        if (i >= n) return true;
        if (args[i] == '+' || args[i] == '-') {
            ++i; while (i < n && std::isspace((unsigned char)args[i])) ++i;
            size_t a = i; while (i < n && std::isdigit((unsigned char)args[i])) ++i;
            bool count = i > a;
            if (i < n && (args[i] == 'd' || args[i] == 'D')) {
                size_t b = ++i; while (i < n && std::isdigit((unsigned char)args[i])) ++i;
                if (i == b) return false;
            } else if (!count) return false;
            if (!boundary(i)) return false;
        } else {
            size_t a = i; while (i < n && std::isalpha((unsigned char)args[i])) ++i;
            auto w = text::lower(args.substr(a, i - a));
            if ((w != "adv" && w != "advantage" && w != "dis" && w != "disadvantage") || !boundary(i)) return false;
        }
    }
}

// ---- normalize ----
struct Checker {
    std::vector<Issue> errors;
    std::map<std::string, Json::Value> decls;               // normalized state declarations
    Json::Value replies = Json::Value(Json::objectValue);   // normalized private replies
    std::set<std::string> postedReplies, nodeIds;
    bool script = false, tooMany = false;
    int nodes = 0;

    void fail(const std::string& p, const std::string& m) { errors.push_back({p, m}); }
    void only(const Json::Value& o, const std::string& p, std::initializer_list<const char*> keys) {
        for (const auto& k : o.getMemberNames())
            if (std::none_of(keys.begin(), keys.end(), [&](const char* a) { return k == a; })) fail(dot(p, k), "unknown key");
    }
    // A string of 1..max code points (not only spaces) with allowed characters.
    bool str(const Json::Value& v, const std::string& p, size_t max, bool multiline, std::string& out) {
        if (!v.isString()) { fail(p, "must be a string"); return false; }
        out = v.asString();
        if (!text::utf8Valid(out)) fail(p, "is not valid UTF-8 (or holds a surrogate)");
        else if (!allowedText(out, multiline)) fail(p, multiline ? "contains a control, bidi override or noncharacter" : "contains a line break, control, bidi override or noncharacter");
        else if (text::trim(out).empty()) fail(p, "must not be empty");
        else if (text::utf8Length(out) > max) fail(p, "must be at most " + std::to_string(max) + " code points");
        else return true;
        return false;
    }
    bool ident(const Json::Value& v, const std::string& p, std::string& out) {
        if (!v.isString() || !validId(v.asString())) { fail(p, kIdRule); return false; }
        out = v.asString(); return true;
    }
    std::string choose(const Json::Value& n, const char* key, const std::string& p, std::initializer_list<const char*> allowed) {
        if (!has(n, key)) return *allowed.begin();
        for (const char* a : allowed) if (n[key].isString() && n[key].asString() == a) return a;
        std::vector<std::string> names(allowed.begin(), allowed.end());
        fail(dot(p, key), "must be one of " + text::join(names, ", "));
        return *allowed.begin();
    }
    bool boundedField(const Json::Value& n, const char* key, const std::string& p, long long lo, long long hi, long long& out) {
        if (!isInt(at(n, key)) || n[key].asInt64() < lo || n[key].asInt64() > hi) {
            fail(dot(p, key), "must be an integer from " + std::to_string(lo) + " to " + std::to_string(hi)); return false;
        }
        out = n[key].asInt64(); return true;
    }
    // {{key}} in labels, text and act.say: only int, enum, set and text keys.
    void interp(const std::string& s, const std::string& p) {
        std::vector<std::string> names;
        if (!placeholders(s, names)) { fail(p, "\"{{\" must open a {{key}} placeholder of a declared state key"); return; }
        for (auto& k : names) {
            auto it = decls.find(k);
            if (it == decls.end() || typeOf(it->second) == "bool") { fail(p, "{{" + k + "}} is not a declared int, enum, set or text key"); return; }
        }
    }

    Json::Value values(const Json::Value& vs, const std::string& p) {
        Json::Value out(Json::arrayValue);
        if (!vs.isArray() || vs.size() < 2 || vs.size() > 20) { fail(p, "must be a list of 2 to 20 {value, label}"); return out; }
        std::set<std::string> seen;
        for (Json::ArrayIndex i = 0; i < vs.size(); ++i) {
            auto ip = idx(p, i); const auto& v = vs[i];
            if (!v.isObject()) { fail(ip, "must be an object {value, label}"); continue; }
            only(v, ip, {"value", "label"});
            std::string value, label;
            if (!has(v, "value")) { fail(dot(ip, "value"), "required"); continue; }
            if (!str(v["value"], dot(ip, "value"), 64, false, value)) continue;
            if (!seen.insert(value).second) { fail(dot(ip, "value"), "duplicate value"); continue; }
            if (has(v, "label") && !str(v["label"], dot(ip, "label"), 120, false, label)) continue;
            Json::Value o; o["value"] = value; o["label"] = has(v, "label") ? label : value;
            out.append(o);
        }
        return out;
    }
    void stateDecl(const std::string& key, const Json::Value& d, const std::string& p) {
        if (!validId(key)) { fail(p, kIdRule); return; }
        if (!d.isObject()) { fail(p, "must be an object with a type"); return; }
        auto t = typeOf(d);
        size_t before = errors.size();
        Json::Value o; o["type"] = t;
        if (t == "bool") only(d, p, {"type"});
        else if (t == "int") {
            only(d, p, {"type", "min", "max", "default"});
            long long lo = 0, hi = 0, def = 0;
            bool ok = boundedField(d, "min", p, -kIntBound, kIntBound, lo) & boundedField(d, "max", p, -kIntBound, kIntBound, hi);
            if (ok && lo > hi) fail(dot(p, "max"), "must not be below min");
            else if (ok) {
                def = lo;
                if (has(d, "default")) boundedField(d, "default", p, lo, hi, def);
                o["min"] = Json::Int64(lo); o["max"] = Json::Int64(hi); o["default"] = Json::Int64(def);
            }
        } else if (t == "enum") {
            only(d, p, {"type", "values", "default"});
            o["values"] = values(at(d, "values"), dot(p, "values"));
            o["default"] = Json::Value();
            if (has(d, "default")) {
                if (!d["default"].isString() || !inValues(o, d["default"].asString())) fail(dot(p, "default"), "must be one of the values or null");
                else o["default"] = d["default"];
            }
        } else if (t == "set") {
            only(d, p, {"type", "values", "max"});
            o["values"] = values(at(d, "values"), dot(p, "values"));
            long long max = o["values"].size();
            if (has(d, "max")) boundedField(d, "max", p, 1, 20, max);
            o["max"] = Json::Int64(max);
        } else if (t == "text") {
            only(d, p, {"type", "max"});
            long long max = 500;
            if (has(d, "max")) boundedField(d, "max", p, 1, 500, max);
            o["max"] = Json::Int64(max);
        } else { fail(dot(p, "type"), "must be one of bool, int, enum, set, text"); return; }
        if (errors.size() == before) decls[key] = o;
    }

    Json::Value cond(const Json::Value& c, const std::string& p, int depth, int& leaves) {
        if (!c.isObject()) { fail(p, "must be a condition object"); return {}; }
        if (depth > 3) { fail(p, "conditions nest at most 3 deep"); return {}; }
        for (const char* op : {"all", "any"}) if (c.isMember(op)) {
            only(c, p, {op});
            const auto& xs = c[op]; auto xp = dot(p, op);
            if (!xs.isArray() || xs.empty() || xs.size() > 8) { fail(xp, "must be a list of 1 to 8 conditions"); return {}; }
            Json::Value out; out[op] = Json::Value(Json::arrayValue);
            for (Json::ArrayIndex i = 0; i < xs.size(); ++i) out[op].append(cond(xs[i], idx(xp, i), depth + 1, leaves));
            return out;
        }
        if (c.isMember("not")) { only(c, p, {"not"}); Json::Value out; out["not"] = cond(c["not"], dot(p, "not"), depth + 1, leaves); return out; }
        only(c, p, {"key", "eq", "in", "has", "gte", "lte", "empty"});
        if (++leaves == 9) fail(p, "at most 8 conditions per show_if or enable_if");
        if (!at(c, "key").isString()) { fail(dot(p, "key"), "required: a declared state key"); return {}; }
        auto key = c["key"].asString();
        auto it = decls.find(key);
        if (it == decls.end()) { fail(dot(p, "key"), "not a declared state key"); return {}; }
        const auto& d = it->second; auto t = typeOf(d);
        std::vector<std::string> ops;
        for (const char* op : {"eq", "in", "has", "gte", "lte", "empty"}) if (c.isMember(op)) ops.push_back(op);
        if (ops.size() != 1) { fail(p, "needs exactly one of eq, in, has, gte, lte, empty"); return {}; }
        const auto& op = ops[0]; const auto& v = c[op]; auto vp = dot(p, op);
        Json::Value out; out["key"] = key;
        if (op == "eq") {
            if (t == "set") fail(vp, "a set key takes has or empty");
            else if (auto m = misfit(d, v); !m.empty()) fail(vp, m);
            else out["eq"] = canonical(d, v);
        } else if (op == "in") {
            if (t != "enum" && t != "int") fail(vp, "in takes an enum or int key");
            else if (!v.isArray() || v.empty() || v.size() > 20) fail(vp, "must be a list of 1 to 20 values");
            else {
                out["in"] = Json::Value(Json::arrayValue);
                for (Json::ArrayIndex i = 0; i < v.size(); ++i)
                    if (v[i].isNull() || !misfit(d, v[i]).empty()) fail(idx(vp, i), "must be a value of " + key);
                    else out["in"].append(canonical(d, v[i]));
            }
        } else if (op == "has") {
            if (t != "set") fail(vp, "has takes a set key");
            else if (!v.isString() || !inValues(d, v.asString())) fail(vp, "must be one of the set's values");
            else out["has"] = v;
        } else if (op == "gte" || op == "lte") {
            if (t != "int") fail(vp, op + " takes an int key");
            else if (!boundedInt(v)) fail(vp, "must be an integer within -1000000000..1000000000");
            else out[op] = Json::Int64(v.asInt64());
        } else {
            if (t != "text" && t != "set" && t != "enum") fail(vp, "empty takes a text, set or enum key");
            else if (!v.isBool()) fail(vp, "must be true or false");
            else out["empty"] = v.asBool();
        }
        return out;
    }

    void label(const Json::Value& n, const std::string& p, const char* key, size_t max, bool required, bool interpolated, Json::Value& o) {
        std::string s;
        if (!has(n, key)) { if (required) fail(dot(p, key), "required"); return; }
        if (!str(n[key], dot(p, key), max, false, s)) return;
        if (interpolated) interp(s, dot(p, key));
        o[key] = s;
    }
    const Json::Value* bind(const Json::Value& n, const std::string& p, std::initializer_list<const char*> types, Json::Value& o) {
        if (!at(n, "bind").isString()) { fail(dot(p, "bind"), "required: a declared state key"); return nullptr; }
        auto k = n["bind"].asString();
        auto it = decls.find(k);
        if (it == decls.end()) { fail(dot(p, "bind"), "not a declared state key"); return nullptr; }
        auto t = typeOf(it->second);
        if (std::none_of(types.begin(), types.end(), [&](const char* a) { return t == a; })) {
            std::vector<std::string> names(types.begin(), types.end());
            fail(dot(p, "bind"), "must be a " + text::join(names, " or ") + " key"); return nullptr;
        }
        o["bind"] = k; return &it->second;
    }
    Json::Value act(const Json::Value& a, const std::string& p) {
        Json::Value o(Json::objectValue);
        if (!a.isObject()) { fail(p, "must be an object {set, say, say_kind, reply}"); return o; }
        only(a, p, {"set", "say", "say_kind", "reply"});
        // The state the say is checked against: every key at its default, then the act's own set.
        Json::Value doc, after(Json::objectValue);
        for (auto& [k, d] : decls) { doc["state"][k] = d; after[k] = defaultOf(d); }
        if (has(a, "set")) {
            const auto& s = a["set"]; auto sp = dot(p, "set");
            if (!s.isObject() || s.empty()) fail(sp, "must be an object of declared state keys and values");
            else for (const auto& k : s.getMemberNames()) {
                auto it = decls.find(k);
                if (it == decls.end()) { fail(dot(sp, k), "not a declared state key"); continue; }
                if (auto m = misfit(it->second, s[k]); !m.empty()) { fail(dot(sp, k), m); continue; }
                o["set"][k] = after[k] = canonical(it->second, s[k]);
            }
        }
        if (has(a, "say")) {
            auto sp = dot(p, "say");
            if (!a["say"].isString()) fail(sp, "must be a string");
            else if (auto e = sayError(a["say"].asString()); !e.empty()) fail(sp, e);
            else {
                auto say = a["say"].asString();
                size_t before = errors.size();
                interp(say, sp);
                if (errors.size() == before && diceVerdict(interpolate(say, doc, after)) == Verdict::refused)
                    fail(sp, "this command cannot be posted from a card: r, ra and ri without a name run directly, sc and ds ask first");
                o["say"] = say; o["say_kind"] = choose(a, "say_kind", p, {"ic", "ooc"});
            }
        } else if (has(a, "say_kind")) fail(dot(p, "say_kind"), "needs say");
        if (has(a, "reply")) {
            auto rp = dot(p, "reply");
            if (!a["reply"].isString() || !postedReplies.count(a["reply"].asString())) fail(rp, "no reply with this id");
            else {
                auto id = a["reply"].asString();
                o["reply"] = id;
                // A declarative reply fills each slot from the state key of the same name, whose values must all fit the slot.
                const auto& slots = at(at(replies, id.c_str()), "slots");
                if (slots.isObject()) for (const auto& name : slots.getMemberNames()) {
                    const auto& slot = slots[name];
                    auto it = decls.find(name);
                    if (it == decls.end()) { fail(rp, "slot " + name + " needs a state key of the same name"); continue; }
                    auto t = typeOf(it->second), st = typeOf(slot);
                    if (t != st) { fail(rp, "slot " + name + " is an " + st + " slot, so state key " + name + " must be an " + st + " key"); continue; }
                    bool fits = true;
                    if (t == "enum") { for (auto& [v, l] : valuesOf(it->second)) if (!inValues(slot, v)) fits = false; }
                    else fits = it->second["min"].asInt64() >= slot["min"].asInt64() && it->second["max"].asInt64() <= slot["max"].asInt64();
                    if (!fits) fail(rp, t == "enum" ? "every value of state key " + name + " must be a value of slot " + name
                                                    : "the range of state key " + name + " must lie within the range of slot " + name);
                }
            }
        }
        if (o.empty() && a.isObject() && !has(a, "set") && !has(a, "say") && !has(a, "reply")) fail(p, "needs set, say or reply");
        return o;
    }

    void node(const Json::Value& n, const std::string& p, int level, Json::Value& out) {   // level: 0 body, 1 group, 2 row
        if (++nodes > kMaxNodes && !tooMany) { tooMany = true; fail("hypertext.body", "at most 64 nodes"); }
        if (!n.isObject()) { fail(p, "must be a node object"); return; }
        static const std::map<std::string, std::vector<std::string>> fields = {
            {"text", {"type", "id", "text", "style", "tone", "show_if"}},
            {"checkbox", {"type", "id", "label", "bind", "on", "show_if", "enable_if"}},
            {"choice", {"type", "id", "label", "bind", "display", "options", "on", "show_if", "enable_if"}},
            {"input", {"type", "id", "label", "placeholder", "bind", "submit_label", "on", "show_if", "enable_if"}},
            {"button", {"type", "id", "label", "style", "on", "act", "show_if", "enable_if"}},
            {"row", {"type", "id", "children", "show_if"}},
            {"group", {"type", "id", "title", "children", "show_if"}},
            {"divider", {"type", "id", "show_if"}}};
        auto type = at(n, "type").isString() ? n["type"].asString() : "";
        auto f = fields.find(type);
        if (f == fields.end()) { fail(dot(p, "type"), "must be one of text, checkbox, choice, input, button, row, group, divider"); return; }
        for (const auto& k : n.getMemberNames()) if (std::find(f->second.begin(), f->second.end(), k) == f->second.end()) fail(dot(p, k), "unknown key");
        if (type == "group" && level > 0) { fail(dot(p, "type"), "groups sit only in body"); return; }
        if (type == "row" && level > 1) { fail(dot(p, "type"), "rows hold only leaves"); return; }
        bool control = type == "checkbox" || type == "choice" || type == "input" || type == "button";
        Json::Value o; o["type"] = type;
        std::string s;
        if (has(n, "id")) { if (ident(n["id"], dot(p, "id"), s)) { if (!nodeIds.insert(s).second) fail(dot(p, "id"), "duplicate id"); o["id"] = s; } }
        else if (control) fail(dot(p, "id"), "required for a " + type);
        if (has(n, "show_if")) { int leaves = 0; o["show_if"] = cond(n["show_if"], dot(p, "show_if"), 1, leaves); }
        if (control && has(n, "enable_if")) { int leaves = 0; o["enable_if"] = cond(n["enable_if"], dot(p, "enable_if"), 1, leaves); }
        if (control && has(n, "on") && ident(n["on"], dot(p, "on"), s)) { if (!script) fail(dot(p, "on"), "an on handler needs a script"); o["on"] = s; }
        if (type == "text") {
            if (!has(n, "text")) fail(dot(p, "text"), "required");
            else if (str(n["text"], dot(p, "text"), 2000, true, s)) { interp(s, dot(p, "text")); o["text"] = s; }
            o["style"] = choose(n, "style", p, {"body", "muted", "heading", "strong"});
            o["tone"] = choose(n, "tone", p, {"neutral", "good", "bad", "warn"});
        } else if (type == "checkbox") {
            label(n, p, "label", 120, true, true, o);
            bind(n, p, {"bool"}, o);
        } else if (type == "choice") {
            label(n, p, "label", 120, false, true, o);
            const Json::Value* d = bind(n, p, {"enum", "set"}, o);
            o["display"] = choose(n, "display", p, {"list", "buttons", "menu"});
            if (d && o["display"] == "menu" && typeOf(*d) == "set") fail(dot(p, "display"), "a menu shows an enum key; use list or buttons for a set");
            if (has(n, "options") && d) {
                const auto& xs = n["options"]; auto xp = dot(p, "options");
                if (!xs.isArray() || xs.empty() || xs.size() > 20) fail(xp, "must be a list of the bound key's values");
                else {
                    std::set<std::string> seen; o["options"] = Json::Value(Json::arrayValue);
                    for (Json::ArrayIndex i = 0; i < xs.size(); ++i)
                        if (!xs[i].isString() || !inValues(*d, xs[i].asString())) fail(idx(xp, i), "must be a value of " + o["bind"].asString());
                        else if (!seen.insert(xs[i].asString()).second) fail(idx(xp, i), "duplicate option");
                        else o["options"].append(xs[i]);
                }
            }
        } else if (type == "input") {
            label(n, p, "label", 120, false, true, o);
            label(n, p, "placeholder", 120, false, false, o);
            bind(n, p, {"text"}, o);
            label(n, p, "submit_label", 40, false, false, o);
        } else if (type == "button") {
            label(n, p, "label", 60, true, true, o);
            o["style"] = choose(n, "style", p, {"primary", "secondary", "danger"});
            if (has(n, "on") == has(n, "act")) fail(p, "a button needs exactly one of on or act");
            else if (has(n, "act")) o["act"] = act(n["act"], dot(p, "act"));
        } else if (type == "row" || type == "group") {
            if (type == "group") label(n, p, "title", 80, false, true, o);
            const auto& xs = at(n, "children"); auto xp = dot(p, "children");
            o["children"] = Json::Value(Json::arrayValue);
            if (!xs.isArray() || xs.empty()) fail(xp, "must be a list of at least one node");
            else for (Json::ArrayIndex i = 0; i < xs.size(); ++i) node(xs[i], idx(xp, i), type == "row" ? 2 : 1, o["children"]);
        }
        out.append(o);
    }

    void reply(const std::string& id, const Json::Value& r, const std::string& p) {
        if (!validId(id)) { fail(p, kIdRule); return; }
        postedReplies.insert(id);
        if (!r.isObject()) { fail(p, "must be an object with text"); return; }
        only(r, p, {"text", "kind", "character_id", "audience", "slots", "per_viewer", "total", "group"});
        size_t before = errors.size();
        Json::Value o; o["slots"] = Json::Value(Json::objectValue);
        std::map<std::string, size_t> widest;   // the longest value each slot can render
        if (has(r, "slots")) {
            const auto& slots = r["slots"]; auto sp = dot(p, "slots");
            if (!slots.isObject()) fail(sp, "must be an object of slots");
            else {
                if (slots.size() > (Json::ArrayIndex)kMaxSlots) fail(sp, "at most 4 slots");
                for (const auto& name : slots.getMemberNames()) {
                    auto np = dot(sp, name); const auto& d = slots[name];
                    if (!validId(name)) { fail(np, kIdRule); continue; }
                    if (!d.isObject()) { fail(np, "must be a slot object with a type"); continue; }
                    auto t = typeOf(d); Json::Value slot; slot["type"] = t;
                    if (t == "enum") {
                        only(d, np, {"type", "values"});
                        const auto& vs = at(d, "values"); auto vp = dot(np, "values");
                        if (!vs.isArray() || vs.empty() || vs.size() > 20) { fail(vp, "must be a list of 1 to 20 strings"); continue; }
                        std::set<std::string> seen; slot["values"] = Json::Value(Json::arrayValue);
                        for (Json::ArrayIndex i = 0; i < vs.size(); ++i) {
                            std::string v;
                            if (!str(vs[i], idx(vp, i), 64, false, v)) continue;
                            if (!seen.insert(v).second) { fail(idx(vp, i), "duplicate value"); continue; }
                            slot["values"].append(v); widest[name] = std::max(widest[name], text::utf8Length(v));
                        }
                    } else if (t == "int") {
                        only(d, np, {"type", "min", "max"});
                        long long lo = 0, hi = 0;
                        if (!(boundedField(d, "min", np, -kIntBound, kIntBound, lo) & boundedField(d, "max", np, -kIntBound, kIntBound, hi))) continue;
                        if (lo > hi) { fail(dot(np, "max"), "must not be below min"); continue; }
                        slot["min"] = Json::Int64(lo); slot["max"] = Json::Int64(hi);
                        widest[name] = std::max(std::to_string(lo).size(), std::to_string(hi).size());
                    } else { fail(dot(np, "type"), "must be enum or int"); continue; }
                    o["slots"][name] = slot;
                }
            }
        }
        std::string text;
        auto tp = dot(p, "text");
        if (!has(r, "text")) fail(tp, "required");
        else if (str(r["text"], tp, kMaxTemplate, true, text)) {
            std::vector<std::string> names;
            if (!placeholders(text, names)) fail(tp, "\"{{\" must open a {{slot}} placeholder of a declared slot");
            else {
                size_t longest = text::utf8Length(text);
                for (auto& n : names) {
                    if (!o["slots"].isMember(n)) { fail(tp, "{{" + n + "}} is not a declared slot"); break; }
                    longest = longest - (n.size() + 4) + widest[n];
                }
                if (longest > kMaxContent) fail(tp, "can render longer than 2000 code points");
            }
            // Dice come only from the template itself, decided now: a slot value can never turn narration into a command.
            auto cmd = dice::parseCommand(text);
            if (cmd && cmd->name != "r") fail(tp, "a reply may roll only with .r or .rh; other commands are refused");
            o["text"] = text; o["allow_dice"] = cmd && cmd->name == "r";
        }
        o["kind"] = choose(r, "kind", p, {"narration", "ic", "ooc"});
        o["character_id"] = Json::Value();
        if (has(r, "character_id")) {
            if (!r["character_id"].isString() || !isUuid(r["character_id"].asString())) fail(dot(p, "character_id"), "must be a character id or null");
            else o["character_id"] = text::lower(r["character_id"].asString());
        }
        o["audience"] = choose(r, "audience", p, {"card", "viewer", "gm"});
        long long n = 1;
        if (has(r, "per_viewer")) boundedField(r, "per_viewer", p, 1, 20, n);
        o["per_viewer"] = Json::Int64(n);
        o["total"] = Json::Value();
        if (has(r, "total") && boundedField(r, "total", p, 1, 1000, n)) o["total"] = Json::Int64(n);
        o["group"] = Json::Value();
        if (has(r, "group")) { std::string g; if (ident(r["group"], dot(p, "group"), g)) o["group"] = g; }
        if (errors.size() == before) replies[id] = o;
    }
};

} // namespace

size_t storedSize(const Json::Value& v) {
    size_t spaces = 0;
    std::function<void(const Json::Value&)> walk = [&](const Json::Value& x) {
        if (x.isObject()) { if (!x.empty()) spaces += 2 * x.size() - 1; for (const auto& k : x.getMemberNames()) walk(x[k]); }
        else if (x.isArray()) { if (!x.empty()) spaces += x.size() - 1; for (const auto& y : x) walk(y); }
    };
    walk(v);
    return json::dump(v).size() + spaces;
}

bool validId(const std::string& s) {
    if (s.empty() || s.size() > 32 || s[0] < 'a' || s[0] > 'z') return false;
    return std::all_of(s.begin(), s.end(), keyChar) && !kReserved.count(s);
}
bool allowedText(const std::string& s, bool multiline) {
    return text::forEachCodePoint(s, [&](char32_t c) {
        if (c < 0x20) return multiline && c == '\n';
        if ((c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069)) return false;   // bidi embeddings, overrides, isolates
        return !((c >= 0xFDD0 && c <= 0xFDEF) || (c & 0xFFFE) == 0xFFFE);                 // noncharacters
    });
}
std::string sayError(const std::string& textIn) {
    auto t = text::trim(textIn);
    if (t.empty()) return "say needs text";
    if (!allowedText(t, true)) return "say contains a control, bidi override or noncharacter, or is not valid UTF-8";
    if (text::utf8Length(t) > kMaxSay) return "say must be at most 500 code points";
    if ((size_t)std::count(t.begin(), t.end(), '\n') + 1 > kMaxSayLines) return "say must be at most 5 lines";
    return "";
}
std::string contentError(const std::string& t) {
    if (text::trim(t).empty()) return "content must not be empty";
    if (!allowedText(t, true)) return "content contains a control, bidi override or noncharacter, or is not valid UTF-8";
    if (text::utf8Length(t) > kMaxContent) return "content must be at most 2000 code points";
    if (isCommand(t)) return "content must not be a dot command";
    return "";
}
bool isCommand(const std::string& t) { return dice::parseCommand(t).has_value(); }
Verdict diceVerdict(const std::string& t) {
    auto cmd = dice::parseCommand(t);
    if (!cmd) return Verdict::none;
    const auto& n = cmd->name;
    if (n == "r" || n == "ra") return Verdict::allowed;
    if (n == "ri") return modifiersOnly(cmd->args) ? Verdict::allowed : Verdict::refused;
    if (n == "sc" || n == "ds") return Verdict::confirm;
    return Verdict::refused;   // st, en, ss, init, move, and any command added later
}
const char* verdictName(Verdict v) {
    switch (v) { case Verdict::allowed: return "allowed"; case Verdict::confirm: return "confirm"; case Verdict::refused: return "refused"; default: return "none"; }
}

Json::Value Normalized::details() const {
    Json::Value out(Json::arrayValue);
    for (auto& e : errors) { Json::Value x; x["path"] = e.path; x["message"] = e.message; out.append(x); }
    return out;
}

Normalized normalize(const Json::Value& ht, const Json::Value& repliesIn) {
    Normalized out; Checker c;
    out.doc = Json::Value(Json::objectValue); out.replies = Json::Value(Json::objectValue);
    if (!ht.isObject()) { out.errors.push_back({"hypertext", "must be an object"}); return out; }
    c.only(ht, "hypertext", {"v", "title", "state", "body", "script", "actors", "runs_per_viewer"});
    auto& doc = out.doc;
    if (!isInt(at(ht, "v")) || ht["v"].asInt64() != 1) c.fail("hypertext.v", "must be 1: the only version this server accepts");
    doc["v"] = 1;
    std::string s;
    doc["title"] = "";   // "" is no title, as in a normalized card
    if (has(ht, "title") && ht["title"] != "" && c.str(ht["title"], "hypertext.title", 120, false, s)) doc["title"] = s;
    doc["state"] = Json::Value(Json::objectValue);
    if (has(ht, "state")) {
        const auto& st = ht["state"];
        if (!st.isObject()) c.fail("hypertext.state", "must be an object of state declarations");
        else {
            if (st.size() > (Json::ArrayIndex)kMaxStateKeys) c.fail("hypertext.state", "at most 32 keys");
            for (const auto& k : st.getMemberNames()) c.stateDecl(k, st[k], dot("hypertext.state", k));
            for (auto& [k, d] : c.decls) doc["state"][k] = d;
        }
    }
    c.script = has(ht, "script") && ht["script"].isString() && !ht["script"].asString().empty();
    // Replies before the body (act.reply refers to them); their errors are listed after the card's.
    Checker r; r.decls = c.decls;
    if (!repliesIn.isNull()) {
        if (!repliesIn.isObject()) r.fail("replies", "must be an object of reply templates");
        else {
            if (repliesIn.size() > (Json::ArrayIndex)kMaxReplies) r.fail("replies", "at most 16 replies");
            for (const auto& id : repliesIn.getMemberNames()) r.reply(id, repliesIn[id], dot("replies", id));
        }
    }
    c.replies = r.replies; c.postedReplies = r.postedReplies;
    doc["body"] = Json::Value(Json::arrayValue);
    const auto& body = at(ht, "body");
    if (!body.isArray() || body.empty()) c.fail("hypertext.body", "required: a list of at least one node");
    else for (Json::ArrayIndex i = 0; i < body.size(); ++i) c.node(body[i], idx("hypertext.body", i), 0, doc["body"]);
    if (has(ht, "script")) {
        const auto& sc = ht["script"];
        bool ok = sc.isString() && text::forEachCodePoint(sc.asString(), [](char32_t ch) {
            if (ch < 0x20) return ch == '\n' || ch == '\t' || ch == '\r';
            return !((ch >= 0x202A && ch <= 0x202E) || (ch >= 0x2066 && ch <= 0x2069) || (ch >= 0xFDD0 && ch <= 0xFDEF) || (ch & 0xFFFE) == 0xFFFE);
        });
        if (!ok) c.fail("hypertext.script", "must be valid UTF-8 without control characters (other than tab and line breaks), bidi overrides or noncharacters");
        else if (sc.asString().size() > kMaxScriptBytes) c.fail("hypertext.script", "must be at most 16 KiB of UTF-8");
        else if (c.script) doc["script"] = sc.asString();
    }
    if (has(ht, "actors")) {
        const auto& a = ht["actors"];
        if (!a.isArray() || a.empty()) c.fail("hypertext.actors", "must be a list of 1 to 10 character ids; leave it out to let every reader act");
        else if (a.size() > (Json::ArrayIndex)kMaxActors) c.fail("hypertext.actors", "at most 10 actors");
        else {
            std::set<std::string> seen; doc["actors"] = Json::Value(Json::arrayValue);
            for (Json::ArrayIndex i = 0; i < a.size(); ++i) {
                if (!a[i].isString() || !isUuid(a[i].asString())) { c.fail(idx("hypertext.actors", i), "must be a character id"); continue; }
                auto id = text::lower(a[i].asString());
                if (!seen.insert(id).second) c.fail(idx("hypertext.actors", i), "duplicate actor");
                else doc["actors"].append(id);
            }
        }
    }
    long long runs = 1;
    if (has(ht, "runs_per_viewer")) c.boundedField(ht, "runs_per_viewer", "hypertext", 1, 100, runs);
    doc["runs_per_viewer"] = Json::Int64(runs);
    c.errors.insert(c.errors.end(), r.errors.begin(), r.errors.end());
    if (c.errors.empty() && json::dump(doc).size() > kMaxDocBytes) c.fail("hypertext", "the normalized card must be at most 32 KiB of JSON");
    // What is stored: the public document with its reply stubs (every enum slot's values) and the private templates, each
    // inside the 64 KiB the database allows in its own text form (with room for closes_at).
    else if (c.errors.empty() && storedSize(publicDoc(doc, r.replies, std::string(40, '0'))) > kMaxStoredBytes)
        c.fail(r.replies.empty() ? "hypertext" : "replies", "the stored card, with its reply stubs and their slot values, must be at most 60 KiB of JSON");
    else if (c.errors.empty() && storedSize(r.replies) > kMaxStoredBytes) c.fail("replies", "the reply templates must be at most 60 KiB of JSON");
    if (c.errors.size() > 10) c.errors.resize(10);
    out.errors = c.errors; out.ok = out.errors.empty();
    if (out.ok) out.replies = c.replies;
    return out;
}

Json::Value publicDoc(const Json::Value& doc, const Json::Value& replies, const std::string& closesAt) {
    Json::Value out = doc;
    out["closes_at"] = closesAt;
    out["replies"] = Json::Value(Json::arrayValue);
    if (replies.isObject()) for (const auto& id : replies.getMemberNames()) {
        const auto& r = replies[id];
        Json::Value stub; stub["id"] = id; stub["slots"] = at(r, "slots").isObject() ? r["slots"] : Json::Value(Json::objectValue);
        stub["audience"] = at(r, "audience").isString() ? r["audience"] : Json::Value("card"); stub["group"] = at(r, "group");
        out["replies"].append(stub);
    }
    return out;
}

std::string fallbackText(const Json::Value& doc) {
    std::vector<std::string> lines;
    if (at(doc, "title").isString() && !doc["title"].asString().empty()) lines.push_back(doc["title"].asString());
    auto state = defaultState(doc);
    auto str = [](const Json::Value& n, const char* k) { return at(n, k).isString() ? n[k].asString() : std::string(); };
    std::function<void(const Json::Value&)> walk = [&](const Json::Value& nodes) {
        if (!nodes.isArray()) return;
        for (const auto& n : nodes) {
            if (!n.isObject() || (has(n, "show_if") && !evalCondition(n["show_if"], doc, state))) continue;
            auto type = str(n, "type");
            auto label = interpolate(str(n, "label"), doc, state);
            std::string line;
            if (type == "text") line = interpolate(str(n, "text"), doc, state);
            else if (type == "checkbox") line = "☐ " + label;
            else if (type == "choice") {
                std::vector<std::string> shown;
                const Json::Value* d = declOf(doc, str(n, "bind"));
                if (d) {
                    auto vs = valuesOf(*d);
                    if (at(n, "options").isArray()) { for (const auto& o : n["options"]) for (auto& [v, l] : vs) if (o.isString() && o.asString() == v) shown.push_back(l); }
                    else for (auto& [v, l] : vs) shown.push_back(l);
                }
                line = (label.empty() ? "" : label + ": ") + text::join(shown, " / ");
            } else if (type == "input") line = label.empty() ? "____" : label + ": ____";
            else if (type == "button") line = "[" + label + "]";
            else if (type == "divider") line = "—";
            else if (type == "group") line = interpolate(str(n, "title"), doc, state);
            if (!line.empty()) lines.push_back(line);
            if (type == "row" || type == "group") walk(at(n, "children"));
        }
    };
    walk(at(doc, "body"));
    auto out = text::join(lines, "\n");
    return out.empty() ? "—" : cpPrefix(out, kMaxContent);
}

Json::Value defaultState(const Json::Value& doc) {
    Json::Value s(Json::objectValue);
    const auto& decls = at(doc, "state");
    if (decls.isObject()) for (const auto& k : decls.getMemberNames()) s[k] = defaultOf(decls[k]);
    return s;
}

StateCheck validateState(const Json::Value& doc, const Json::Value& state) {
    StateCheck r;
    if (!state.isObject()) { r.message = "state must be an object"; return r; }
    auto full = defaultState(doc);
    for (const auto& k : state.getMemberNames()) {
        const Json::Value* d = declOf(doc, k);
        if (!d) { r.key = k; r.message = "not a declared state key"; return r; }
        if (auto m = misfit(*d, state[k]); !m.empty()) { r.key = k; r.message = m; return r; }
        full[k] = canonical(*d, state[k]);
    }
    if (json::dump(full).size() > kMaxStateBytes) { r.message = "state must be at most 8 KiB of JSON"; return r; }
    r.ok = true; r.state = full;
    return r;
}

bool evalCondition(const Json::Value& c, const Json::Value& doc, const Json::Value& state) {
    if (!c.isObject()) return false;
    if (c.isMember("all")) { if (!c["all"].isArray()) return false; for (const auto& x : c["all"]) if (!evalCondition(x, doc, state)) return false; return true; }
    if (c.isMember("any")) { if (!c["any"].isArray()) return false; for (const auto& x : c["any"]) if (evalCondition(x, doc, state)) return true; return false; }
    if (c.isMember("not")) return !evalCondition(c["not"], doc, state);
    if (!at(c, "key").isString()) return false;
    const Json::Value* d = declOf(doc, c["key"].asString());
    if (!d) return false;
    auto v = valueOf(*d, state, c["key"].asString());
    if (c.isMember("eq")) return sameValue(v, c["eq"]);
    if (c.isMember("in")) { if (c["in"].isArray()) for (const auto& x : c["in"]) if (sameValue(v, x)) return true; return false; }
    if (c.isMember("has")) { if (v.isArray()) for (const auto& x : v) if (sameValue(x, c["has"])) return true; return false; }
    if (c.isMember("gte")) return isInt(v) && isInt(c["gte"]) && v.asInt64() >= c["gte"].asInt64();
    if (c.isMember("lte")) return isInt(v) && isInt(c["lte"]) && v.asInt64() <= c["lte"].asInt64();
    if (c.isMember("empty")) {
        bool empty = v.isNull() || (v.isString() && v.asString().empty()) || (v.isArray() && v.empty());
        return c["empty"].isBool() && empty == c["empty"].asBool();
    }
    return false;
}

std::string interpolate(const std::string& t, const Json::Value& doc, const Json::Value& state) {
    std::string out;
    size_t start = 0;
    for (size_t i; (i = t.find("{{", start)) != std::string::npos;) {
        out += t.substr(start, i - start);
        size_t j = i + 2; while (j < t.size() && keyChar(t[j])) ++j;
        auto key = t.substr(i + 2, j - i - 2);
        const Json::Value* d = j > i + 2 && t.compare(j, 2, "}}") == 0 ? declOf(doc, key) : nullptr;
        if (!d || typeOf(*d) == "bool") { out += "{{"; start = i + 2; continue; }   // never valid in a posted card: kept as written
        out += show(*d, valueOf(*d, state, key)); start = j + 2;
    }
    return out + t.substr(start);
}

Rendered renderReply(const Json::Value& reply, const Json::Value& slots) {
    Rendered r; r.error = "invalid_slot";
    const auto& decl = at(reply, "slots");
    if (!slots.isNull() && !slots.isObject()) { r.message = "slots must be an object"; return r; }
    std::map<std::string, std::string> values;
    if (slots.isObject()) for (const auto& name : slots.getMemberNames())
        if (!decl.isObject() || !decl.isMember(name)) { r.message = "unknown slot " + name; return r; }
    if (decl.isObject()) for (const auto& name : decl.getMemberNames()) {
        const auto& d = decl[name]; const auto& v = at(slots, name.c_str());
        if (!slots.isObject() || !slots.isMember(name)) { r.message = "missing slot " + name; return r; }
        if (typeOf(d) == "enum" && v.isString() && std::any_of(at(d, "values").begin(), at(d, "values").end(), [&](const Json::Value& x) { return x.isString() && x.asString() == v.asString(); }))
            values[name] = v.asString();
        else if (typeOf(d) == "int" && isInt(v) && v.asInt64() >= intAt(d, "min", 0) && v.asInt64() <= intAt(d, "max", 0))
            values[name] = std::to_string(v.asInt64());
        else { r.message = "slot " + name + " must be one of its declared values"; return r; }
    }
    auto t = at(reply, "text").isString() ? reply["text"].asString() : "";
    std::vector<std::string> names;
    if (t.empty() || !placeholders(t, names)) { r.message = "the reply template is not valid"; return r; }
    std::string out;
    size_t start = 0;
    for (size_t i; (i = t.find("{{", start)) != std::string::npos;) {
        size_t j = t.find("}}", i);
        auto it = values.find(t.substr(i + 2, j - i - 2));
        if (it == values.end()) { r.message = "the reply template uses an undeclared slot"; return r; }
        out += t.substr(start, i - start) + it->second; start = j + 2;
    }
    out += t.substr(start);
    if (!allowedText(out, true)) { r.message = "the rendered reply holds a character that is not allowed"; return r; }
    // Defence in depth: a dice template stays a plain roll whatever the slots hold.
    if (at(reply, "allow_dice").isBool() && reply["allow_dice"].asBool()) {
        auto cmd = dice::parseCommand(out);
        if (!cmd || cmd->name != "r") { r.message = "the rendered reply is no longer an .r roll"; return r; }
    }
    r.ok = true; r.text = out; r.error.clear();
    return r;
}

} // namespace acerciae::hypertext
