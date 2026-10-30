#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <set>
#include <string>
#include <thread>

namespace acerciae {
class EventStore; class DocumentService; class HighlightService; class ContextRetrievalService; class LlmGateway; class Notifier; class KnowledgeService; class ScenarioService; class ReminderService; class ScriptKnowledgeService;

// Background AI observer. Three independent loops:
//   observe      (default 5 s)  – high-frequency fact identification + localised document updates
//   consolidate  (default 60 s) – low-frequency relationship consolidation / thread review
//   cleanup      (default 30 s) – highlight expiry
// No LLM call is made when there are no new events. Each (channel, window, scene) group has its own
// cursor and a DB-level task lock (ai_jobs partial unique index), so identical events are never
// processed twice and two cycles never modify the same documents concurrently.
class ObserverScheduler {
public:
    ObserverScheduler(const Config& cfg, Db& db, EventStore& events, DocumentService& docs, HighlightService& highlights,
                      ContextRetrievalService& retrieval, LlmGateway& llm, Notifier& notifier, KnowledgeService& knowledge, ScenarioService& scenarios, ReminderService& reminders, ScriptKnowledgeService& script);
    ~ObserverScheduler();
    bool aiEnabled(const std::string& channelId);   // the channel's ai_enabled switch
    void setAtmosphereHook(std::function<void(const std::string&,const Json::Value&)> hook) { atmosphereHook_=std::move(hook); }
    void start();
    void stop();

    // Synchronous entry points (used by the admin API and the tests).
    Json::Value observeChannel(const std::string& channelId, bool waitForInflight = false);   // processes every pending group once
    Json::Value consolidateChannel(const std::string& channelId);
    int cleanupHighlights();
    Json::Value status() const;
    Json::Value listJobs(const std::string& channelId, int limit);

    static Json::Value observerSchema();
    static Json::Value consolidateSchema();
    static std::string observerSystemPrompt();
private:
    Json::Value processPlayerGroup(const std::string& channelId, const Json::Value& group, bool wait, int64_t safeSeq);
    void observeLoop(); void consolidateLoop(); void cleanupLoop();
    void observeTick();
    Json::Value processGroup(const std::string& channelId, const std::string& windowId, const std::string& sceneId, int64_t safeSeq, bool waitForInflight);
    // The highest event seq below which every event of the channel has committed: event writers hold a shared
    // advisory lock until commit, so taking it exclusively waits out every write in flight.
    int64_t safeSeq(const std::string& channelId);
    // Failure bookkeeping per cursor group: exponential backoff, and after kMaxAttempts the batch is skipped
    // (dead-lettered) so a batch that always fails is not paid for forever. Returns true when it was skipped.
    bool recordFailure(const std::string& channelId, const std::string& kind, const std::string& key, int64_t skipTo, const std::string& jobId, const std::string& error);
    bool backingOff(const std::string& channelId, const std::string& kind, const std::string& key);
    static constexpr int kMaxAttempts = 5;
    Json::Value buildGroupContext(const ChannelAccess& sys, const std::string& channelId, const std::string& windowId, const std::string& sceneId, const Json::Value& batch, std::vector<std::string>& terms);
    void applyExtraction(const ChannelAccess& sys, const std::string& channelId, const std::string& jobId, const Json::Value& data, const Json::Value& batch, Json::Value& summary);
    ChannelAccess systemAccess(const std::string& channelId);
    bool tryLock(const std::string& key, bool wait);
    void unlock(const std::string& key);

    std::function<void(const std::string&,const Json::Value&)> atmosphereHook_;
    const Config& cfg_; Db& db_; EventStore& events_; DocumentService& docs_; HighlightService& highlights_;
    ContextRetrievalService& retrieval_; LlmGateway& llm_; Notifier& notifier_; KnowledgeService& knowledge_; ScenarioService& scenarios_; ReminderService& reminders_; ScriptKnowledgeService& script_;
    std::atomic<bool> running_{false};
    std::thread observeThread_, consolidateThread_, cleanupThread_;
    std::mutex cvMu_; std::condition_variable cv_;
    std::mutex lockMu_; std::condition_variable lockCv_; std::set<std::string> locks_;
    std::atomic<int> ticks_{0}, groupsProcessed_{0}, llmCalls_{0};
};
}
