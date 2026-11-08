#include "VnScriptService.h"
#include "../core/Errors.h"
#include "../core/Crypto.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../core/Text.h"
#include "../llm/LlmGateway.h"
#include "../llm/Replay.h"
#include "../ws/Notifier.h"
#include "LogStudioService.h"
#include "CreativeService.h"
#include "PresentationService.h"
#include "StudioPolicy.h"
#include "../rules/RuleSystem.h"
#include <algorithm>
#include <regex>
#include <ctime>
#include <set>

#include "VnScriptInternals.h"
namespace acerciae::logstudio {
using namespace vnscript;

std::vector<std::pair<size_t, size_t>> VnScriptService::chunk(const std::vector<LogEvent> &events, size_t maxLines, size_t maxChars) {
  std::vector<std::pair<size_t, size_t>> out;
  size_t begin = 0, chars = 0;
  for (size_t i = 0; i < events.size(); ++i) {
    size_t c = std::min<size_t>(events[i].content.size(), 1500) + 64;
    if (i > begin && (i - begin >= maxLines || chars + c > maxChars)) {
      out.push_back({begin, i});
      begin = i;
      chars = 0;
    }
    chars += c;
  }
  if (begin < events.size()) out.push_back({begin, events.size()});
  return out;
}

size_t VnScriptService::continuationStart(const std::vector<LogEvent> &events, const std::set<std::string> &presented) {
  size_t start = 0;
  for (size_t i = 0; i < events.size(); ++i) if (presented.count(events[i].eventId)) start = i + 1;
  return start;
}

Json::Value VnScriptService::fitContinuation(const Json::Value &script, const Json::Value &oldScenes) {
  Json::Value out = script;
  std::set<std::string> keys;
  std::map<std::string, Json::Value> pictureOf;   // lower(title) → the newest old scene's background
  const Json::Value *last = nullptr;
  for (const auto &o : oldScenes) {
    keys.insert(json::str(o, "canonical_scene_key"));
    if (json::str(o, "canonical_scene_key") == "unplaced") continue;
    last = &o;
    if (o["background_asset_id"].isString()) pictureOf[text::lower(json::str(o, "title"))] = o["background_asset_id"];
  }
  std::map<std::string, std::string> keyOf;       // the script's key → the key it ends up with
  std::map<std::string, bool> pictured;           // final key → has a background
  Json::Value scenes(Json::arrayValue);
  for (Json::ArrayIndex i = 0; i < out["scenes"].size(); ++i) {
    Json::Value s = out["scenes"][i];
    const auto key = json::str(s, "key");
    const auto low = text::lower(json::str(s, "title"));
    const bool own = s["background_asset_id"].isString();
    if (i == 0 && last && text::lower(json::str(*last, "title")) == low &&
        (!own || !(*last)["background_asset_id"].isString() || s["background_asset_id"] == (*last)["background_asset_id"])) {
      const auto into = json::str(*last, "canonical_scene_key");
      s["join_scene_key"] = into;
      keyOf[key] = into;
      pictured[into] = own || (*last)["background_asset_id"].isString();
    } else {
      if (!own && pictureOf.count(low)) s["background_asset_id"] = pictureOf[low];
      std::string k = key;
      for (int n = 2; keys.count(k); ++n) k = text::utf8Prefix(key, 56) + "-" + std::to_string(n);
      keys.insert(k);
      keyOf[key] = k;
      s["key"] = k;
      pictured[k] = s["background_asset_id"].isString();
    }
    scenes.append(s);
  }
  out["scenes"] = scenes;
  Json::Value needs(Json::arrayValue);
  for (auto n : script["asset_needs"]) {
    if (n["kind"] == "background") {
      auto it = keyOf.find(json::str(n, "scene_key"));
      if (it == keyOf.end() || pictured[it->second]) continue;   // the scene reuses a picture
      n["scene_key"] = it->second;
    }
    needs.append(n);
  }
  out["asset_needs"] = needs;
  return out;
}


} // namespace acerciae::logstudio
