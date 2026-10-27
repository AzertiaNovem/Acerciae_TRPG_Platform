#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include "../llm/Llm.h"
#include <json/json.h>

namespace acerciae {
class KnowledgeService; class EventStore; class LlmGateway;

// The restricted internal Tool API the model may call. Every method takes the caller's ChannelAccess
// and applies the same visibility filters as the HTTP API, so the model can never read beyond the
// knowledge scope of the identity it works for. Shards are addressed as "<kind>/<id>".
class ContextRetrievalService {
public:
    ContextRetrievalService(Db& db, KnowledgeService& k, EventStore& e, LlmGateway& llm) : db_(db), knowledge_(k), events_(e), llm_(llm) {}

    Json::Value getCurrentScene(const ChannelAccess& a, const std::string& chatWindowId, int logLimit);
    Json::Value getSceneById(const ChannelAccess& a, const std::string& sceneId, int logLimit);
    Json::Value searchSceneHistory(const ChannelAccess& a, const std::string& query, const std::string& sceneId, const std::string& excludeSceneId, int limit);
    Json::Value searchEvents(const ChannelAccess& a, const std::string& query, const std::string& sceneId, int limit);
    Json::Value getEntity(const ChannelAccess& a, const std::string& idOrName);
    Json::Value getRelationships(const ChannelAccess& a, const std::string& idOrName);
    Json::Value getClue(const ChannelAccess& a, const std::string& idOrQuery);
    Json::Value getOpenThreads(const ChannelAccess& a);
    Json::Value getModuleExcerpt(const ChannelAccess& a, const std::string& query, const std::string& nodeId);
    Json::Value getKnowledgeScope(const ChannelAccess& a, const std::string& characterId);
    Json::Value getShard(const ChannelAccess& a, const std::string& shardId);
    Json::Value semanticSearch(const ChannelAccess& a, const std::string& query, int limit);   // pgvector, if enabled
    // The story's stages in order (Keeper: with summaries; players: neutral labels over readable chat).
    Json::Value listScenarios(const ChannelAccess& a);
    // Verbatim chat lines, the authoritative record: by scenario, window, time range, or around one event.
    Json::Value getChatLog(const ChannelAccess& a, const Json::Value& args);

    // Dispatcher used by the LLM tool loop.
    Json::Value executeTool(const ChannelAccess& a, const std::string& name, const Json::Value& args);
    static std::vector<LlmToolSpec> toolSpecs(bool gm);

    // Rule-based pre-retrieval used by the observer: facts outside `sceneId` that mention terms of `textual`.
    Json::Value relatedHistory(const ChannelAccess& a, const std::vector<std::string>& terms, const std::string& excludeSceneId, int limit);
    // Compact document snapshot used in prompts.
    Json::Value documentSnapshot(const ChannelAccess& a, const std::string& docType, const std::string& sceneId, int limit);

    void indexEmbedding(const std::string& factId, const std::string& textual);   // no-op when embeddings disabled
    bool embeddingsEnabled();
private:
    Db& db_; KnowledgeService& knowledge_; EventStore& events_; LlmGateway& llm_;
    int vectorState_ = -1;
};
}
