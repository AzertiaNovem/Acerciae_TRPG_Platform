#pragma once
#include <functional>
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <string>

namespace acerciae {
class EventStore; class SceneManager; class LlmGateway; class Notifier;

// Scenarios are the stages of the story and a campaign-wide state: every chat window is in the channel's
// current scenario. Only the Keeper opens the next one (or enters a prepared one); the moment a new scenario
// begins, the previous one closes, its AI summary is written into the scenario list, and it can only be
// consulted from then on. The Keeper's observer still watches the narration: when it sees a shift of time or
// place it raises a suggestion bubble for the Keeper, never a scenario of its own. Summaries written by the GM
// are never overwritten.
class ScenarioService {
public:
    ScenarioService(Db& db, EventStore& events, SceneManager& scenes, LlmGateway& llm, Notifier& n) : db_(db), events_(events), scenes_(scenes), llm_(llm), notifier_(n) {}
    // Where background summaries run: a bounded pool that shutdown waits for (false = queue full).
    void setExecutor(std::function<bool(std::function<void()>)> f) { executor_ = std::move(f); }

    // Observer hook for one (window, scenario) batch that was just processed. When the Keeper's narration moved
    // the story, a "New scenario?" reminder is raised for the Keeper, anchored to the boundary line.
    Json::Value detectAndSuggest(const std::string& channelId, const std::string& windowId, const std::string& sceneId, const Json::Value& batch, int& llmCalls);
    // GM: open the next scenario for the whole campaign now. body {title?, location?, narrative_time?}
    Json::Value advance(const ChannelAccess& a, const Json::Value& body);
    // GM: enter a prepared (still active, never closed) scenario; the current one closes and is summarized.
    Json::Value enter(const ChannelAccess& a, const std::string& sceneId);
    // GM: (re)write the AI summary of a scenario.
    Json::Value summarize(const ChannelAccess& a, const std::string& sceneId);
    // GM: turn stage-change suggestions on or off for the campaign.
    Json::Value setAuto(const ChannelAccess& a, bool enabled);

    static Json::Value detectSchema();
    static Json::Value summarySchema();
    // Deterministic stand-ins used without a model (unit tested). ctx shapes are documented in the .cpp.
    static Json::Value mockDetect(const Json::Value& ctx);
    static Json::Value mockSummary(const Json::Value& ctx);
private:
    struct Stage { std::string title, location, narrativeTime, reason; };
    // Writes the summary of a closed scenario: at once with the mock model, on a detached thread otherwise.
    void summarizeClosed(const std::string& channelId, const std::string& sceneId);
    void summarizeScene(const std::string& channelId, const std::string& sceneId, int& llmCalls);
    std::function<bool(std::function<void()>)> executor_;
    Db& db_; EventStore& events_; SceneManager& scenes_; LlmGateway& llm_; Notifier& notifier_;
};
}
