#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include "LogAdapters.h"
#include <json/json.h>

namespace acerciae {
class Notifier;
namespace logstudio {

// Phase 1: projects, canonical events (from channel events or imports), immutable snapshots, exports.
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

    // canonical events
    Json::Value listEvents(const ChannelAccess& a, const std::string& projectId, int limit, long long afterSeq, const std::string& sceneKey);
    Json::Value updateEvent(const ChannelAccess& a, const std::string& projectId, const std::string& eventId, const Json::Value& body); // event_type/speaker mapping/scene_key only; never content
    Json::Value sceneSummary(const ChannelAccess& a, const std::string& projectId);
    Json::Value splitScene(const ChannelAccess& a, const std::string& projectId, long long fromSeq, const std::string& title);   // new scene starts at fromSeq
    Json::Value mergeScene(const ChannelAccess& a, const std::string& projectId, const std::string& sceneKey, const std::string& intoKey);
    Json::Value renameScene(const ChannelAccess& a, const std::string& projectId, const std::string& sceneKey, const std::string& title);
    Json::Value suggestScenes(const ChannelAccess& a, const std::string& projectId);   // from AI scene memory / gaps; suggestions only
    // Pull from the channel's event log (scope-filtered) into canonical events. Returns import-like stats.
    Json::Value syncFromChannel(const ChannelAccess& a, const std::string& projectId, const Json::Value& selection);

    // imports
    Json::Value previewImport(const ChannelAccess& a, const std::string& projectId, const std::string& fileName, const std::string& bytes, const std::string& adapterName);
    Json::Value commitImport(const ChannelAccess& a, const std::string& projectId, const std::string& importId, const Json::Value& speakerMap);
    Json::Value listImports(const ChannelAccess& a, const std::string& projectId);
    Json::Value importErrors(const ChannelAccess& a, const std::string& importId);
    Json::Value adapters() const;

    // snapshots
    Json::Value createSnapshot(const ChannelAccess& a, const std::string& projectId, const Json::Value& body);
    Json::Value listSnapshots(const ChannelAccess& a, const std::string& projectId);
    Json::Value getSnapshot(const ChannelAccess& a, const std::string& snapshotId, bool withEvents);
    // Viewer-filtered events of a snapshot (GM: all; player: by scope + audience).
    std::vector<LogEvent> snapshotEvents(const ChannelAccess& a, const std::string& snapshotId, Json::Value* snapshotOut = nullptr);

    // exports
    std::string exportSnapshot(const ChannelAccess& a, const std::string& snapshotId, const std::string& format, std::string& mime, std::string& fileName);
    std::string renderStyledHtml(const Json::Value& snapshot, const std::vector<LogEvent>& events, const Json::Value& style, const Json::Value& characterMap);

    // helpers used by other studio services
    Json::Value projectRow(const ChannelAccess& a, const std::string& projectId);
    static bool eventVisibleTo(const ChannelAccess& a, const std::string& visibility, const std::vector<std::string>& audience);
    void audit(const ChannelAccess& a, const std::string& action, const Json::Value& target);
private:
    std::vector<LogEvent> loadEvents(pqxx::work& w, const std::string& projectId, const std::vector<std::string>& ids);
    void insertEvents(pqxx::work& w, const std::string& projectId, const std::string& channelId, std::vector<LogEvent>& events, const std::string& importId);
    const Config& cfg_; Db& db_; Notifier& notifier_;
    AdapterRegistry registry_;
};

} } // namespace
