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

// Independent KP/player-group memory. Legacy scope helpers remain for historical metadata.
class KnowledgeService {
public:
    explicit KnowledgeService(Db& db) : db_(db) {}

    // Derive the knowledge scope of a fact from the events it cites: the audience that witnessed ALL of them.
    KnowledgeScope deriveScope(pqxx::work& w, const std::string& channelId, const std::string& knowledgeMode, const std::vector<std::string>& sourceEventIds);
    void setScope(pqxx::work& w, const std::string& factId, const KnowledgeScope& s, const std::string& source);
    KnowledgeScope getScope(pqxx::work& w, const std::string& factId);
    Json::Value getScopeJson(const ChannelAccess& a, const std::string& factId);
    // Retired sharing endpoint: rejects attempts to expose KP facts to player groups.
    Json::Value gmSetScope(const ChannelAccess& a, const std::string& factId, const KnowledgeScope& s);

    // Entities and relations ----------------------------------------------------------------
    std::string upsertEntity(pqxx::work& w, const std::string& channelId, const std::string& kind, const std::string& name, const std::string& description = "", const std::string& groupId = "");
    Json::Value findEntity(pqxx::work& w, const std::string& channelId, const std::string& name, const std::string& groupId = "");   // by name/alias, any kind
    void linkFactEntity(pqxx::work& w, const std::string& factId, const std::string& entityId, const std::string& role);
    std::string addRelation(pqxx::work& w, const std::string& channelId, const std::string& fromEntity, const std::string& toEntity, const std::string& relation, const std::string& factId);

    Json::Value playerGroups(const ChannelAccess& a);
    Json::Value createPlayerGroup(const ChannelAccess& a, const std::string& name);
    Json::Value movePlayer(const ChannelAccess& a, const std::string& groupId, const std::string& userId);
    Json::Value renamePlayerGroup(const ChannelAccess& a, const std::string& groupId, const std::string& name);

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
