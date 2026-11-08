#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include "LogModel.h"
#include <json/json.h>
#include <map>

namespace acerciae { class Notifier; }
namespace acerciae::logstudio {
class LogStudioService;
class MediaService;

// Presentation Timeline: how a snapshot is performed. Never touches canonical content.
class PresentationService {
public:
    PresentationService(const Config& cfg, Db& db, Notifier& n, LogStudioService& studio) : cfg_(cfg), db_(db), notifier_(n), studio_(studio) {}
    Json::Value list(const ChannelAccess& a, const std::string& projectId);
    // Builds a presentation from a snapshot: one presentation scene per canonical scene, one event per visible line.
    Json::Value create(const ChannelAccess& a, const std::string& snapshotId, const Json::Value& body);
    Json::Value get(const ChannelAccess& a, const std::string& presentationId);        // scenes + events + canonical text (viewer-filtered)
    Json::Value hybrid(const ChannelAccess& a, const std::string& presentationId, MediaService& media);
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
    // Continues a presentation with a script of new lines (VnScriptService::fitContinuation): rebinds it to the
    // newer snapshot that holds them, appends their events and scenes after the existing ones (the first scene may
    // join the last), and re-applies the stored dubbing cast. Existing scenes and events are not touched. Backgrounds
    // the presentation already shows may be reused even when they are GM-only or still waiting for approval.
    void appendScript(const ChannelAccess& a, const std::string& presentationId, const std::string& snapshotId, const Json::Value& script);
    bool canEditPresentation(const ChannelAccess& a, const Json::Value& pres) { return canEdit(a, pres); }
    // The image each character shows now: per subtitle (lower-cased) the image its character space holds for it,
    // else the newest approved library standee filed under it; under "" its main portrait (the default).
    // Values: {id, version, expression}. GM-only images only when gmOnly.
    std::map<std::string, std::map<std::string, Json::Value>> currentStandees(const std::string& channelId, bool gmOnly);
    // A stage placement names a character and a subtitle, never an image. These fill in the image each placement
    // shows now (asset_id/asset_version, the default when the subtitle has none) for reading.
    static void resolveStage(Json::Value& events, const std::map<std::string, std::map<std::string, Json::Value>>& images,
                             const std::map<std::string, std::map<std::string, Json::Value>>* outfitImages = nullptr);
    // Outfits' images, by outfit id: per subtitle (lower-cased) and under "" its portrait. A placement with an
    // `outfit_id` shows its outfit's image for the subtitle, else the outfit's portrait; an outfit without any image
    // falls back to the base look. Same values and visibility rule as currentStandees.
    std::map<std::string, std::map<std::string, Json::Value>> outfitStandees(const std::string& channelId, bool gmOnly);
    // Which outfit each placement shows when no editor chose one: the outfit its character wore in their own nearest
    // line (the latest at or before the event, else their next one), as the chat recorded it. Marked `outfit_auto`.
    void wearOutfits(Json::Value& events, const std::map<std::string, LogEvent>& lines);
    // What may be stored for one placement: character, subtitle, outfit (an editor's choice; "" = the base look; an
    // automatic one is not stored), position and display flags.
    static Json::Value placement(const Json::Value& in);
    // Bumps the version and tells viewers what changed (also used when generated art lands in a draft).
    void touch(const std::string& presentationId, const std::string& channelId, const std::string& what);
private:
    bool canEdit(const ChannelAccess& a, const Json::Value& pres);
    const Config& cfg_; Db& db_; Notifier& notifier_; LogStudioService& studio_;
public:
    static void limitVisuals(Json::Value& presentation);   // what a shared presentation may show of the cast
};

} // namespace
