#pragma once
#include "../core/Db.h"
#include <json/json.h>
#include <string>
#include <vector>

namespace acerciae {

// Translates domain changes into WebSocket pushes with the right audience. Kept apart from the
// services so that they do not depend on the transport.
class Notifier {
public:
    explicit Notifier(Db& db) : db_(db) {}
    // chat stream
    void messagePosted(const Json::Value& message);                      // audience from message visibility
    void windowChanged(const std::string& channelId, const Json::Value& window);
    void sceneChanged(const std::string& channelId, const Json::Value& scene);
    void characterUpdated(const std::string& channelId, const Json::Value& character);  // NPC changes reach GMs only
    void serverSettingsChanged(const std::string& serverId, const Json::Value& publicSettings);  // every channel of the server
    // context stream
    void documentUpdated(const std::string& channelId, const Json::Value& payload);   // {document_id, doc_type, version, change_count, summary, gm_only}
    void highlightCreated(const std::string& channelId, const Json::Value& highlight);
    void highlightExpired(const std::string& channelId, const std::vector<std::string>& ids);
    void proposalPending(const std::string& channelId, const Json::Value& proposal);  // GM only
    void moduleUpdated(const std::string& channelId, const Json::Value& payload);     // GM only
    void aiJobFinished(const std::string& channelId, const Json::Value& job);         // GM only

    std::vector<std::string> gmUsers(const std::string& channelId);
    std::vector<std::string> windowUsers(const std::string& chatWindowId);
    std::vector<std::string> usersOfCharacters(const std::vector<std::string>& characterIds);
private:
    Db& db_;
};

} // namespace acerciae
