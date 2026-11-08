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

std::set<std::string> VnScriptService::presentedEvents(const std::string &presentationId) {
  std::set<std::string> ids;
  for (const auto &r : db_.queryJson("SELECT canonical_event_id FROM presentation_events WHERE presentation_id=$1 AND canonical_event_id IS NOT NULL", {presentationId}))
    ids.insert(r["canonical_event_id"].asString());
  return ids;
}

ScriptInputs VnScriptService::inputs(const ChannelAccess &a, const std::string &snapshotId, Json::Value *snap, const std::string &cont) {
  ScriptInputs in;
  in.events = logs_.snapshotEvents(a, snapshotId, snap);
  std::set<std::string> readable;   // every line the requester may read in this snapshot, before the cut
  if (!cont.empty()) {
    for (const auto &e : in.events) readable.insert(e.eventId);
    // A continuation plans only what came after the visual novel's last line.
    in.events.erase(in.events.begin(), in.events.begin() + (std::ptrdiff_t)continuationStart(in.events, presentedEvents(cont)));
    if (in.events.empty()) throw badRequest("there are no new lines after the end of this visual novel");
  }
  auto ch = db_.queryOne("SELECT era, rule_system FROM channels WHERE id=$1", {a.channelId});
  if (!ch.isNull()) { in.era = ch["era"].asString(); in.gmShort = rules::profile(ch["rule_system"].asString()).gmShort; }
  std::set<std::string> windowIds, speakers;
  std::string corpus;
  for (const auto &e : in.events) {
    if (!e.chatWindowId.empty()) windowIds.insert(e.chatWindowId);
    if (!e.speakerCharacterId.empty()) speakers.insert(e.speakerCharacterId);
    if (corpus.size() < 2'000'000) corpus += e.content + "\n";
  }
  for (const auto &w : db_.queryJson("SELECT id, name FROM chat_windows WHERE channel_id=$1", {a.channelId}))
    if (windowIds.count(w["id"].asString())) in.windowNames[w["id"].asString()] = w["name"].asString();
  // Cast: characters who speak in this snapshot, or whose full name already appears in it. Others stay unnamed,
  // so a player-facing script cannot reveal an NPC the players have not met.
  int c = 0, s = 0;
  for (const auto &r : db_.queryJson("SELECT c.id, c.name, c.kind, c.asset_mode, c.appearance_prompt, c.portrait_asset_id, cv.default_asset_id, cv.expressions FROM characters c LEFT JOIN character_visual_profiles cv ON cv.character_id=c.id WHERE c.channel_id=$1 ORDER BY c.created_at", {a.channelId})) {
    auto id = r["id"].asString();
    if (!speakers.count(id) && corpus.find(r["name"].asString()) == std::string::npos) continue;
    Json::Value x;
    x["ref"] = "C" + std::to_string(++c);
    x["character_id"] = id;
    x["name"] = r["name"];
    x["kind"] = r["kind"];
    x["asset_mode"] = r["asset_mode"].isString() ? r["asset_mode"] : Json::Value("uploaded");
    x["appearance_prompt"] = r["appearance_prompt"].isString() ? r["appearance_prompt"] : Json::Value("");
    x["default_asset_id"] = r["default_asset_id"].isString() ? r["default_asset_id"] : r["portrait_asset_id"];
    x["subtitles"] = Json::Value(Json::arrayValue);
    in.cast.append(x);
  }
  std::set<std::string> castIds;
  for (const auto &x : in.cast) castIds.insert(x["character_id"].asString());
  bool gmOnly = snap && (*snap)["scope"].asString() == "gm_full";
  // One image per character and subtitle: the newest approved one, whether the character space set it (its poses)
  // or it was uploaded in the asset library; older images of the same subtitle are never offered.
  {
    auto current = pres_.currentStandees(a.channelId, gmOnly);
    for (auto &x : in.cast) {
      auto cid = x["character_id"].asString();
      auto c = current.find(cid);
      if (c == current.end()) continue;
      for (const auto &[key, r] : c->second) {
        if (key.empty()) continue;   // the default image comes in as default_asset_id
        auto expr = r["expression"].asString();
        x["subtitles"].append(expr);
        Json::Value st; st["ref"] = "S" + std::to_string(++s); st["id"] = r["id"]; st["type"] = "standee"; st["name"] = x["name"].asString() + " · " + expr;
        st["tags"] = Json::Value(Json::arrayValue); st["character_id"] = cid; st["expression"] = expr;
        in.assets.append(st);
      }
    }
  }

  int b = 0, m = 0;
  for (const auto &r : db_.queryJson("SELECT id, asset_type, name, tags, character_id, expression, visibility_scope FROM media_assets WHERE channel_id=$1 AND approval_status='approved' AND asset_type IN ('background','bgm','audio','standee') ORDER BY updated_at DESC LIMIT 400", {a.channelId})) {
    if (!gmOnly && r["visibility_scope"].asString() == "gm") continue;   // a private image cannot enter a shared presentation
    auto type = r["asset_type"].asString();
    if (type == "standee") continue;   // standees were chosen above, one per character and subtitle
    bool dup = false; for (const auto &x : in.assets) dup = dup || x["id"] == r["id"];
    if (dup) continue;
    Json::Value x;
    x["ref"] = type == "background" ? "B" + std::to_string(++b) : type == "standee" ? "S" + std::to_string(++s) : "M" + std::to_string(++m);
    x["id"] = r["id"];
    x["type"] = type;
    x["name"] = r["name"];
    x["tags"] = r["tags"];
    x["character_id"] = r["character_id"];
    x["expression"] = r["expression"];
    in.assets.append(x);
  }
  if (!cont.empty()) {
    // The visual novel's own backgrounds, by the scene names the writer gave them, whatever their library status:
    // the presentation already shows them. Scenes still waiting for a picture are offered by name, like a
    // background generated earlier in this run, so the writer reuses the name instead of asking again.
    auto scenes = db_.queryJson("SELECT id, title, canonical_scene_key, COALESCE(background_asset_id, (metadata->>'hybrid_background_asset_id')::uuid) AS background_asset_id, metadata FROM presentation_scenes WHERE presentation_id=$1 ORDER BY position", {cont});
    auto named = [&](const std::string &name) {
      for (const auto &x : in.assets) if (x["type"] == "background" && text::lower(json::str(x, "name")) == text::lower(name)) return true;
      for (const auto &x : in.knownBackgrounds) if (text::lower(json::str(x, "name")) == text::lower(name)) return true;
      return false;
    };
    const Json::Value *last = nullptr;
    for (const auto &sc : scenes) {
      auto title = clip(json::str(sc, "title"), 80);
      if (json::str(sc, "canonical_scene_key") == "unplaced" || title.empty()) continue;
      last = &sc;
      if (named(title)) continue;
      if (sc["background_asset_id"].isString()) {
        Json::Value x; x["ref"] = "B" + std::to_string(++b); x["id"] = sc["background_asset_id"]; x["type"] = "background"; x["name"] = title;
        x["tags"] = Json::Value(Json::arrayValue); x["character_id"] = Json::Value(); x["expression"] = Json::Value();
        in.assets.append(x);
      } else if (in.knownBackgrounds.size() < 40) {
        Json::Value k; k["name"] = title; k["prompt"] = clip(json::str(sc["metadata"], "background_brief"), 400);
        in.knownBackgrounds.append(k);
      }
    }
    in.story = Json::Value(Json::objectValue);
    in.story["lines"] = Json::Value(Json::arrayValue);
    if (last) {
      in.story["scene"] = json::str(*last, "title");
      in.story["background"] = json::str(*last, "title");
      std::vector<std::string> lines;
      for (const auto &r : db_.queryJson("SELECT pe.canonical_event_id, pe.script_text, pe.segment_text, le.content, le.speaker_display_name, c.name AS character_name, pe.display_kind "
                                         "FROM presentation_events pe LEFT JOIN log_events le ON le.id=pe.canonical_event_id LEFT JOIN characters c ON c.id=pe.speaker_character_id "
                                         "WHERE pe.scene_id=$1 AND NOT pe.hidden ORDER BY pe.position DESC LIMIT 40", {(*last)["id"].asString()})) {
        if (!readable.count(json::str(r, "canonical_event_id"))) continue;   // only what the requester may read now
        auto words = json::str(r, "script_text"); if (words.empty()) words = json::str(r, "segment_text"); if (words.empty()) words = json::str(r, "content");
        words = text::trim(words);
        if (words.empty()) continue;
        auto who = json::str(r, "display_kind") == "narration" ? std::string() : json::str(r, "character_name", json::str(r, "speaker_display_name"));
        lines.push_back((who.empty() ? "" : who + ": ") + words);
        if (lines.size() >= 8) break;
      }
      for (auto it = lines.rbegin(); it != lines.rend(); ++it) in.story["lines"].append(*it);
    }
  }
  return in;
}


} // namespace acerciae::logstudio
