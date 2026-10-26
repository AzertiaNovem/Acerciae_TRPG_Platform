#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <string>
#include <vector>
#include <set>

namespace acerciae {

// Derived knowledge scope for a fact: who may know it.
struct KnowledgeScope {
    std::string scope = "gm";                  // 'gm' | 'public' | 'character'
    std::vector<std::string> characterIds;     // when scope == 'character'
    bool narrowerThan(const KnowledgeScope& o) const;
    KnowledgeScope intersect(const KnowledgeScope& o) const;
    Json::Value toJson() const;
    static KnowledgeScope fromJson(const Json::Value& v);
};

// Fact–Knower model: facts are stored once; knowledge_visibility rows record who knows them.
class KnowledgeService {
public:
    explicit KnowledgeService(Db& db) : db_(db) {}

    // Derive the knowledge scope of a fact from the events it cites: the audience that witnessed ALL of them.
    KnowledgeScope deriveScope(pqxx::work& w, const std::string& channelId, const std::string& knowledgeMode, const std::vector<std::string>& sourceEventIds);
    void setScope(pqxx::work& w, const std::string& factId, const KnowledgeScope& s, const std::string& source);
    KnowledgeScope getScope(pqxx::work& w, const std::string& factId);
    Json::Value getScopeJson(const ChannelAccess& a, const std::string& factId);
    // GM override of who knows a fact (also records a `knowledge.shared` event for traceability).
    Json::Value gmSetScope(const ChannelAccess& a, const std::string& factId, const KnowledgeScope& s);

    // Entities and relations ----------------------------------------------------------------
    std::string upsertEntity(pqxx::work& w, const std::string& channelId, const std::string& kind, const std::string& name, const std::string& description = "");
    Json::Value findEntity(pqxx::work& w, const std::string& channelId, const std::string& name);   // by name/alias, any kind
    void linkFactEntity(pqxx::work& w, const std::string& factId, const std::string& entityId, const std::string& role);
    std::string addRelation(pqxx::work& w, const std::string& channelId, const std::string& fromEntity, const std::string& toEntity, const std::string& relation, const std::string& factId);

    // Viewer-facing queries ---------------------------------------------------------------------
    Json::Value listFacts(const ChannelAccess& a, const std::string& kind, const std::string& query, const std::string& sceneId, int limit);
    Json::Value getFact(const ChannelAccess& a, const std::string& factId);
    Json::Value listEntities(const ChannelAccess& a, const std::string& query);
    Json::Value getEntity(const ChannelAccess& a, const std::string& entityId);
    Json::Value relationsOf(const ChannelAccess& a, const std::string& entityId);
    Json::Value knowledgeScope(const ChannelAccess& a, const std::string& characterId);  // facts a character knows
    Json::Value channelMode(const std::string& channelId);
private:
    Db& db_;
};

} // namespace acerciae
