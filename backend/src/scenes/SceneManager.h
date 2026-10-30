#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <functional>

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
    // Scenarios are campaign-wide: every chat window is in the channel's current scenario. Entering a scenario
    // moves all windows there, closes the previous one (it can then only be consulted) and records a
    // scene.entered event per window. A closed scenario cannot be entered again. GM.
    // Returns {scene, previous, windows}.
    Json::Value enterScene(const ChannelAccess& a, const std::string& sceneId);
    // The scenario a new message belongs to: the channel's current one; a fresh "Scenario N" is opened when
    // none exists or the current one was closed. Keeps the window's active_scene_id in step.
    std::string resolveSceneForWindow(pqxx::work& w, const std::string& channelId, const std::string& chatWindowId);
    // Moves every window of the channel into `sceneId` inside a transaction; returns the previous scene id.
    std::string moveChannel(pqxx::work& w, const std::string& channelId, const std::string& sceneId, const std::string& actorUserId, const std::string& note);
    // Runs after a scenario closed and the change committed (investigator development, …); never inside a transaction.
    void setClosedHook(std::function<void(const std::string& channelId, const std::string& sceneId, const std::string& actorUserId)> h) { closedHook_ = std::move(h); }
    void notifyClosed(const std::string& channelId, const std::string& sceneId, const std::string& actorUserId) { if (closedHook_ && !sceneId.empty()) closedHook_(channelId, sceneId, actorUserId); }
    // Raw log of a scene (viewer-filtered), oldest first.
    Json::Value sceneLog(const ChannelAccess& a, const std::string& sceneId, int limit, int64_t afterSeq);
private:
    Db& db_; EventStore& events_; Notifier& notifier_;
    std::function<void(const std::string&, const std::string&, const std::string&)> closedHook_;
};
}
