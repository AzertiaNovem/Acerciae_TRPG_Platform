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

std::vector<std::pair<size_t, size_t>> VnScriptService::blocks(const std::vector<LogEvent> &events, long long gapSeconds) {
  std::vector<std::pair<size_t, size_t>> out;
  if (events.empty()) return out;
  size_t begin = 0;
  std::optional<long long> last;
  for (size_t i = 0; i < events.size(); ++i) {
    const auto &t = events[i].occurredAtUnix;
    if (t && last && *t - *last > gapSeconds && i > begin) { out.push_back({begin, i}); begin = i; }
    if (t) last = t;
  }
  out.push_back({begin, events.size()});
  return out;
}

std::string VnScriptService::speakerLabel(const LogEvent &e, const std::string &gm) {
  std::string name = e.speakerDisplayName.empty() ? (e.speakerRole == "gm" ? gm : "?") : e.speakerDisplayName;
  if (e.eventType == "system") return "System";
  if (e.speakerRole == "gm") {
    if (e.eventType == "ooc") return gm + "(OOC)";
    if (e.eventType == "dice_roll" || e.eventType == "dice") return gm + "(Dice)";
    if (e.eventType == "narration" || e.eventType == "scene_change" || e.speakerCharacterId.empty()) return gm + "(Narrative)";
    return gm + "(as " + name + ")";
  }
  if (e.speakerRole == "npc") return gm + "(as " + name + ")";
  if (e.eventType == "ooc") return name + "(OOC)";
  if (e.eventType == "dice_roll" || e.eventType == "dice") return name + "(Dice)";
  return name;
}

namespace {
std::string clock(const LogEvent &e) {
  if (!e.occurredAtUnix) return e.timeText;
  time_t t = (time_t)*e.occurredAtUnix; tm tmv{}; gmtime_r(&t, &tmv);
  char buf[16]; strftime(buf, sizeof buf, "%H:%M", &tmv); return buf;
}
std::string day(const LogEvent &e) {
  if (!e.occurredAtUnix) return "";
  time_t t = (time_t)*e.occurredAtUnix; tm tmv{}; gmtime_r(&t, &tmv);
  char buf[24]; strftime(buf, sizeof buf, "%Y-%m-%d %H:%M", &tmv); return buf;
}
std::string quoted(const std::string &s) { return "\"" + replaceQuotes(s) + "\""; }
} // namespace

std::string VnScriptService::transcript(const ScriptInputs &in, size_t begin, size_t end, const Json::Value &knownBackgrounds) {
  return assetsSection(in, knownBackgrounds) + blockSection(in, begin, end);
}

std::string VnScriptService::assetsSection(const ScriptInputs &in, const Json::Value &knownBackgrounds) {
  std::string out = "# Assets\n";
  if (!in.era.empty()) out += "Era: " + in.era + "\n";
  out += "Portraits:\n";
  for (const auto &c : in.cast) {
    out += "- " + c["ref"].asString() + " " + quoted(c["name"].asString()) + " mode=" + json::str(c, "asset_mode", "uploaded") + " subtitles=[";
    bool first = true; for (const auto &s : c["subtitles"]) { out += (first ? "" : ", ") + s.asString(); first = false; }
    out += "]";
    if (json::str(c, "asset_mode") == "generated") out += " prompt=" + quoted(clip(json::str(c, "appearance_prompt"), 300));
    else out += " (uploaded: only these subtitles may be used)";
    out += "\n";
  }
  out += "Backgrounds:\n";
  for (const auto &b : in.assets) if (b["type"] == "background") out += "- " + quoted(b["name"].asString()) + " (existing)\n";
  for (const auto &b : knownBackgrounds) out += "- " + quoted(json::str(b, "name")) + " prompt=" + quoted(clip(json::str(b, "prompt"), 200)) + "\n";
  return out;
}

std::string VnScriptService::blockSection(const ScriptInputs &in, size_t begin, size_t end) {
  std::string out;
  // Lines grouped by chat window, windows in order of first appearance; scene markers (no window) come first.
  std::vector<std::string> order; std::map<std::string, std::string> text;
  for (size_t i = begin; i < end && i < in.events.size(); ++i) {
    const auto &e = in.events[i];
    auto &w = text[e.chatWindowId];
    if (w.empty()) {
      order.push_back(e.chatWindowId);
      w = e.chatWindowId.empty() ? "## Scene markers\n" : "## Window: " + (in.windowNames.count(e.chatWindowId) ? in.windowNames.at(e.chatWindowId) : "untitled") + "\n";
    }
    auto t = clock(e);
    w += "[L" + std::to_string(i + 1) + "] " + speakerLabel(e, in.gmShort) + (t.empty() ? "" : "(" + t + ")") + ": " + clip(e.content, 1500);
    if (e.dice && e.dice->total) w += " [roll " + std::to_string(*e.dice->total) + (e.dice->outcome.empty() ? "" : " " + e.dice->outcome) + "]";
    w += "\n";
  }
  std::string span = begin < in.events.size() ? day(in.events[begin]) : "";
  if (end > begin && end - 1 < in.events.size() && !day(in.events[end - 1]).empty()) span += " – " + day(in.events[end - 1]);
  out += "# Block" + (span.empty() ? std::string() : " (" + span + ")") + "\n";
  if (text.count("")) { out += text[""]; }
  for (const auto &w : order) if (!w.empty()) out += text[w];
  return out;
}

const std::string &VnScriptService::editingRules() {
  static const std::string rules =
      "Editing: edit boldly. The script is the story of the session, not a transcript. Rewrite the GM's narration "
      "and action lines as fluent prose, and smooth in-character dialogue into literary dialogue (fix typos, grammar, "
      "chat shorthand and broken sentences, keeping each character's voice); keep every fact, name, number and "
      "decision; never invent events. Never reword dice lines.\n"
      "Leave out, listing each line under \"exclude\" with a short reason: out-of-character chatter whether or not it is "
      "labelled OOC (scheduling, rules talk, jokes about the game, reactions to dice, \"brb\"); messages posted by a bot's "
      "program (log start or end banners, help and command instructions, bot status, echoed commands) except dice "
      "results, which stay; messages that are plainly not part of the play (placeholders such as \"MISSPELL\" or "
      "\"ignore that\", resends and corrections of a line, accidental pastes, withdrawn messages); scene markers that "
      "only repeat the previous one. Every other line is placed.\n"
      "Questions: when a decision belongs to the players or the GM (whether a line is in character, whether two "
      "names are one person, whether a message was meant, how to read an ambiguous line), do not guess: put it under "
      "\"questions\" as {\"id\":\"q1\",\"question\":\"...\",\"refs\":[\"L12\"],\"options\":[\"...\"]} in the log's own "
      "language, at most five, and still return your best script for the part. The answers come back to you and you "
      "redo the part with them.";
  return rules;
}
// The user's answers, appended when a part is resumed.
std::string VnScriptService::answersPrompt(const Json::Value &questions, const Json::Value &answers) {
  std::string out = "# Answers to your questions about this part\n";
  for (const auto &q : questions) {
    auto id = json::str(q, "id");
    auto a = answers.isObject() && answers[id].isString() ? clip(answers[id].asString(), 2000) : std::string();
    out += "- " + id + " (" + quoted(clip(json::str(q, "question"), 300)) + "): " + (a.empty() ? "(no answer; decide yourself)" : a) + "\n";
  }
  out += "Redo this part with these answers: return the complete JSON for this part again (every entry, exclusion and "
         "art request), not only the changes. Ask again only if an answer raises a new question.";
  return out;
}
const std::string &VnScriptService::continuationRules() {
  static const std::string rules =
      "\n\nContinuation: this visual novel already exists, and the transcript is the play that came after its last "
      "line. \"# Story so far\" names the scene it ended on, that scene's background and its last lines; it is context "
      "only: never output entries for it. Keep the story continuous: while the first lines still play where the story "
      "ended, use that background's exact name. Reuse the existing backgrounds and portrait subtitles by their exact "
      "names wherever they fit; list under generate_backgrounds and generate_portraits only places and poses that are new.";
  return rules;
}

std::string VnScriptService::storySoFar(const Json::Value &story) {
  if (!story.isObject()) return "";
  std::string out = "# Story so far (context only, already in the visual novel)\n";
  if (!json::str(story, "scene").empty()) out += "Last scene: " + quoted(json::str(story, "scene")) + "\n";
  if (!json::str(story, "background").empty()) out += "Its background: " + quoted(json::str(story, "background")) + "\n";
  for (const auto &l : story["lines"]) if (l.isString()) out += "- " + clip(l.asString(), 300) + "\n";
  return out;
}

std::string VnScriptService::sharedPrompt(const ScriptInputs &in, const std::string &instructions) {
  std::string out;
  auto direction = clip(instructions, 1000);
  if (!direction.empty()) out += "GM direction (data): " + direction + "\n";
  return out + assetsSection(in, in.knownBackgrounds);
}

std::string VnScriptService::partPrompt(const ScriptInputs &in, std::pair<size_t, size_t> part, size_t index, size_t total, const Json::Value &known) {
  std::string out;
  // Backgrounds asked for by earlier parts of this job: after the shared prompt, since this list only grows.
  if (known.size() > in.knownBackgrounds.size()) {
    out += "# Backgrounds generated in earlier parts\n";
    for (Json::ArrayIndex i = in.knownBackgrounds.size(); i < known.size(); ++i)
      out += "- " + quoted(json::str(known[i], "name")) + " prompt=" + quoted(clip(json::str(known[i], "prompt"), 200)) + "\n";
  }
  if (index == 0 && !in.story.isNull()) out += storySoFar(in.story);   // later parts follow the part before them
  out += "Part " + std::to_string(index + 1) + " of " + std::to_string(total) + "\n";
  return out + blockSection(in, part.first, part.second);
}


} // namespace acerciae::logstudio
