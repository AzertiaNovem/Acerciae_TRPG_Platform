#pragma once
#include "VnScriptService.h"
#include <optional>
namespace acerciae::logstudio::vnscript {
std::string clip(const std::string &s, size_t n);
std::string replaceQuotes(const std::string &s);
std::string oneOf(const Json::Value &v, const char *key, const std::set<std::string> &allowed, const std::string &fallback);
std::optional<size_t> lineRef(const Json::Value &v, size_t count);
std::string slugKey(const std::string &raw, size_t fallbackIndex);
bool backgroundFits(const Json::Value &asset, const std::string &title, const std::string &location);
extern const std::set<std::string> kKinds;
extern const std::set<std::string> kPositions;
extern const std::set<std::string> kEffects;
extern const std::set<std::string> kEnvironments;
}
