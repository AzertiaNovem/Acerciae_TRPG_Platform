#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>

namespace acerciae {
class ContextRetrievalService; class LlmGateway;

// The player's helper: three possible next lines for a character, in their own voice, from what they know. Built like
// the GM agent's co-player (gm-agent/src/coplayer.mjs): a readable prompt that says who the character is (persona,
// speaking style, role card, condition), who is with them, when and where the story is, what they know and the lines
// they witnessed, then asks for their move, under the same tablemate rules (short lines, never narrate outcomes,
// support the others, roll when an action calls for it). It differs in two ways: it offers three options, since a
// person chooses, and it may look up the character's own records (the knowledge tools). Never sends anything.
class InspirationService {
public:
    InspirationService(const Config& cfg, Db& db, ContextRetrievalService& r, LlmGateway& llm) : cfg_(cfg), db_(db), retrieval_(r), llm_(llm) {}
    // {chat_window_id, character_id?, hint?, variant?, avoid?: [texts already shown]} → {options[{text, kind, roll,
    // angle}], draft (= the first option's text), used_fact_ids, notes, …}.
    Json::Value draft(const ChannelAccess& a, const std::string& chatWindowId, const std::string& characterId, const std::string& hint, int variant, const Json::Value& avoid = Json::Value());
    static Json::Value schema();

    // The prompt's parts, for tests. A witnessed line: "#12 Ada: text", "#13 GM (narration): text", "(out of character)".
    static std::string renderLogLine(const Json::Value& event, const std::string& gm);
    // The role card as the co-player reads its own: basics, characteristics, the best skills, background, items.
    static std::string cardSummary(const Json::Value& card, const Json::Value& attrs, const std::string& ruleSystem);
    // The dice command shape of a rule system, for the prompt ("" when the system has none the player would send).
    static std::string diceShape(const std::string& ruleSystem);
private:
    const Config& cfg_; Db& db_; ContextRetrievalService& retrieval_; LlmGateway& llm_;
};
}
