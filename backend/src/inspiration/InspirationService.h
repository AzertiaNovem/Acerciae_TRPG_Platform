#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>

namespace acerciae {
class ContextRetrievalService; class LlmGateway;

// User-triggered draft generation. Uses only the character's accessible knowledge; never sends.
class InspirationService {
public:
    InspirationService(const Config& cfg, Db& db, ContextRetrievalService& r, LlmGateway& llm) : cfg_(cfg), db_(db), retrieval_(r), llm_(llm) {}
    Json::Value draft(const ChannelAccess& a, const std::string& chatWindowId, const std::string& characterId, const std::string& hint, int variant);
    static Json::Value schema();
private:
    const Config& cfg_; Db& db_; ContextRetrievalService& retrieval_; LlmGateway& llm_;
};
}
