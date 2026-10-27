#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <string>

namespace acerciae {
class Notifier;
namespace logstudio { class MediaService; class CreativeService; }

// The character space page: avatar, main portrait, per-subtitle portraits, the COC7-styled role card, background
// and items. The Keeper and the character's actor edit; everyone at the table reads a PC's space, NPC spaces are
// Keeper-only. Images come either from uploads or from image generation driven by an appearance prompt and the
// campaign's era; a character is in one of the two modes at a time.
class CharacterSpaceService {
public:
    CharacterSpaceService(Db& db, logstudio::MediaService& media, logstudio::CreativeService& creative, Notifier& n) : db_(db), media_(media), creative_(creative), notifier_(n) {}

    Json::Value space(const ChannelAccess& a, const std::string& characterId);
    Json::Value updateCard(const ChannelAccess& a, const std::string& characterId, const Json::Value& body);        // name, speaking_style, bio, role_card
    Json::Value updateAppearance(const ChannelAccess& a, const std::string& characterId, const Json::Value& body);  // asset_mode, appearance_prompt
    // slot: avatar | portrait | subtitle (with `subtitle` = IDLE, SAY, FIGHT, …). The file becomes an approved asset of the character.
    Json::Value uploadAsset(const ChannelAccess& a, const std::string& characterId, const std::string& slot, const std::string& subtitle, const std::string& fileName, const std::string& bytes);
    // Queues image jobs for the requested slots and subtitles (generated mode only).
    Json::Value generate(const ChannelAccess& a, const std::string& characterId, const Json::Value& body);
    Json::Value removeAsset(const ChannelAccess& a, const std::string& characterId, const std::string& assetId);

    // The COC7 role card, bounded and typed; unknown keys are dropped.
    static Json::Value normalizeRoleCard(const Json::Value& card);
    // sheet.attrs after mirroring the card's characteristics, derived values and skills into it (dice read these).
    static Json::Value mirrorAttrs(const Json::Value& attrs, const Json::Value& card);
    static std::string normalizeSubtitle(const std::string& s);
    // The prompt an image model receives for one slot: appearance + era + time of the story + the slot's framing.
    static std::string buildPrompt(const std::string& appearance, const std::string& era, const std::string& narrativeTime, const std::string& slot, const std::string& subtitle);
private:
    Json::Value characterFor(const ChannelAccess& a, const std::string& characterId, bool write);
    void attach(const std::string& channelId, const std::string& characterId, const std::string& slot, const std::string& subtitle, const std::string& assetId);
    Db& db_; logstudio::MediaService& media_; logstudio::CreativeService& creative_; Notifier& notifier_;
};
}
