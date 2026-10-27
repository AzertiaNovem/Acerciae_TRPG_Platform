#pragma once
#include "../auth/AuthService.h"
#include "../core/Db.h"
#include "LogModel.h"
#include <atomic>
#include <condition_variable>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

namespace acerciae { class LlmGateway; class Notifier; }
namespace acerciae::logstudio {
class LogStudioService;
class PresentationService;
class CreativeService;

// What a planner may see and reference. Built from one snapshot; lines and names outside it never enter.
struct ScriptInputs {
  std::vector<LogEvent> events;                       // snapshot order; line ref "L<n>" = events[n-1]
  std::map<std::string, std::string> windowNames;     // chat window id → name (only windows with lines here)
  // [{ref:"C1", character_id, name, kind, default_asset_id, asset_mode, subtitles:[...], appearance_prompt}]
  Json::Value cast = Json::Value(Json::arrayValue);
  Json::Value assets = Json::Value(Json::arrayValue); // [{ref:"B1"|"M1"|"S1", id, type, name, tags, character_id, expression}]
  std::string era;                                    // the campaign's period, for background and portrait prompts
};

// Turns the campaign log into a visual-novel script, then a draft presentation.
// The model reads the log as a time-block transcript and answers with backgrounds and portraits to generate plus a
// flat script that references existing lines; it never writes or rewrites lines.
class VnScriptService {
public:
  VnScriptService(Db &db, AuthService &auth, LogStudioService &logs, PresentationService &pres, CreativeService &creative, LlmGateway &llm, Notifier &n)
      : db_(db), auth_(auth), logs_(logs), pres_(pres), creative_(creative), llm_(llm), notifier_(n) {}
  ~VnScriptService() { stop(); }
  void start();
  void stop();
  Json::Value status(const ChannelAccess &a);
  Json::Value list(const ChannelAccess &a);
  Json::Value get(const ChannelAccess &a, const std::string &id);
  // {scope?, scope_character_id?, title?, template?, instructions?, allow_cloud?} freezes the campaign log and plans it;
  // {snapshot_id} plans an existing snapshot instead.
  Json::Value create(const ChannelAccess &a, const Json::Value &body);
  Json::Value cancel(const ChannelAccess &a, const std::string &id);
  // Synchronous run of one pending job (tests and the worker).
  bool processNext();

  // ---- pure planning helpers (unit tested) ----
  static constexpr size_t kMaxLines = 4000;
  static constexpr long long kBlockGapSeconds = 3600;
  // Consecutive line index ranges [begin, end) small enough for one model call.
  static std::vector<std::pair<size_t, size_t>> chunk(const std::vector<LogEvent> &events, size_t maxLines, size_t maxChars);
  // Time blocks: a new block starts when no window carried a line for `gapSeconds`.
  static std::vector<std::pair<size_t, size_t>> blocks(const std::vector<LogEvent> &events, long long gapSeconds = kBlockGapSeconds);
  // The transcript one model call reads: assets header, then the block's lines grouped by chat window.
  static std::string transcript(const ScriptInputs &in, size_t begin, size_t end, const Json::Value &knownBackgrounds);
  // Deterministic answer in the model's shape: {generate_backgrounds, generate_portraits, script}.
  static Json::Value mockFlat(const ScriptInputs &in, size_t begin, size_t end);
  // Flat answers → scene plan (a scene per background change, speakers staged with their portrait subtitle).
  static Json::Value fromFlat(const ScriptInputs &in, const std::vector<Json::Value> &flats);
  // Legacy deterministic plan (kept for the editor's "advanced" path): groups lines by chat window and canonical scene.
  static Json::Value mockPlan(const ScriptInputs &in);
  // Validates one or more raw plans against the inputs and produces the stored script (real ids, bounded values).
  // Lines the plans skip stay visible in place; only lines excluded with a reason are hidden.
  static Json::Value normalize(const ScriptInputs &in, const std::vector<Json::Value> &plans, const std::string &provider);
  // The label a line carries in the transcript: "Ada Quill", "Ada Quill(OOC)", "KP(Narrative)", "KP(as Old Tom)".
  static std::string speakerLabel(const LogEvent &e);

private:
  void loop();
  void run(const Json::Value &job);
  ScriptInputs inputs(const ChannelAccess &a, const std::string &snapshotId, Json::Value *snap);
  Json::Value planWithModel(const ChannelAccess &a, const ScriptInputs &in, const Json::Value &job);
  Json::Value queueArt(const ChannelAccess &a, const Json::Value &script, const std::string &presentationId, bool cloudAuthorized);
  void progress(const std::string &channelId, const std::string &jobId, const Json::Value &p, const std::string &status);
  Db &db_;
  AuthService &auth_;
  LogStudioService &logs_;
  PresentationService &pres_;
  CreativeService &creative_;
  LlmGateway &llm_;
  Notifier &notifier_;
  std::atomic<bool> running_{false};
  std::thread thread_;
  std::mutex mu_;
  std::condition_variable cv_;
};
} // namespace acerciae::logstudio
