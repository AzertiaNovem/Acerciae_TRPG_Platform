#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>

namespace acerciae {
class ContextRetrievalService; class LlmGateway; class HighlightService; class KnowledgeService;

// User-triggered only. Combines a rule layer (keyword evidence gathering, possession/location rules)
// with an LLM judgement, restricted to the knowledge the requesting character may access.
class ConsistencyService {
public:
    ConsistencyService(const Config& cfg, Db& db, ContextRetrievalService& r, LlmGateway& llm, HighlightService& h, KnowledgeService& k)
        : cfg_(cfg), db_(db), retrieval_(r), llm_(llm), highlights_(h), knowledge_(k) {}
    Json::Value check(const ChannelAccess& a, const std::string& chatWindowId, const std::string& characterId, const std::string& draft);
    Json::Value history(const ChannelAccess& a, int limit);
    static Json::Value schema();
    static Json::Value gatherEvidence(Db& db, const ChannelAccess& a, const std::string& characterId, const std::string& draft, int limit);
private:
    const Config& cfg_; Db& db_; ContextRetrievalService& retrieval_; LlmGateway& llm_; HighlightService& highlights_; KnowledgeService& knowledge_;
};
}
