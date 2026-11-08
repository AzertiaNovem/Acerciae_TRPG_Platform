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

Json::Value VnScriptService::fromFlat(const ScriptInputs &in, const std::vector<Json::Value> &flats) {
  const size_t n = in.events.size();
  std::map<std::string, Json::Value> castByRef;
  for (const auto &c : in.cast) castByRef[c["ref"].asString()] = c;
  std::map<std::string, std::string> backgroundRef;   // lower(name) → asset ref
  for (const auto &a : in.assets) if (a["type"] == "background") backgroundRef[text::lower(a["name"].asString())] = a["ref"].asString();
  std::map<std::string, std::string> prompts;         // lower(background name) → prompt
  Json::Value plan;
  plan["scenes"] = Json::Value(Json::arrayValue);
  plan["excluded"] = Json::Value(Json::arrayValue);
  plan["asset_needs"] = Json::Value(Json::arrayValue);
  std::map<std::string, Json::ArrayIndex> sceneIndex;
  std::map<std::string, std::vector<std::pair<std::string, std::string>>> onStage;   // scene key → [(cast ref, expr)]
  std::vector<bool> placed(n, false);
  std::set<std::string> portraitKeys;
  for (const auto &flat : flats) {
    if (!flat.isObject()) continue;
    for (const auto &b : flat["generate_backgrounds"]) {
      auto name = clip(json::str(b, "name"), 80), prompt = clip(json::str(b, "prompt"), 400);
      if (name.empty()) continue;
      auto low = text::lower(name);
      if (!prompts.count(low)) prompts[low] = prompt;
    }
    for (const auto &p : flat["generate_portraits"]) {
      auto who = json::str(p, "char"); if (!castByRef.count(who)) who = json::str(p, "who");
      auto subtitle = clip(json::str(p, "subtitle"), 32), prompt = clip(json::str(p, "prompt"), 400);
      if (!castByRef.count(who) || subtitle.empty() || prompt.empty()) continue;
      if (json::str(castByRef[who], "asset_mode") != "generated") continue;   // uploaded-mode art is the actor's alone
      bool have = false; for (const auto &h : castByRef[who]["subtitles"]) have = have || text::lower(h.asString()) == text::lower(subtitle);
      if (have) continue;   // never redraw a pose the character already has (it may have just been updated by hand)
      if (!portraitKeys.insert(who + "|" + text::lower(subtitle)).second) continue;
      Json::Value need; need["kind"] = "standee"; need["who"] = who; need["subtitle"] = subtitle; need["brief"] = prompt;
      plan["asset_needs"].append(need);
    }
    std::string current;   // background name carried forward while the answer omits it
    for (const auto &l : flat["script"]) {
      if (!l.isObject()) continue;
      auto idx = lineRef(l["ref"], n);
      bool byText = false;
      if (!idx && l["text"].isString()) {   // an answer that copied the line instead of its ref
        byText = true;
        auto t = text::trim(l["text"].asString());
        for (size_t i = 0; i < n && !idx; ++i) if (!placed[i] && text::trim(in.events[i].content) == t) idx = i;
      }
      if (!idx || placed[*idx]) continue;
      placed[*idx] = true;
      auto bgName = clip(json::str(l, "background"), 80);
      if (bgName.empty()) bgName = current.empty() ? "Scene" : current;
      current = bgName;
      auto key = slugKey(bgName, plan["scenes"].size());
      if (!sceneIndex.count(key)) {
        Json::Value s; s["key"] = key; s["title"] = bgName; s["summary"] = ""; s["environment"] = "none"; s["lines"] = Json::Value(Json::arrayValue);
        auto low = text::lower(bgName);
        if (backgroundRef.count(low)) s["background"]["ref"] = backgroundRef[low];
        else {
          s["background"]["ref"] = Json::Value();
          s["background"]["brief"] = prompts.count(low) ? prompts[low] : (in.era.empty() ? "" : in.era + ", ") + bgName + ", visual-novel background";
          Json::Value need; need["kind"] = "background"; need["scene_key"] = key; need["name"] = bgName; need["brief"] = s["background"]["brief"];
          plan["asset_needs"].append(need);
        }
        sceneIndex[key] = plan["scenes"].size();
        plan["scenes"].append(s);
      }
      Json::Value line; line["ref"] = "L" + std::to_string(*idx + 1);
      // The composer's wording (never for dice), and short questions and answers folded into it as narration. A
      // folded line must be a story line of the same chat window with the same readers, so the wording reveals
      // nothing a viewer of the first line could not read.
      const auto &head = in.events[*idx];
      auto rewritten = byText || head.eventType == "dice_roll" ? std::string() : clip(text::trim(json::str(l, "text")), 2000);
      bool folded = false;
      if (!rewritten.empty()) for (const auto &f : l["fold"]) {
        auto fi = lineRef(f, n);
        if (!fi || placed[*fi]) continue;
        const auto &o = in.events[*fi];
        if (o.chatWindowId != head.chatWindowId || o.visibilityScope != head.visibilityScope || o.audience != head.audience) continue;
        if (o.eventType != "dialogue" && o.eventType != "narration" && o.eventType != "action") continue;
        placed[*fi] = true; folded = true;
        Json::Value x; x["ref"] = "L" + std::to_string(*fi + 1); x["reason"] = "folded into narration (" + line["ref"].asString() + ")";
        plan["excluded"].append(x);
      }
      if (!rewritten.empty() && rewritten != text::trim(head.content)) line["text"] = rewritten;
      if (folded) line["kind"] = "narration";
      else if (json::str(l, "kind") == "narration" && line.isMember("text")) line["kind"] = "narration";
      auto who = folded ? std::string() : json::str(l, "speaker");
      if (castByRef.count(who)) {
        line["speaker"] = who;
        auto expr = clip(json::str(l, "portrait"), 32);
        const auto &c = castByRef[who];
        if (json::str(c, "asset_mode") != "generated") {   // uploaded mode: only a listed subtitle, else the default art
          auto have = json::strArray(c["subtitles"]); bool listed = false;
          for (const auto &h : have) listed = listed || text::lower(h) == text::lower(expr);
          if (!listed) expr = "";
        }
        if (expr.empty()) expr = "default";
        auto &stage = onStage[key];
        auto it = std::find_if(stage.begin(), stage.end(), [&](auto &p) { return p.first == who; });
        if (it == stage.end()) { if (stage.size() >= 2) stage.erase(stage.begin()); stage.push_back({who, expr}); }
        else it->second = expr;
        line["stage"] = Json::Value(Json::arrayValue);
        for (size_t k = 0; k < stage.size(); ++k) {
          Json::Value p; p["who"] = stage[k].first; p["pos"] = stage.size() == 1 ? "center" : k == 0 ? "left" : "right"; p["expr"] = stage[k].second;
          line["stage"].append(p);
        }
      }
      plan["scenes"][sceneIndex[key]]["lines"].append(line);
    }
    // What the editor left out on purpose, with its reason (a line the script placed stays placed).
    for (const auto &x : flat["exclude"]) {
      if (!x.isObject()) continue;
      auto idx = lineRef(x["ref"], n);
      if (!idx || placed[*idx]) continue;
      placed[*idx] = true;
      auto reason = clip(json::str(x, "reason"), 160);
      Json::Value e; e["ref"] = "L" + std::to_string(*idx + 1); e["reason"] = reason.empty() ? "left out by the script editor" : reason;
      plan["excluded"].append(e);
    }
  }
  // Chatter the answer left out is hidden with a reason; story lines it skipped stay visible in place.
  for (size_t i = 0; i < n; ++i) {
    if (placed[i]) continue;
    const auto &e = in.events[i];
    if (e.eventType != "ooc" && e.eventType != "system" && !e.unrecognised) continue;
    Json::Value x; x["ref"] = "L" + std::to_string(i + 1);
    x["reason"] = e.eventType == "ooc" ? "out-of-character chatter" : e.unrecognised ? "unrecognised line" : "system message";
    plan["excluded"].append(x);
  }
  return plan;
}

Json::Value VnScriptService::normalize(const ScriptInputs &in, const std::vector<Json::Value> &plans, const std::string &provider) {
  const size_t n = in.events.size();
  std::map<std::string, std::string> castByRef;              // ref → character id
  for (const auto &c : in.cast) castByRef[c["ref"].asString()] = c["character_id"].asString();
  std::map<std::string, Json::Value> assetByRef;
  for (const auto &a : in.assets) assetByRef[a["ref"].asString()] = a;

  struct Scene { Json::Value meta; std::vector<size_t> lines; };
  std::vector<Scene> scenes;
  std::map<std::string, size_t> sceneByKey;
  std::vector<int> assigned(n, -1);
  std::vector<Json::Value> lineProps(n);
  std::map<size_t, std::string> excluded;
  Json::Value needs(Json::arrayValue);

  for (const auto &plan : plans) {
    if (!plan.isObject()) continue;
    for (const auto &s : plan["scenes"]) {
      if (!s.isObject()) continue;
      auto key = slugKey(json::str(s, "key", json::str(s, "title")), scenes.size());
      size_t si;
      if (sceneByKey.count(key)) si = sceneByKey[key];
      else {
        si = scenes.size();
        sceneByKey[key] = si;
        scenes.push_back({});
        scenes[si].meta["key"] = key;
      }
      auto &m = scenes[si].meta;
      auto fill = [&](const char *k, size_t len) { if (json::str(m, k).empty()) m[k] = clip(json::str(s, k), len); };
      fill("title", 80); fill("location", 80); fill("time_of_day", 40); fill("mood", 40); fill("summary", 400);
      if (json::str(m, "environment").empty() || m["environment"] == "none") m["environment"] = oneOf(s, "environment", kEnvironments, "none");
      if (!m.isMember("background_asset_id") || m["background_asset_id"].isNull()) {
        auto ref = json::str(s["background"], "ref");
        m["background_asset_id"] = assetByRef.count(ref) && assetByRef[ref]["type"] == "background" ? assetByRef[ref]["id"] : Json::Value();
        if (json::str(m, "background_brief").empty()) m["background_brief"] = clip(json::str(s["background"], "brief"), 300);
      }
      if (!m.isMember("bgm_asset_id") || m["bgm_asset_id"].isNull()) {
        auto ref = json::str(s["bgm"], "ref");
        m["bgm_asset_id"] = assetByRef.count(ref) && (assetByRef[ref]["type"] == "bgm" || assetByRef[ref]["type"] == "audio") ? assetByRef[ref]["id"] : Json::Value();
      }
      for (const auto &l : s["lines"]) {
        auto idx = lineRef(l.isObject() ? l["ref"] : l, n);
        if (!idx || assigned[*idx] >= 0) continue;   // unknown or already placed: first placement wins
        assigned[*idx] = (int)si;
        scenes[si].lines.push_back(*idx);
        Json::Value p(Json::objectValue);
        if (l.isObject()) {
          auto kind = json::str(l, "kind");
          if (kKinds.count(kind)) p["display_kind"] = kind;
          auto speaker = json::str(l, "speaker");
          if (castByRef.count(speaker)) p["speaker_character_id"] = castByRef[speaker];
          if (kEffects.count(json::str(l, "effect")) && l["effect"] != "none") p["effect"] = l["effect"];
          auto delivery = clip(json::str(l, "delivery"), 200);
          if (!delivery.empty()) p["delivery"] = delivery;
          auto wording = clip(json::str(l, "text"), 2000);
          if (!wording.empty()) p["text"] = wording;
          if (l["stage"].isArray()) {
            Json::Value stage(Json::arrayValue);
            std::set<std::string> who, pos;
            for (const auto &st : l["stage"]) {
              auto cid = castByRef.count(json::str(st, "who")) ? castByRef[json::str(st, "who")] : "";
              if (cid.empty() || who.count(cid) || stage.size() >= 3) continue;
              auto ps = oneOf(st, "pos", kPositions, "");
              if (ps.empty() || pos.count(ps)) for (auto cand : {"center", "left", "right"}) if (!pos.count(cand)) { ps = cand; break; }
              who.insert(cid); pos.insert(ps);
              Json::Value c;
              c["character_id"] = cid;
              c["position"] = ps;
              auto expr = clip(json::str(st, "expr", "default"), 32);
              c["expression"] = expr.empty() ? "default" : expr;   // the stage names the subtitle; its current image shows
              stage.append(c);
            }
            p["stage"] = stage;
          }
        }
        lineProps[*idx] = p;
      }
    }
    for (const auto &x : plan["excluded"]) {
      auto idx = lineRef(x.isObject() ? x["ref"] : x, n);
      auto reason = clip(json::str(x, "reason"), 160);
      if (idx && !reason.empty() && !excluded.count(*idx)) excluded[*idx] = reason;
    }
    for (const auto &need : plan["asset_needs"]) {
      if (needs.size() >= 50) break;
      auto kind = oneOf(need, "kind", {"background", "standee"}, "");
      auto brief = clip(json::str(need, "brief"), 300);
      if (kind.empty() || brief.empty()) continue;
      Json::Value x;
      x["kind"] = kind;
      x["brief"] = brief;
      x["scene_key"] = slugKey(json::str(need, "scene_key"), 0);
      auto who = json::str(need, "who");
      x["character_id"] = castByRef.count(who) ? Json::Value(castByRef[who]) : Json::Value();
      auto subtitle = clip(json::str(need, "subtitle"), 32);
      if (!subtitle.empty()) x["subtitle"] = subtitle;
      auto name = clip(json::str(need, "name"), 80);
      if (!name.empty()) x["name"] = name;
      needs.append(x);
    }
  }
  // Lines no plan placed: keep them in canonical position, next to their neighbours.
  for (size_t i = 0; i < n; ++i) {
    if (assigned[i] >= 0) continue;
    // Prefer a placed neighbour from the same chat window and canonical scene, then the same window, then any.
    int si = -1;
    const auto &e = in.events[i];
    // A scene marker opens what follows it; any other line continues what came before.
    bool forward = e.eventType == "scene_change";
    auto near = [&](auto same) {
      auto back = [&] { for (size_t j = i; j-- > 0;) if (assigned[j] >= 0 && same(in.events[j])) return assigned[j]; return -1; };
      auto fwd = [&] { for (size_t j = i + 1; j < n; ++j) if (assigned[j] >= 0 && same(in.events[j])) return assigned[j]; return -1; };
      int r = forward ? fwd() : back();
      return r >= 0 ? r : forward ? back() : fwd();
    };
    si = near([&](const LogEvent &o) { return o.chatWindowId == e.chatWindowId && o.sceneKey == e.sceneKey; });
    if (si < 0) si = near([&](const LogEvent &o) { return o.sceneKey == e.sceneKey; });
    if (si < 0) si = near([&](const LogEvent &o) { return o.chatWindowId == e.chatWindowId; });
    if (si < 0) si = near([](const LogEvent &) { return true; });
    if (si < 0) {
      if (scenes.empty()) { scenes.push_back({}); scenes[0].meta["key"] = "scene-1"; scenes[0].meta["title"] = in.events[i].sceneTitle.empty() ? "Scene 1" : clip(in.events[i].sceneTitle, 80); scenes[0].meta["environment"] = "none"; }
      si = 0;
    }
    assigned[i] = si;
    scenes[si].lines.push_back(i);
  }
  for (auto &s : scenes) std::sort(s.lines.begin(), s.lines.end());
  std::stable_sort(scenes.begin(), scenes.end(), [](const Scene &a, const Scene &b) {
    size_t fa = a.lines.empty() ? SIZE_MAX : a.lines.front(), fb = b.lines.empty() ? SIZE_MAX : b.lines.front();
    return fa < fb;
  });

  Json::Value script;
  script["schemaVersion"] = "1.0";
  script["provider"] = provider;
  script["generated_at"] = text::nowIso();
  script["line_count"] = (Json::UInt64)n;
  script["scenes"] = Json::Value(Json::arrayValue);
  int hidden = 0, kept = 0;
  for (auto &s : scenes) {
    if (s.lines.empty()) continue;
    Json::Value out = s.meta;
    if (json::str(out, "title").empty()) out["title"] = "Scene " + std::to_string(script["scenes"].size() + 1);
    for (auto k : {"location", "time_of_day", "mood", "summary", "background_brief"}) if (!out.isMember(k)) out[k] = "";
    if (!out.isMember("environment")) out["environment"] = "none";
    if (!out.isMember("background_asset_id")) out["background_asset_id"] = Json::Value();
    if (!out.isMember("bgm_asset_id")) out["bgm_asset_id"] = Json::Value();
    out["lines"] = Json::Value(Json::arrayValue);
    Json::Value stage;   // carries forward until a line changes it
    for (auto i : s.lines) {
      Json::Value l = lineProps[i];
      l["event_id"] = in.events[i].eventId;
      if (l.isMember("stage")) stage = l["stage"];
      else if (!stage.isNull()) l["stage"] = stage;
      bool hide = excluded.count(i) > 0;
      l["hidden"] = hide;
      if (hide) { l["exclusion_reason"] = excluded[i]; ++hidden; } else ++kept;
      out["lines"].append(l);
    }
    script["scenes"].append(out);
  }
  script["asset_needs"] = needs;
  script["stats"]["scenes"] = script["scenes"].size();
  script["stats"]["shown"] = kept;
  script["stats"]["hidden"] = hidden;
  script["notes"] = Json::Value(Json::arrayValue);
  if (provider == "mock")
    script["notes"].append("MOCK script: lines grouped by chat window and scenario without a language model; portraits SAY/IDLE. Titles come from the log; there are no summaries.");
  return script;
}

// How the script editor treats the log: boldly, as a story, leaving out what is not the play, and asking rather than
// guessing when a decision belongs to the table. Shared, word for word, with Open Log Studio's composer.

} // namespace acerciae::logstudio
