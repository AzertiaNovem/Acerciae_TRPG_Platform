#pragma once
#include "../auth/AuthService.h"
#include "../core/Db.h"
#include <json/json.h>
#include <string>

namespace acerciae {
class Notifier;
namespace logstudio { class ObjectStore; }

// Deleting a whole server (its owner only) or one channel (any server maintainer). Each asks for a typed phrase in the
// body ({"confirm": "Delete Server"} / {"confirm": "Delete Channel"}). The rows go in one transaction (everything hangs
// off servers and channels with ON DELETE CASCADE); afterwards the stored media, audio and PDFs are removed, live
// sockets stop following the deleted channels and every server member is told (server.deleted / channel.deleted).
class DeletionService {
public:
    static constexpr const char* kServerPhrase = "Delete Server";
    static constexpr const char* kChannelPhrase = "Delete Channel";
    DeletionService(Db& db, logstudio::ObjectStore& store, Notifier& notifier) : db_(db), store_(store), notifier_(notifier) {}
    Json::Value deleteServer(const Principal& p, const std::string& serverId, const Json::Value& body);
    Json::Value deleteChannel(const Principal& p, const std::string& channelId, const Json::Value& body);

private:
    int removeObjects(const std::vector<std::string>& keys);
    Db& db_; logstudio::ObjectStore& store_; Notifier& notifier_;
};

} // namespace acerciae
