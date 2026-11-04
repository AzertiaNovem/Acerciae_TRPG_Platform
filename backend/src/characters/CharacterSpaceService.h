#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <string>

namespace acerciae {
class Notifier;
class ServerSettingsService;
namespace logstudio { class MediaService; class CreativeService; }

// The character space page: avatar, main portrait, per-subtitle portraits, the COC7-styled role card, background
// and items. The Keeper and the character's actor edit; everyone at the table reads a PC's space, NPC spaces are
// Keeper-only. Images come either from uploads or from image generation driven by an appearance prompt and the
// campaign's era; a character is in one of the two modes at a time.
class CharacterSpaceService {
public:
    CharacterSpaceService(Db& db, logstudio::MediaService& media, logstudio::CreativeService& creative, ServerSettingsService& settings, Notifier& n) : db_(db), media_(media), creative_(creative), settings_(settings), notifier_(n) {}

    Json::Value space(const ChannelAccess& a, const std::string& characterId);
    // Point-buy mode is the channel's GM option; the report carries budgets, spending and rule violations for a card.
    bool pointsMode(const ChannelAccess& a);
    std::string ruleSystem(const ChannelAccess& a);   // the channel's rule system: which card and rules apply
    Json::Value pointsReport(const ChannelAccess& a, const Json::Value& card);
    Json::Value updateCard(const ChannelAccess& a, const std::string& characterId, const Json::Value& body);        // name, speaking_style, bio, role_card
    Json::Value updateAppearance(const ChannelAccess& a, const std::string& characterId, const Json::Value& body);  // asset_mode, appearance_prompt
    // slot: avatar | portrait | subtitle (with `subtitle` = IDLE, SAY, FIGHT, …). The file becomes an approved asset of the character.
    Json::Value uploadAsset(const ChannelAccess& a, const std::string& characterId, const std::string& slot, const std::string& subtitle, const std::string& fileName, const std::string& bytes);
    // Queues image jobs for the requested slots and subtitles (generated mode only).
    Json::Value generate(const ChannelAccess& a, const std::string& characterId, const Json::Value& body);
    Json::Value removeAsset(const ChannelAccess& a, const std::string& characterId, const std::string& assetId);
    // Brings an archived card of the channel's current rule system back as the active numbers (the numbers it replaces,
    // if any, are archived in turn); the archive entry is used up.
    Json::Value restoreArchive(const ChannelAccess& a, const std::string& characterId, const std::string& archiveId);
    // A library upload of a character's standee or portrait with a subtitle, by the Keeper or the character's actor,
    // becomes that character's image for the subtitle (the older one is deleted). Anyone else's stays a library image.
    void adoptLibraryUpload(const ChannelAccess& a, const Json::Value& asset);

    // The COC7 role card, bounded and typed; unknown keys are dropped.
    static Json::Value normalizeRoleCard(const Json::Value& card);
    // sheet.attrs after mirroring the card's characteristics, derived values and skills into it (dice read these).
    static Json::Value mirrorAttrs(const Json::Value& attrs, const Json::Value& card);
    static std::string normalizeSubtitle(const std::string& s);

    // Rule transitions. A card has a story part every rule system shares (basic information, background, items) and a
    // number part of one system: Call of Cthulhu's characteristics, derived values, skills, career, skill points and
    // wealth, or D&D's build (`dnd`). Switching the channel's system keeps the story and rebuilds the numbers.
    static Json::Value numbers(const Json::Value& card, const std::string& ruleSystem);     // the number part for a system
    static bool hasNumbers(const Json::Value& card, const std::string& ruleSystem);         // anything beyond a blank card
    static bool built(const Json::Value& card, const std::string& ruleSystem);              // rebuilt: the flag can go
    // The card's story with the given numbers (or, with forSystem, its own numbers of that system) and nothing of
    // another system's.
    static Json::Value withNumbers(const Json::Value& card, const Json::Value& numbers, const std::string& ruleSystem);
    static Json::Value forSystem(const Json::Value& card, const std::string& ruleSystem) { return withNumbers(card, numbers(card, ruleSystem), ruleSystem); }
    // Runs inside the transaction that changes channels.rule_system: every character keeps its story; its numbers and
    // dice values of `from` are archived read-only, it gets `to`'s blank numbers, and it is flagged for a rebuild when
    // there was anything to rebuild. Returns {from, to, archived, pending, rebuild[{id, name}] (PCs only), rows[]}.
    static Json::Value transitionCards(pqxx::work& w, const std::string& channelId, const std::string& from, const std::string& to, const std::string& actorId);
    // The prompt an image model receives for one slot: appearance + era + time of the story + the slot's framing.
    static std::string buildPrompt(const std::string& appearance, const std::string& era, const std::string& narrativeTime, const std::string& slot, const std::string& subtitle);
private:
    Json::Value characterFor(const ChannelAccess& a, const std::string& characterId, bool write);
    void attach(const std::string& channelId, const std::string& characterId, const std::string& slot, const std::string& subtitle, const std::string& assetId);
    Db& db_; logstudio::MediaService& media_; logstudio::CreativeService& creative_;
    ServerSettingsService& settings_; Notifier& notifier_;
};
}
