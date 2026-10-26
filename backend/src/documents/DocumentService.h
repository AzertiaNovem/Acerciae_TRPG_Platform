#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include "../knowledge/KnowledgeService.h"
#include <json/json.h>
#include <string>
#include <vector>

namespace acerciae {
class Notifier;

// A proposal is what the AI (or the GM) asks to change. The backend validates and commits.
struct Proposal {
    std::string playerGroupId;
    int playerGroupVersion = 0;
    std::vector<std::string> allowedSourceEventIds; // batch allow-list for player AI

    std::string channelId;
    std::string documentType;        // resolved to documentId
    std::string documentId;
    int expectedVersion = -1;        // -1 = not checked
    Json::Value ops = Json::Value(Json::arrayValue);
    std::vector<std::string> sourceEventIds;   // default sources for ops lacking their own
    Json::Value evidence = Json::Value(Json::arrayValue);
    std::string actor = "ai";        // ai | gm | system
    std::string actorUserId;
    std::string aiJobId;
    std::string summary;
};

struct CommitResult {
    std::string documentId;
    std::string docType;
    int version = 0;
    int applied = 0;
    int rejected = 0;
    int pendingReview = 0;
    bool gmOnly = false;
    Json::Value log = Json::Value(Json::arrayValue);     // per-op decision
    std::vector<std::string> touchedFactIds;
    std::vector<std::string> touchedEntryIds;
    std::vector<std::string> sourceEventIds;
};

class DocumentService {
public:
    DocumentService(Db& db, KnowledgeService& knowledge, Notifier& notifier) : db_(db), knowledge_(knowledge), notifier_(notifier) {}

    void ensureCoreDocuments(pqxx::work& w, const std::string& channelId);
    std::string documentIdFor(pqxx::work& w, const std::string& channelId, const std::string& docType);

    // Validation + commit. Never throws for per-op problems: they are recorded in the result log.
    // Throws ApiError for structural problems (unknown document, version conflict).
    CommitResult commit(const Proposal& p);

    // Reading (viewer filtered)
    Json::Value listDocuments(const ChannelAccess& a, int sinceVersionHint);
    Json::Value getDocument(const ChannelAccess& a, const std::string& documentId, const std::string& sceneId, int sinceVersion);
    Json::Value getEntry(const ChannelAccess& a, const std::string& entryId);
    Json::Value listRevisions(const ChannelAccess& a, const std::string& documentId, int limit);
    Json::Value getRevision(const ChannelAccess& a, const std::string& documentId, int version);
    Json::Value relatedEntries(const ChannelAccess& a, const std::string& entryId);

    // GM corrections and rollback
    Json::Value gmCorrectEntry(const ChannelAccess& a, const std::string& documentId, const std::string& entryId, const Json::Value& body);
    Json::Value gmRollback(const ChannelAccess& a, const std::string& documentId, int toVersion);
    Json::Value listProposals(const ChannelAccess& a, const std::string& status);
    Json::Value decideProposal(const ChannelAccess& a, const std::string& proposalId, bool accept);

    // Markdown projection of a single fact (used when the AI gives no content_md).
    static std::string renderEntry(const std::string& kind, const Json::Value& fact);
    static std::string titleFor(const std::string& docType);
    static const std::vector<std::string>& coreDocTypes();

private:
    struct OpContext;
    void applyOp(pqxx::work& w, OpContext& ctx, const Json::Value& op, CommitResult& res);
    Json::Value snapshotEntries(pqxx::work& w, const std::string& documentId);
    void indexFact(pqxx::work& w, const std::string& channelId, const std::string& factId, const std::string& kind, const Json::Value& fact);
    void linkEntities(pqxx::work& w, const std::string& channelId, const std::string& factId, const Json::Value& entities, const std::string& actor);

    Db& db_; KnowledgeService& knowledge_; Notifier& notifier_;
};

} // namespace acerciae
