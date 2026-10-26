#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>

namespace acerciae {
class EventStore; class Notifier;

// Scenes group events narratively. A window has an active scene; a channel has a current scene.
class SceneManager {
public:
    SceneManager(Db& db, EventStore& events, Notifier& notifier) : db_(db), events_(events), notifier_(notifier) {}
    Json::Value list(const ChannelAccess& a);
    Json::Value get(const ChannelAccess& a, const std::string& sceneId);
    Json::Value create(const ChannelAccess& a, const Json::Value& body);                 // GM
    Json::Value update(const ChannelAccess& a, const std::string& sceneId, const Json::Value& body);  // GM
    Json::Value close(const ChannelAccess& a, const std::string& sceneId);               // GM
    // Moves a chat window into a scene (and makes it the channel's current scene). GM.
    Json::Value enterScene(const ChannelAccess& a, const std::string& chatWindowId, const std::string& sceneId);
    // Returns the scene id a new message in this window belongs to (creating a default scene if none exists).
    std::string resolveSceneForWindow(pqxx::work& w, const std::string& channelId, const std::string& chatWindowId);
    // Raw log of a scene (viewer-filtered), oldest first.
    Json::Value sceneLog(const ChannelAccess& a, const std::string& sceneId, int limit, int64_t afterSeq);
private:
    Db& db_; EventStore& events_; Notifier& notifier_;
};
}
