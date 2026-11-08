#include "VnScriptInternals.h"
#include "../core/Json.h"
#include "../core/Text.h"
namespace acerciae::logstudio::vnscript {
// Cut to at most n bytes without splitting a UTF-8 sequence; strips control characters except newlines.
std::string clip(const std::string &s, size_t n) {
  std::string out;
  out.reserve(std::min(s.size(), n));
  for (size_t i = 0; i < s.size();) {
    unsigned char c = s[i];
    size_t len = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 1;
    if (out.size() + len > n) break;
    if (len == 1 && c < 0x20 && c != '\n') { ++i; continue; }
    out.append(s, i, len);
    i += len;
  }
  return out;
}
std::string replaceQuotes(const std::string &s) { std::string o; for (char c : s) o += c == '"' ? '\'' : c; return o; }
std::string oneOf(const Json::Value &v, const char *key, const std::set<std::string> &allowed, const std::string &fallback) {
  auto s = json::str(v, key);
  return allowed.count(s) ? s : fallback;
}
const std::set<std::string> kKinds = {"dialogue", "narration", "action", "ooc", "dice", "scene_change", "system", "media"};
const std::set<std::string> kPositions = {"left", "center", "right"};
const std::set<std::string> kEffects = {"none", "shake", "flash", "zoom"};
const std::set<std::string> kEnvironments = {"none", "rain", "fog", "dim", "warm", "cold"};

// "L12" → 11 (zero-based) when in range.
std::optional<size_t> lineRef(const Json::Value &v, size_t count) {
  if (!v.isString()) return std::nullopt;
  auto s = v.asString();
  if (s.size() < 2 || (s[0] != 'L' && s[0] != 'l')) return std::nullopt;
  size_t n = 0;
  for (size_t i = 1; i < s.size(); ++i) {
    if (!isdigit((unsigned char)s[i]) || i > 7) return std::nullopt;
    n = n * 10 + (s[i] - '0');
  }
  if (n == 0 || n > count) return std::nullopt;
  return n - 1;
}
// Stable scene key: ASCII letters/digits lowered, separators collapsed, non-ASCII (e.g. Chinese) kept as is.
std::string slugKey(const std::string &raw, size_t fallbackIndex) {
  std::string k;
  for (unsigned char c : raw) {
    if (c >= 0x80) k += (char)c;
    else if (isalnum(c)) k += (char)tolower(c);
    else if ((c == '-' || c == '_' || c == ' ') && !k.empty() && k.back() != '-') k += '-';
    if (k.size() >= 96) break;
  }
  k = clip(k, 48);
  while (!k.empty() && k.back() == '-') k.pop_back();
  return k.empty() ? "scene-" + std::to_string(fallbackIndex + 1) : k;
}
// An approved background fits a scene when its name or one of its tags appears in the title or location, or the reverse.
bool backgroundFits(const Json::Value &asset, const std::string &title, const std::string &location) {
  auto name = asset["name"].asString();
  for (const auto &hay : {title, location}) {
    if (hay.empty()) continue;
    if ((name.size() >= 3 && text::icontains(hay, name)) || (hay.size() >= 3 && text::icontains(name, hay))) return true;
    for (const auto &t : asset["tags"]) if (t.isString() && t.asString().size() >= 3 && text::icontains(hay, t.asString())) return true;
  }
  return false;
}
}
