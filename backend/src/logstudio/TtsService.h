#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include "TtsProvider.h"
#include "ObjectStore.h"
#include <json/json.h>
#include <atomic>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <map>

namespace acerciae { class Notifier; class ServerSettingsService; }
namespace acerciae::logstudio {
class PresentationService;

// Voice profiles, pronunciation dictionaries, synthesis cache, asynchronous batch jobs with budget,
// retries, concurrency throttling and WebSocket progress. Audio bytes live in the object store.
class TtsService {
public:
    TtsService(const Config& cfg, Db& db, ObjectStore& store, Notifier& n, PresentationService& pres, ServerSettingsService& settings);
    ~TtsService();
    void start(); void stop();

    Json::Value status(const ChannelAccess& a);
    Json::Value availableVoices(const ChannelAccess& a);
    // voice profiles
    Json::Value listVoices(const ChannelAccess& a);
    Json::Value createVoice(const ChannelAccess& a, const Json::Value& body, const std::string& refAudio, const std::string& refMime);
    Json::Value updateVoice(const ChannelAccess& a, const std::string& id, const Json::Value& body);
    Json::Value deleteVoice(const ChannelAccess& a, const std::string& id);
    // dictionaries
    Json::Value listDictionaries(const ChannelAccess& a);
    Json::Value saveDictionary(const ChannelAccess& a, const std::string& id, const Json::Value& body);   // id empty = create
    static std::string applyDictionary(const std::string& text, const Json::Value& entries, bool phonemeSupported);
    // synthesis
    Json::Value preview(const ChannelAccess& a, const Json::Value& body);                 // synchronous, cached
    Json::Value estimate(const ChannelAccess& a, const std::string& presentationId, const Json::Value& scope);
    Json::Value createJob(const ChannelAccess& a, const std::string& presentationId, const Json::Value& body);
    Json::Value getJob(const ChannelAccess& a, const std::string& jobId);
    Json::Value listJobs(const ChannelAccess& a, const std::string& presentationId);
    Json::Value cancelJob(const ChannelAccess& a, const std::string& jobId);
    Json::Value usage(const ChannelAccess& a);
    bool fetchAudio(const ChannelAccess& a, const std::string& audioId, std::string& bytes, std::string& mime);
    static std::string cacheKey(const std::string& provider, const std::string& model, const std::string& voiceId, int voiceVersion, const std::string& text, const std::string& instruction, int dictVersion, const Json::Value& params);
    Json::Value processJobNow(const std::string& jobId);    // used by tests
    TtsProvider& provider() { return *provider_; }
private:
    struct LinePlan { std::string eventId; std::string text; std::string instruction; std::string voiceProfileId; std::string voiceId; std::string modelId; int voiceVersion = 1; int dictVersion = 0; Json::Value params; std::string language; std::string cacheKey; bool cached = false; std::string cachedAudioId; };
    std::vector<LinePlan> plan(const ChannelAccess& a, const std::string& presentationId, const Json::Value& scope, bool force, const std::string& modelOverride);
    Json::Value voiceRow(const std::string& channelId, const std::string& voiceProfileId);
    std::string synthesizeLine(const std::string& channelId, const LinePlan& l, const std::string& userId, std::string& error, bool& retryable);   // returns audio asset id
    void workerLoop(); void runJob(const std::string& jobId);
    const Config& cfg_; Db& db_; ObjectStore& store_; Notifier& notifier_; PresentationService& pres_;
    std::shared_ptr<TtsProvider> provider_;
    ServerSettingsService& settings_;
    std::mutex providersMu_;
    std::map<std::string,std::shared_ptr<TtsProvider>> providers_;
    std::shared_ptr<TtsProvider> providerFor(const std::string& channelId);
    std::atomic<bool> running_{false}; std::thread worker_; std::mutex mu_; std::condition_variable cv_;
    int concurrency_ = 2;
};
}
