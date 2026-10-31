#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <map>

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
    // The dubbing cast: {character_id | "narrator": voice_profile_id}. Sets the voice of every line by its speaker
    // (narration, dice and system lines take the narrator) and remembers the table in settings.cast.
    Json::Value applyCast(const ChannelAccess& a, const std::string& presentationId, const Json::Value& cast);
    // Visual-novel look template (settings.template): a base preset plus bounded overrides.
    // Keys that are absent fall back to the preset's defaults in the player. Unknown keys are dropped;
    // out-of-range or malformed values are rejected so nothing free-form reaches the player's CSS.
    static Json::Value validateVnTemplate(const Json::Value& tpl);
    // Validates settings.template in place when present.
    static Json::Value sanitizeSettings(const Json::Value& settings);
    // Lays a validated visual-novel script (VnScriptService::normalize) over a freshly built presentation:
    // regroups and reorders events into the script's scenes, applies staging, hiding and delivery.
    // Canonical text is untouched; every asset is re-checked against the presentation's scope.
    void applyScript(const ChannelAccess& a, const std::string& presentationId, const Json::Value& script);
    // The image each character shows now: per subtitle (lower-cased) its newest approved standee, whether the
    // character space set it or it was uploaded in the asset library; under "" its main portrait (the default).
    // Values: {id, version, expression}. Keeper-only images only when gmOnly.
    std::map<std::string, std::map<std::string, Json::Value>> currentStandees(const std::string& channelId, bool gmOnly);
    // Points every placement of the presentation at its character's current image for that subtitle (or the default);
    // returns how many placements changed.
    Json::Value refreshStandees(const ChannelAccess& a, const std::string& presentationId);
    // Bumps the version and tells viewers what changed (also used when generated art lands in a draft).
    void touch(const std::string& presentationId, const std::string& channelId, const std::string& what);
private:
    bool canEdit(const ChannelAccess& a, const Json::Value& pres);
    const Config& cfg_; Db& db_; Notifier& notifier_; LogStudioService& studio_;
public:
    static void limitVisuals(Json::Value& presentation);   // what a shared presentation may show of the cast
};

} // namespace
