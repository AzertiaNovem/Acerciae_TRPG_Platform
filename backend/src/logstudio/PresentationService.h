#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>

namespace acerciae { class Notifier; }
namespace acerciae::logstudio {
class LogStudioService;

// Presentation Timeline: how a snapshot is performed. Never touches canonical content.
class PresentationService {
public:
    PresentationService(const Config& cfg, Db& db, Notifier& n, LogStudioService& studio) : cfg_(cfg), db_(db), notifier_(n), studio_(studio) {}
    Json::Value list(const ChannelAccess& a, const std::string& projectId);
    // Builds a presentation from a snapshot: one presentation scene per canonical scene, one event per visible line.
    Json::Value create(const ChannelAccess& a, const std::string& snapshotId, const Json::Value& body);
    Json::Value get(const ChannelAccess& a, const std::string& presentationId);        // scenes + events + canonical text (viewer-filtered)
    Json::Value update(const ChannelAccess& a, const std::string& presentationId, const Json::Value& body);   // title, settings, style_profile_id
    Json::Value remove(const ChannelAccess& a, const std::string& presentationId);
    Json::Value updateScene(const ChannelAccess& a, const std::string& sceneId, const Json::Value& body);
    Json::Value updateEvent(const ChannelAccess& a, const std::string& eventId, const Json::Value& body);
    Json::Value bulkUpdateEvents(const ChannelAccess& a, const std::string& presentationId, const Json::Value& body);  // {event_ids, patch}
    Json::Value splitEvent(const ChannelAccess& a, const std::string& eventId, const Json::Value& body);       // {offsets:[int]} → segments (verbatim substrings)
    Json::Value mergeEvents(const ChannelAccess& a, const std::string& presentationId, const Json::Value& body);   // {event_ids} consecutive → one display unit
    Json::Value reorder(const ChannelAccess& a, const std::string& presentationId, const Json::Value& body);       // {event_ids in order}
    Json::Value acceptSuggestion(const ChannelAccess& a, const std::string& eventId, bool accept);
    // Player progress (per user)
    Json::Value saveProgress(const ChannelAccess& a, const std::string& presentationId, const Json::Value& body);
    Json::Value getProgress(const ChannelAccess& a, const std::string& presentationId);
    Json::Value presentationRow(const ChannelAccess& a, const std::string& presentationId);
private:
    bool canEdit(const ChannelAccess& a, const Json::Value& pres);
    void touch(const std::string& presentationId, const std::string& channelId, const std::string& what);
    const Config& cfg_; Db& db_; Notifier& notifier_; LogStudioService& studio_;
};

} // namespace
