#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <map>
#include <string>

namespace acerciae {
class LlmGateway; class ContextRetrievalService; class Notifier;

// Reminder bubbles. After each processed batch of a player group's chat, the model reads the group's hidden
// knowledge index, the current scenario, the end of the previous one and the newest lines, and points out
// what the players most likely forgot or need right now while maintaining existing reminders in the same plan. Every reminder is anchored to verbatim quotes from
// chat lines the group can read; quotes that cannot be found in those lines are dropped, and a reminder
// without a verified quote is never shown. Opening a reminder shows the chat log around the quoted lines.
class ReminderService {
public:
    ReminderService(Db& db, LlmGateway& llm, ContextRetrievalService& retrieval, Notifier& n) : db_(db), llm_(llm), retrieval_(retrieval), notifier_(n) {}

    // Observer hook for one player group batch. Maintains the group's scenario outlines and creates/updates/resolves/defers/reactivates reminders.
    Json::Value afterBatch(const ChannelAccess& view, const Json::Value& batch, const std::string& aiJobId, int& llmCalls);
    // Keeper observer hook. `knowledge` is the compact script knowledge (id, kind, title, status, citations); Keeper
    // reminders may add script_refs that point at it, but every reminder still quotes the chat verbatim.
    Json::Value afterBatchKp(const ChannelAccess& sys, const Json::Value& batch, const std::string& aiJobId, int& llmCalls, const Json::Value& knowledge);

    Json::Value list(const ChannelAccess& a);                                        // active reminders for the caller, minus dismissed
    Json::Value dismiss(const ChannelAccess& a, const std::string& id);              // per user
    Json::Value context(const ChannelAccess& a, const std::string& id, int limit);  // chat log around the quoted lines, viewer-filtered

    static Json::Value schema();
    // Deterministic planner used without a model. ctx: {current_log, previous_tail, new_events, existing_titles}
    static Json::Value mockPlan(const Json::Value& ctx);
    // Keeper planner: mockPlan over the Keeper's view plus script-driven reminders (an unrevealed clue or twist the
    // newest lines touch). ctx adds knowledge: [{id, kind, title, status, citations}].
    static Json::Value mockPlanKp(const Json::Value& ctx);
    static Json::Value mockChanges(const Json::Value& ctx);
    // The sentence of `content` that contains `needle` (case-insensitive), as an exact substring of content.
    static std::string sentenceWith(const std::string& content, const std::string& needle);
    // Keeps only quotes that are verbatim substrings of readable lines; groups them per event.
    static Json::Value resolveCitations(const Json::Value& quotes, const std::map<std::string, Json::Value>& readable);
    static std::string dedupeKey(const std::string& title, const Json::Value& citations);
private:
    Json::Value buildContext(const ChannelAccess& view, const std::string& currentScene, const Json::Value& batch, const std::string& groupFilter);
    Json::Value store(const ChannelAccess& view, const Json::Value& plan, const Json::Value& ctx, const std::string& currentScene, const std::string& aiJobId, int maxNew);
    void updateOutlines(const ChannelAccess& view, const std::string& currentScene, const Json::Value& batch, int& llmCalls);
    Json::Value readableLines(const ChannelAccess& view, const std::string& sceneId, int limit, bool tail);
    Db& db_; LlmGateway& llm_; ContextRetrievalService& retrieval_; Notifier& notifier_;
};
}
