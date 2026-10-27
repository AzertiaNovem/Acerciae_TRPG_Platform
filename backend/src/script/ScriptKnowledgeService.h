#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <map>
#include <string>

namespace acerciae {
class LlmGateway; class ContextRetrievalService; class ReminderService; class Notifier;

// The Keeper's script knowledge. Built once from the structured module: who relates to whom, which clues exist,
// what is foreshadowed, the background, and above all the flow of the script (its stages in order, with what
// each needs and what the Keeper does there). It is read by the model before anything else when it works for
// the Keeper. During play the model proposes changes (a stage reached, a clue revealed, a twist paid off); a
// second model reviews each proposal against the quoted chat lines and the script before it is applied.
// Keeper edits are final and never overwritten automatically. Nothing here is reachable by a player group.
class ScriptKnowledgeService {
public:
    ScriptKnowledgeService(Db& db, LlmGateway& llm, ContextRetrievalService& retrieval, ReminderService& reminders, Notifier& n)
        : db_(db), llm_(llm), retrieval_(retrieval), reminders_(reminders), notifier_(n) {}

    // Builds (or rebuilds) the script-origin entries of one module; Keeper-edited and play-origin entries survive.
    Json::Value buildFromModule(const std::string& channelId, const std::string& moduleId, int& llmCalls);
    // Keeper observer hook for one processed batch: propose → review → apply, refresh the board, raise reminders.
    Json::Value afterBatch(const ChannelAccess& sys, const Json::Value& batch, const std::string& aiJobId, int& llmCalls);

    Json::Value list(const ChannelAccess& a, const std::string& kind);
    Json::Value update(const ChannelAccess& a, const std::string& id, const Json::Value& body);   // Keeper edit: title, body, status
    Json::Value rebuild(const ChannelAccess& a, const std::string& moduleId);
    Json::Value changes(const ChannelAccess& a, int limit);
    Json::Value board(const ChannelAccess& a);

    // Deterministic stand-ins used without a model (and by the unit tests).
    static Json::Value mockBuild(const Json::Value& graph);      // {nodes, edges} → {entries}
    static Json::Value mockPropose(const Json::Value& ctx);      // {knowledge, new_events} → {changes}
    static Json::Value mockReview(const Json::Value& ctx);       // {change, entry, evidence_lines} → {verdict, reason}
    static Json::Value buildSchema(); static Json::Value proposeSchema(); static Json::Value reviewSchema();
    // Words of a title that identify it in prose (lowercase, generic words removed).
    static std::vector<std::string> titleTerms(const std::string& title);
private:
    Json::Value compactKnowledge(const std::string& channelId);   // [{id, kind, title, status, position, gm_edited, citations}]
    Json::Value proposeChanges(const ChannelAccess& sys, const Json::Value& knowledge, const Json::Value& newEvents, int& llmCalls);
    Json::Value reviewChange(const ChannelAccess& sys, const Json::Value& change, const Json::Value& entry, const Json::Value& evidence, int& llmCalls);
    void refreshBoard(const ChannelAccess& sys, const std::string& aiJobId, const std::vector<std::string>& eventIds);
    Db& db_; LlmGateway& llm_; ContextRetrievalService& retrieval_; ReminderService& reminders_; Notifier& notifier_;
};
}
