#pragma once
#include <json/json.h>
#include <string>
#include <vector>
#include <optional>

namespace acerciae::json {

Json::Value parse(const std::string& text);              // throws ApiError(400) on invalid JSON
std::string dump(const Json::Value& v, bool pretty = false);
std::string str(const Json::Value& v, const char* key, const std::string& def = "");
int toInt(const Json::Value& v, const char* key, int def = 0);
bool toBool(const Json::Value& v, const char* key, bool def = false);
std::vector<std::string> strArray(const Json::Value& v);
Json::Value fromStrArray(const std::vector<std::string>& xs);
std::string requireStr(const Json::Value& v, const char* key);  // throws 400 if missing/empty

} // namespace acerciae::json
