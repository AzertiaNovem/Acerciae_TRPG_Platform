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

Json::Value VnScriptService::queueArt(const ChannelAccess &a, const Json::Value &script, const std::string &pid, bool cloudAuthorized) {
  Json::Value gen;
  gen["backgrounds"] = Json::Value(Json::arrayValue);
  gen["portraits"] = Json::Value(Json::arrayValue);
  gen["enabled"] = creative_.available(a.channelId);
  if (!creative_.available(a.channelId)) return gen;
  int queued = 0;
  for (const auto &need : script["asset_needs"]) {
    if (queued >= 24) break;
    try {
      if (need["kind"] == "background") {
        Json::Value attach; attach["presentation_id"] = pid; attach["scene_key"] = need["scene_key"];
        auto j = creative_.createForScript(a, "background", json::str(need, "brief"), attach, cloudAuthorized);
        Json::Value x; x["name"] = need["name"]; x["scene_key"] = need["scene_key"]; x["job_id"] = j["id"]; gen["backgrounds"].append(x); ++queued;
      } else if (need["kind"] == "standee" && need["character_id"].isString() && !json::str(need, "subtitle").empty()) {
        auto ch = db_.queryOne("SELECT * FROM characters WHERE id=$1 AND channel_id=$2", {need["character_id"].asString(), a.channelId});
        if (ch.isNull() || ch["asset_mode"].asString() != "generated") continue;   // uploaded-mode art is never generated
        Json::Value attach; attach["presentation_id"] = pid; attach["character_id"] = ch["id"]; attach["slot"] = "subtitle"; attach["subtitle"] = need["subtitle"];
        attach["character_name"] = ch["name"];
        auto j = creative_.createForScript(a, "standee", json::str(need, "brief"), attach, cloudAuthorized);
        Json::Value x; x["character_id"] = ch["id"]; x["subtitle"] = need["subtitle"]; x["job_id"] = j["id"]; gen["portraits"].append(x); ++queued;
      }
    } catch (const std::exception &e) {
      ALOG_WARN << "vn script art request skipped: " << e.what();
    }
  }
  return gen;
}

Json::Value VnScriptService::retryBackgrounds(const ChannelAccess &a, const std::string &id, const Json::Value &body) {
  auto job = get(a, id);
  if (job["status"] != "completed" || !job["presentation_id"].isString()) throw badRequest("complete the script before generating backgrounds");
  const auto pid = job["presentation_id"].asString();
  auto presentation = pres_.get(a, pid); // rechecks snapshot visibility as well as draft ownership
  if (presentation["settings"]["media_mode"] == "hybrid") throw badRequest("hybrid backgrounds are generated in the local studio");
  if (!json::toBool(presentation, "can_edit")) throw forbidden("only the draft author or GM can retry backgrounds");
  if (body.isMember("scene_key") && (!body["scene_key"].isString() || body["scene_key"].asString().empty())) throw badRequest("scene_key must be a nonempty string");
  if (body.isMember("allow_cloud") && !body["allow_cloud"].isBool()) throw badRequest("allow_cloud must be a boolean");
  const auto selected = json::str(body, "scene_key");
  bool found = selected.empty();
  for (const auto &scene : presentation["scenes"]) if (scene["canonical_scene_key"] == selected) found = true;
  if (!found) throw notFound("background scene not found");
  const bool cloud = json::toBool(body, "allow_cloud") || json::toBool(job["params"], "cloud_authorized");
  for (const auto &scene : presentation["scenes"]) {
    const auto key = json::str(scene, "canonical_scene_key");
    if ((!selected.empty() && key != selected) || !scene["background_asset_id"].isNull()) continue;
    std::string prompt;
    for (const auto &need : job["script"]["asset_needs"])
      if (need["kind"] == "background" && need["scene_key"] == key) { prompt = json::str(need, "brief"); break; }
    if (prompt.empty()) prompt = json::str(scene["metadata"], "background_brief");
    if (prompt.empty()) prompt = json::str(scene, "title") + ", visual-novel background, no people";
    Json::Value attach; attach["presentation_id"] = pid; attach["scene_key"] = key;
    creative_.createForScript(a, "background", prompt, attach, cloud, true);
  }
  Json::Value audit; audit["job_id"] = id; audit["scene_key"] = selected;
  logs_.audit(a, "vnscript.retry_backgrounds", audit);
  return get(a, id);
}


} // namespace acerciae::logstudio
