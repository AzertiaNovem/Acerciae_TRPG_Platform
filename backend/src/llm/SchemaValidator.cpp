#include "SchemaValidator.h"
#include <sstream>

namespace acerciae {

static bool typeMatches(const std::string& t, const Json::Value& v) {
    if (t == "object") return v.isObject();
    if (t == "array") return v.isArray();
    if (t == "string") return v.isString();
    if (t == "integer") return v.isIntegral();
    if (t == "number") return v.isNumeric();
    if (t == "boolean") return v.isBool();
    if (t == "null") return v.isNull();
    return true;
}

bool SchemaValidator::validate(const Json::Value& s, const Json::Value& v, std::vector<std::string>& errs, const std::string& path) {
    size_t before = errs.size();
    if (!s.isObject()) return true;
    if (s.isMember("type")) {
        bool ok = false;
        if (s["type"].isArray()) { for (auto& t : s["type"]) if (typeMatches(t.asString(), v)) { ok = true; break; } }
        else ok = typeMatches(s["type"].asString(), v);
        if (!ok) { errs.push_back(path + ": expected type " + (s["type"].isArray() ? "one of listed" : s["type"].asString())); return false; }
    }
    if (s.isMember("enum")) {
        bool ok = false; for (auto& e : s["enum"]) if (e == v) { ok = true; break; }
        if (!ok) errs.push_back(path + ": value not in enum");
    }
    if (v.isString()) {
        if (s.isMember("minLength") && (int)v.asString().size() < s["minLength"].asInt()) errs.push_back(path + ": string too short");
        if (s.isMember("maxLength") && (int)v.asString().size() > s["maxLength"].asInt()) errs.push_back(path + ": string too long");
    }
    if (v.isNumeric()) {
        if (s.isMember("minimum") && v.asDouble() < s["minimum"].asDouble()) errs.push_back(path + ": below minimum");
        if (s.isMember("maximum") && v.asDouble() > s["maximum"].asDouble()) errs.push_back(path + ": above maximum");
    }
    if (v.isObject()) {
        if (s.isMember("required")) for (auto& r : s["required"]) if (!v.isMember(r.asString())) errs.push_back(path + ": missing required property '" + r.asString() + "'");
        const auto& props = s["properties"];
        for (auto it = v.begin(); it != v.end(); ++it) {
            auto key = it.name();
            if (props.isObject() && props.isMember(key)) validate(props[key], *it, errs, path + "." + key);
            else if (s.isMember("additionalProperties") && s["additionalProperties"].isBool() && !s["additionalProperties"].asBool())
                errs.push_back(path + ": unexpected property '" + key + "'");
            else if (s.isMember("additionalProperties") && s["additionalProperties"].isObject()) validate(s["additionalProperties"], *it, errs, path + "." + key);
        }
    }
    if (v.isArray()) {
        if (s.isMember("minItems") && (int)v.size() < s["minItems"].asInt()) errs.push_back(path + ": too few items");
        if (s.isMember("maxItems") && (int)v.size() > s["maxItems"].asInt()) errs.push_back(path + ": too many items");
        if (s.isMember("items")) for (Json::ArrayIndex i = 0; i < v.size(); ++i) validate(s["items"], v[i], errs, path + "[" + std::to_string(i) + "]");
    }
    for (const char* comb : {"oneOf", "anyOf"}) {
        if (s.isMember(comb) && s[comb].isArray()) {
            bool any = false;
            for (auto& sub : s[comb]) { std::vector<std::string> tmp; if (validate(sub, v, tmp, path)) { any = true; break; } }
            if (!any) errs.push_back(path + ": matches none of " + comb);
        }
    }
    return errs.size() == before;
}

std::string SchemaValidator::errorsToString(const std::vector<std::string>& errors) {
    std::ostringstream os; for (size_t i = 0; i < errors.size(); ++i) { if (i) os << "; "; os << errors[i]; } return os.str();
}

} // namespace acerciae
