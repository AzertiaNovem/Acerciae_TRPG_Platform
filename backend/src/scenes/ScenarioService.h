#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <string>

namespace acerciae {
class EventStore; class SceneManager; class LlmGateway; class Notifier;

// Scenarios are the stages of the story. The Keeper's observer asks, after each processed batch of a chat
// window, whether the story has moved on (a new place, a jump in time, an explicit scene marker). When it
// has, the window moves into a new scenario from the boundary event on, the previous scenario closes once no
// window is left in it, and an AI summary of the closed scenario is written into the scenario list.
// Summaries written by the GM are never overwritten.
class ScenarioService {
public:
    ScenarioService(Db& db, EventStore& events, SceneManager& scenes, LlmGateway& llm, Notifier& n) : db_(db), events_(events), scenes_(scenes), llm_(llm), notifier_(n) {}

    // Observer hook for one (window, scenario) batch that was just processed. Returns the decision taken.
    Json::Value detectAndAdvance(const std::string& channelId, const std::string& windowId, const std::string& sceneId, const Json::Value& batch, int& llmCalls);
    // GM: open the next scenario for a window now. body {chat_window_id, title?, location?, narrative_time?, boundary_event_id?}
    Json::Value advance(const ChannelAccess& a, const Json::Value& body);
    // GM: (re)write the AI summary of a scenario.
    Json::Value summarize(const ChannelAccess& a, const std::string& sceneId);
    // GM: turn automatic stage detection on or off for the campaign.
    Json::Value setAuto(const ChannelAccess& a, bool enabled);

    static Json::Value detectSchema();
    static Json::Value summarySchema();
    // Deterministic stand-ins used without a model (unit tested). ctx shapes are documented in the .cpp.
    static Json::Value mockDetect(const Json::Value& ctx);
    static Json::Value mockSummary(const Json::Value& ctx);
private:
    struct Stage { std::string title, location, narrativeTime, reason; };
    // Creates the next scenario, moves the window (and its events from the boundary on) into it, closes the
    // previous scenario when empty, and keeps the observer cursor so moved events are not extracted twice.
    // processedThroughSeq: events of this window up to this seq were already extracted by the caller (0 = unknown).
    Json::Value advanceInternal(const std::string& channelId, const std::string& windowId, const std::string& fromSceneId, const Stage& stage, const std::string& boundaryEventId, const std::string& actorUserId, bool autoDetected, int64_t processedThroughSeq);
    void summarizeScene(const std::string& channelId, const std::string& sceneId, int& llmCalls);
    Db& db_; EventStore& events_; SceneManager& scenes_; LlmGateway& llm_; Notifier& notifier_;
};
}
