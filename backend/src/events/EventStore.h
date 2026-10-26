#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <string>
#include <vector>
#include <cstdint>

namespace acerciae {

// Raw events are the single source of truth. Documents are projections of them.
struct NewEvent {
    std::string channelId;
    std::string chatWindowId;      // may be empty
    std::string sceneId;           // may be empty
    std::string messageId;         // may be empty
    std::string actorUserId;       // may be empty
    std::string actorRole = "system";
    std::string characterId;       // may be empty
    std::string kind;
    Json::Value payload = Json::Value(Json::objectValue);
    std::string visibility = "window";
    std::vector<std::string> audience;   // character ids who witnessed the event
};

class EventStore {
public:
    explicit EventStore(Db& db) : db_(db) {}
    Json::Value append(pqxx::work& w, const NewEvent& e);     // returns the inserted event row
    Json::Value append(const NewEvent& e);
    Json::Value get(const std::string& channelId, const std::string& eventId);
    // Events after `afterSeq` for a channel, oldest first (used by the observer; no viewer filter — the
    // observer runs with system scope and decides knowledge scope per event audience).
    Json::Value listAfter(const std::string& channelId, int64_t afterSeq, int limit);
    // Viewer-filtered search (keyword + FTS).
    Json::Value search(const ChannelAccess& a, const std::string& query, const std::string& sceneId, int limit);
    Json::Value listByIds(const ChannelAccess& a, const std::vector<std::string>& ids);
    int64_t maxSeq(const std::string& channelId);
private:
    Db& db_;
};

} // namespace acerciae
