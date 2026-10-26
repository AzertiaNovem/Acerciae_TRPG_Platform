#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <string>
#include <vector>

namespace acerciae {
class LlmGateway; class HighlightService;

// User-triggered recall: "what has already been said about this?"
// Two pools the caller may read are searched: verbatim chat messages and the chronicler's existing records
// (journal entries about clues, people, places, threads). The model's only job is to choose which candidates
// concern the query and to group them; every returned item comes from the database, never from model text,
// and a group label must be a phrase quoted from the query or from a chosen item. No score, no verdict,
// no drafted reply.
class RecallService {
public:
    RecallService(const Config& cfg, Db& db, LlmGateway& llm, HighlightService& h) : cfg_(cfg), db_(db), llm_(llm), highlights_(h) {}
    // mode: "hint" = a question (empty = what the window is talking about right now); "draft" = the message being written.
    Json::Value recall(const ChannelAccess& a, const std::string& chatWindowId, const std::string& characterId, const std::string& query, const std::string& mode, int variant);
    Json::Value history(const ChannelAccess& a, int limit);
    static Json::Value schema();

    // ---- pure helpers (unit tested) ----
    struct Pools { Json::Value messages = Json::Value(Json::arrayValue); Json::Value records = Json::Value(Json::arrayValue); };   // candidates carry "ref": M1.. / K1..
    // Search terms: proper nouns, keywords, and adjacent-character pairs for CJK text (which has no word spaces).
    static std::vector<std::string> terms(const std::string& query);
    // Deterministic planner: candidates grouped by the strongest matching term; the label is that term as written in the query.
    static Json::Value mockPlan(const std::string& query, const Pools& pools, int variant);
    // Validates a plan ({topics:[{label, refs}]}) against the pools: unknown refs and duplicates are dropped,
    // a label that is not quoted from the query or a chosen item becomes empty, at most 6 topics / 16 items.
    static Json::Value normalize(const std::string& query, const Pools& pools, const Json::Value& plan, const std::string& provider);
private:
    const Config& cfg_; Db& db_; LlmGateway& llm_; HighlightService& highlights_;
};
}
