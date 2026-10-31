#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include "LogAdapters.h"
#include "ObjectStore.h"
#include <json/json.h>

namespace acerciae {
class Notifier;
namespace logstudio {

// The campaign log: one canonical log per channel, synced from the channel's own events (never imported),
// covering the whole campaign across every chat window. Snapshots freeze it for PDFs and visual novels;
// exports are viewer-filtered and need no snapshot.
class LogStudioService {
public:
    LogStudioService(const Config& cfg, Db& db, Notifier& notifier) : cfg_(cfg), db_(db), notifier_(notifier) {}

    // projects
    Json::Value settings(const ChannelAccess& a);
    Json::Value saveSettings(const ChannelAccess& a,const Json::Value& body);
    Json::Value listProjects(const ChannelAccess& a);
    Json::Value createProject(const ChannelAccess& a, const Json::Value& body);
    Json::Value getProject(const ChannelAccess& a, const std::string& projectId);
    Json::Value updateProject(const ChannelAccess& a, const std::string& projectId, const Json::Value& body);   // title, description, character_map
    Json::Value deleteProject(const ChannelAccess& a, const std::string& projectId);
    // The channel's one campaign log: created on first use, synced from the channel record (every event, each
    // with its own visibility) and summarized for the viewer: {project, windows[], scenarios[], speakers[], …}.
    Json::Value campaignLog(const ChannelAccess& a);
    std::string campaignProjectId(const std::string& channelId);   // creates the project when missing
    // Pulls every new channel event into the campaign log under a system identity (viewer filtering happens on read).
    int syncCampaign(const std::string& channelId, const std::string& projectId);
    // Viewer-filtered export of the whole campaign log (or one chat window): json | txt | html | sealdice | zip.
    // `origin` (e.g. https://trpg.example.com) makes the links in the native export absolute.
    std::string exportLog(const ChannelAccess& a, const std::string& format, const std::string& chatWindowId, std::string& mime, std::string& fileName, const std::string& origin = "");
    // The native export (acerciae-log 2.0): readable on its own, without internal ids. {format, schemaVersion,
    // campaign, players[{username, display_name, role, avatar_url}], characters[{name, kind, player, role_card,
    // appearance_prompt, bio, speaking_style, avatar_url, portrait_url, poses{subtitle: url}}], windows[],
    // scenarios[], messages[{time, window, scenario, speaker, character, player, role, type, content, dice,
    // visibility}]}. Only what the viewer may read; NPC cards and appearance only for the Keeper.
    Json::Value nativeExport(const ChannelAccess& a, const std::vector<LogEvent>& events, const std::string& origin);
    void setObjectStore(ObjectStore* store) { store_ = store; }   // public links for media in the public bucket
    // SealDice-compatible log JSON ({version, items[]}) for one chat window.
    static Json::Value toSealDiceJson(const std::vector<LogEvent>& events);

    // canonical events
    Json::Value listEvents(const ChannelAccess& a, const std::string& projectId, int limit, long long afterSeq, const std::string& sceneKey);
    Json::Value updateEvent(const ChannelAccess& a, const std::string& projectId, const std::string& eventId, const Json::Value& body); // event_type/speaker mapping/scene_key only; never content
    Json::Value sceneSummary(const ChannelAccess& a, const std::string& projectId);
    // Pull from the channel's event log (scope-filtered) into canonical events. Returns import-like stats.
    Json::Value syncFromChannel(const ChannelAccess& a, const std::string& projectId, const Json::Value& selection);

    // snapshots
    Json::Value createSnapshot(const ChannelAccess& a, const std::string& projectId, const Json::Value& body);
    Json::Value listSnapshots(const ChannelAccess& a, const std::string& projectId);
    Json::Value getSnapshot(const ChannelAccess& a, const std::string& snapshotId, bool withEvents);
    // Viewer-filtered events of a snapshot (GM: all; player: by scope + audience).
    std::vector<LogEvent> snapshotEvents(const ChannelAccess& a, const std::string& snapshotId, Json::Value* snapshotOut = nullptr);

    // exports
    std::string exportSnapshot(const ChannelAccess& a, const std::string& snapshotId, const std::string& format, std::string& mime, std::string& fileName, const std::string& origin = "");
    std::string renderStyledHtml(const Json::Value& snapshot, const std::vector<LogEvent>& events, const Json::Value& style, const Json::Value& characterMap);

    // helpers used by other studio services
    Json::Value projectRow(const ChannelAccess& a, const std::string& projectId);
    // " AND <predicate>" limiting log_events rows (aliased `le`) to what the viewer may read; "" for the Keeper.
    std::string scopeSql(const ChannelAccess& a, const std::string& le);
    // Before the story ends players see "Scenario N" instead of scenario titles and locations.
    void maskScenes(const std::string& channelId, std::vector<LogEvent>& events);
    void maskScenes(const std::string& channelId, Json::Value& rows);
    void audit(const ChannelAccess& a, const std::string& action, const Json::Value& target);
private:
    std::vector<LogEvent> loadEvents(pqxx::work& w, const std::string& projectId, const std::vector<std::string>& ids);
    void insertEvents(pqxx::work& w, const std::string& projectId, const std::string& channelId, std::vector<LogEvent>& events, const std::string& importId);
    std::vector<LogEvent> campaignEvents(const ChannelAccess& a, const std::string& projectId, const std::string& chatWindowId);
    const Config& cfg_; Db& db_; Notifier& notifier_;
    ObjectStore* store_ = nullptr;
};

} } // namespace
