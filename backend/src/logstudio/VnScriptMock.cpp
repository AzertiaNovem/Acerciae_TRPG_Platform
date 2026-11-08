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

Json::Value VnScriptService::mockPlan(const ScriptInputs &in) {
  std::map<std::string, std::string> castRef;   // character id → ref
  for (const auto &c : in.cast) castRef[c["character_id"].asString()] = c["ref"].asString();
  std::set<std::string> windows;
  for (const auto &e : in.events) if (!e.chatWindowId.empty()) windows.insert(e.chatWindowId);
  bool manyWindows = windows.size() > 1;

  Json::Value plan;
  plan["scenes"] = Json::Value(Json::arrayValue);
  plan["excluded"] = Json::Value(Json::arrayValue);
  plan["asset_needs"] = Json::Value(Json::arrayValue);
  std::map<std::string, Json::ArrayIndex> sceneIndex;
  std::map<std::string, std::vector<std::string>> onStage;
  for (size_t i = 0; i < in.events.size(); ++i) {
    const auto &e = in.events[i];
    std::string ref = "L" + std::to_string(i + 1);
    // Scene markers belong to no chat window; leave them for normalize() to seat with their scene.
    if (manyWindows && e.chatWindowId.empty()) continue;
    if (e.eventType == "ooc" || e.eventType == "system" || e.unrecognised) {
      Json::Value x;
      x["ref"] = ref;
      x["reason"] = e.eventType == "ooc" ? "out-of-character chatter" : e.unrecognised ? "unrecognised import line" : "system message";
      plan["excluded"].append(x);
      continue;
    }
    // Parallel chat windows become separate scenes, so each thread reads continuously.
    std::string key = (manyWindows ? e.chatWindowId.substr(0, 8) + "-" : "") + (e.sceneKey.empty() ? "unscened" : text::utf8Prefix(e.sceneKey, 36));
    if (!sceneIndex.count(key)) {
      Json::Value s;
      s["key"] = key;
      auto wn = in.windowNames.count(e.chatWindowId) ? in.windowNames.at(e.chatWindowId) : "";
      std::string title = !e.sceneTitle.empty() ? e.sceneTitle : e.eventType == "scene_change" ? e.content : "";
      if (manyWindows && !wn.empty()) title = title.empty() ? wn : title + " · " + wn;
      if (title.empty()) title = "Scene " + std::to_string(plan["scenes"].size() + 1);
      s["title"] = clip(title, 80);
      s["location"] = e.metadata["location"].isString() ? e.metadata["location"].asString() : "";
      s["summary"] = "";
      s["environment"] = "none";
      s["lines"] = Json::Value(Json::arrayValue);
      Json::Value bg;
      for (const auto &a : in.assets)
        if (a["type"] == "background" && backgroundFits(a, e.sceneTitle, s["location"].asString())) {
          bg["ref"] = a["ref"];
          break;
        }
      if (bg.isNull()) {
        bg["ref"] = Json::Value();
        bg["brief"] = "Background for " + s["title"].asString();
        Json::Value need;
        need["kind"] = "background";
        need["scene_key"] = key;
        need["brief"] = bg["brief"];
        plan["asset_needs"].append(need);
      }
      s["background"] = bg;
      sceneIndex[key] = plan["scenes"].size();
      plan["scenes"].append(s);
    }
    Json::Value line;
    line["ref"] = ref;
    auto &stage = onStage[key];
    bool speaks = !e.speakerCharacterId.empty() && castRef.count(e.speakerCharacterId) && (e.eventType == "dialogue" || e.eventType == "action");
    if (speaks && std::find(stage.begin(), stage.end(), e.speakerCharacterId) == stage.end()) {
      if (stage.size() >= 3) stage.erase(stage.begin());
      stage.push_back(e.speakerCharacterId);
      static const char *two[] = {"left", "right"}, *three[] = {"left", "center", "right"};
      line["stage"] = Json::Value(Json::arrayValue);
      for (size_t k = 0; k < stage.size(); ++k) {
        Json::Value p;
        p["who"] = castRef[stage[k]];
        p["pos"] = stage.size() == 1 ? "center" : stage.size() == 2 ? two[k] : three[k];
        p["expr"] = "default";
        line["stage"].append(p);
      }
    }
    plan["scenes"][sceneIndex[key]]["lines"].append(line);
  }
  return plan;
}

Json::Value VnScriptService::mockFlat(const ScriptInputs &in, size_t begin, size_t end) {
  std::map<std::string, Json::Value> castRef;   // character id → cast entry
  for (const auto &c : in.cast) castRef[c["character_id"].asString()] = c;
  std::set<std::string> windows;
  for (const auto &e : in.events) if (!e.chatWindowId.empty()) windows.insert(e.chatWindowId);
  bool manyWindows = windows.size() > 1;
  Json::Value flat;
  flat["generate_backgrounds"] = Json::Value(Json::arrayValue);
  flat["generate_portraits"] = Json::Value(Json::arrayValue);
  flat["script"] = Json::Value(Json::arrayValue);
  std::set<std::string> newBackgrounds, newPortraits;
  std::map<std::string, std::string> nameOfKey;
  for (size_t i = begin; i < end && i < in.events.size(); ++i) {
    const auto &e = in.events[i];
    if (e.eventType == "ooc" || e.eventType == "system" || e.unrecognised) continue;
    if (manyWindows && e.chatWindowId.empty()) continue;   // scene markers are seated by normalize()
    std::string key = (manyWindows ? e.chatWindowId.substr(0, 8) + "-" : "") + (e.sceneKey.empty() ? "unscened" : text::utf8Prefix(e.sceneKey, 36));
    if (!nameOfKey.count(key)) {
      auto wn = in.windowNames.count(e.chatWindowId) ? in.windowNames.at(e.chatWindowId) : "";
      std::string title = !e.sceneTitle.empty() ? e.sceneTitle : e.eventType == "scene_change" ? e.content : "";
      if (manyWindows && !wn.empty()) title = title.empty() ? wn : title + " · " + wn;
      if (title.empty()) title = "Scene " + std::to_string(nameOfKey.size() + 1);
      title = clip(title, 80);
      std::string existing;
      for (const auto &a : in.assets)
        if (a["type"] == "background" && backgroundFits(a, e.sceneTitle, e.metadata["location"].isString() ? e.metadata["location"].asString() : "")) { existing = a["name"].asString(); break; }
      if (!existing.empty()) title = existing;
      else if (newBackgrounds.insert(title).second) {
        Json::Value b; b["name"] = title;
        b["prompt"] = (in.era.empty() ? "" : in.era + ", ") + title + (e.metadata["location"].isString() && !e.metadata["location"].asString().empty() ? ", " + e.metadata["location"].asString() : "") + ", visual-novel background, no people";
        flat["generate_backgrounds"].append(b);
      }
      nameOfKey[key] = title;
    }
    Json::Value line;
    line["ref"] = "L" + std::to_string(i + 1);
    line["background"] = nameOfKey[key];
    bool speaks = !e.speakerCharacterId.empty() && castRef.count(e.speakerCharacterId) && (e.eventType == "dialogue" || e.eventType == "action");
    if (speaks) {
      const auto &c = castRef[e.speakerCharacterId];
      line["speaker"] = c["ref"];
      std::string want = e.eventType == "dialogue" ? "SAY" : "IDLE";
      std::vector<std::string> have = json::strArray(c["subtitles"]);
      bool listed = std::find(have.begin(), have.end(), want) != have.end();
      if (json::str(c, "asset_mode") == "generated") {
        if (!listed && newPortraits.insert(c["ref"].asString() + "|" + want).second) {
          Json::Value p; p["char"] = c["ref"]; p["subtitle"] = want;
          p["prompt"] = (in.era.empty() ? "" : in.era + ", ") + (json::str(c, "appearance_prompt").empty() ? json::str(c, "name") : json::str(c, "appearance_prompt")) + ", " + (want == "SAY" ? "speaking, mouth open" : "neutral idle pose") + ", full-body standee, transparent background";
          flat["generate_portraits"].append(p);
        }
        line["portrait"] = want;
      } else {
        line["portrait"] = listed ? want : have.empty() ? "" : have.front();
      }
    }
    flat["script"].append(line);
  }
  return flat;
}


} // namespace acerciae::logstudio
