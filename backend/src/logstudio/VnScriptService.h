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

// What a planner may see and reference. Built from one snapshot; lines and names outside it never enter.
struct ScriptInputs {
  std::vector<LogEvent> events;                       // snapshot order; line ref "L<n>" = events[n-1]
  std::map<std::string, std::string> windowNames;     // chat window id → name (only windows with lines here)
  Json::Value cast = Json::Value(Json::arrayValue);   // [{ref:"C1", character_id, name, kind, default_asset_id}]
  Json::Value assets = Json::Value(Json::arrayValue); // [{ref:"B1"|"M1"|"S1", id, type, name, tags, character_id, expression}]
};

// Turns a campaign log into a visual-novel script, then a draft presentation.
// The model organises existing lines (scenes, order, staging, delivery); it never writes or rewrites lines.
class VnScriptService {
public:
  VnScriptService(Db &db, AuthService &auth, LogStudioService &logs, PresentationService &pres, LlmGateway &llm, Notifier &n)
      : db_(db), auth_(auth), logs_(logs), pres_(pres), llm_(llm), notifier_(n) {}
  ~VnScriptService() { stop(); }
  void start();
  void stop();
  Json::Value status(const ChannelAccess &a);
  Json::Value list(const ChannelAccess &a);
  Json::Value get(const ChannelAccess &a, const std::string &id);
  Json::Value create(const ChannelAccess &a, const Json::Value &body);   // {snapshot_id, title?, template?, instructions?, allow_cloud?}
  Json::Value cancel(const ChannelAccess &a, const std::string &id);
  // Synchronous run of one pending job (tests and the worker).
  bool processNext();

  // ---- pure planning helpers (unit tested) ----
  static constexpr size_t kMaxLines = 4000;
  // Consecutive line index ranges [begin, end) small enough for one model call.
  static std::vector<std::pair<size_t, size_t>> chunk(const std::vector<LogEvent> &events, size_t maxLines, size_t maxChars);
  // Deterministic plan in the same shape the model returns: groups lines by chat window and canonical scene.
  static Json::Value mockPlan(const ScriptInputs &in);
  // Validates one or more raw plans against the inputs and produces the stored script (real ids, bounded values).
  // Lines the plans skip stay visible in place; only lines excluded with a reason are hidden.
  static Json::Value normalize(const ScriptInputs &in, const std::vector<Json::Value> &plans, const std::string &provider);

private:
  void loop();
  void run(const Json::Value &job);
  ScriptInputs inputs(const ChannelAccess &a, const std::string &snapshotId, Json::Value *snap);
  Json::Value planWithModel(const ChannelAccess &a, const ScriptInputs &in, const Json::Value &job);
  void progress(const std::string &channelId, const std::string &jobId, const Json::Value &p, const std::string &status);
  Db &db_;
  AuthService &auth_;
  LogStudioService &logs_;
  PresentationService &pres_;
  LlmGateway &llm_;
  Notifier &notifier_;
  std::atomic<bool> running_{false};
  std::thread thread_;
  std::mutex mu_;
  std::condition_variable cv_;
};
} // namespace acerciae::logstudio
