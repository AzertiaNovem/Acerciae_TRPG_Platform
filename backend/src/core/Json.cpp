#include "Json.h"
#include "Errors.h"
#include <memory>
#include <sstream>

namespace acerciae::json {

Json::Value parse(const std::string& text) {
    Json::CharReaderBuilder b;
    b["collectComments"] = false;
    std::unique_ptr<Json::CharReader> reader(b.newCharReader());
    Json::Value out;
    std::string errs;
    if (!reader->parse(text.data(), text.data() + text.size(), &out, &errs)) {
        throw badRequest("invalid JSON: " + errs);
    }
    return out;
}

std::string dump(const Json::Value& v, bool pretty) {
    Json::StreamWriterBuilder b;
    b["indentation"] = pretty ? "  " : "";
    b["emitUTF8"] = true;
    return Json::writeString(b, v);
}

std::string str(const Json::Value& v, const char* key, const std::string& def) {
    if (!v.isObject() || !v.isMember(key) || v[key].isNull()) return def;
    const auto& x = v[key];
    if (x.isString()) return x.asString();
    if (x.isNumeric()) return dump(x);
    if (x.isBool()) return x.asBool() ? "true" : "false";
    return def;
}
int toInt(const Json::Value& v, const char* key, int def) {
    if (!v.isObject() || !v.isMember(key)) return def;
    const auto& x = v[key];
    if (x.isNumeric()) return x.asInt();
    if (x.isString()) { try { return std::stoi(x.asString()); } catch (...) {} }
    return def;
}
bool toBool(const Json::Value& v, const char* key, bool def) {
    if (!v.isObject() || !v.isMember(key)) return def;
    const auto& x = v[key];
    if (x.isBool()) return x.asBool();
    if (x.isString()) return x.asString() == "true";
    if (x.isNumeric()) return x.asInt() != 0;
    return def;
}
std::vector<std::string> strArray(const Json::Value& v) {
    std::vector<std::string> out;
    if (!v.isArray()) return out;
    for (const auto& x : v) if (x.isString()) out.push_back(x.asString());
    return out;
}
Json::Value fromStrArray(const std::vector<std::string>& xs) {
    Json::Value a(Json::arrayValue);
    for (auto& s : xs) a.append(s);
    return a;
}
std::string requireStr(const Json::Value& v, const char* key) {
    auto s = str(v, key);
    if (s.empty()) throw badRequest(std::string("missing field: ") + key);
    return s;
}

} // namespace acerciae::json
