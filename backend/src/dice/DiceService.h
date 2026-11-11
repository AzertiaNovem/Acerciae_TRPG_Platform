#pragma once
#include "Dice.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <memory>
#include <optional>

namespace acerciae {
class ServerSettingsService; class Notifier;

// Integrated dice: Sealdice-compatible commands typed into chat (.r .ra .rc .rh .rah .sc .st .en), evaluated
// against the speaking character's attributes (characters.sheet.attrs) and phrased with the channel's dice
// text group. ChatService calls recognise() before posting and execute() inside the message transaction.
class DiceService {
public:
    DiceService(Db& db, AuthService& auth, ServerSettingsService& settings, Notifier& notifier);

    // The parsed command when `content` is a dice command and the server has dice enabled.
    std::optional<dice::Command> recognise(const ChannelAccess& a, const std::string& content);

    struct Result {
        std::string text;         // rendered reply, also what the chronicler sees
        Json::Value dice;         // stored on the message: {command, text, type, ...}
        bool hidden = false;
        std::string hiddenNotice; // public "rolled in secret" line for hidden rolls
        bool narrative = true;    // false for sheet maintenance (.st/.en), which is not a story event
        std::string initiativeWindow;   // set when the window's initiative order changed (notify after commit)
    };
    // Runs inside the caller's transaction; attribute changes commit together with the message.
    Result execute(pqxx::work& w, const ChannelAccess& a, const std::string& windowId, const std::string& characterId, const dice::Command& cmd);
    // Who the dice speak as in this channel, kept on every roll as dice.bot: {name, group_id?, avatar_version}. The
    // channel's text group names it and may give it an avatar; otherwise "Dice" / "骰子" in the server language.
    Json::Value persona(pqxx::work& w, const std::string& channelId);
    // The channel's rule system (channels.rule_system): which commands apply and how attribute names read.
    std::string ruleSystem(const std::string& channelId);
    // Initiative (D&D): a window's order, highest first, with the current turn and round. Members of the window read it;
    // the GM moves the turn (next), removes an entry or clears the order. `.ri` adds to it, `.init` reads it in chat.
    Json::Value initiative(const ChannelAccess& a, const std::string& windowId);
    Json::Value initiativeAction(const ChannelAccess& a, const std::string& windowId, const Json::Value& body);
    void afterCommit(const ChannelAccess& a, const std::string& characterId, const Result& r);

    // Gray hint for the composer: {hint: string|null, command: ".ra"|null}. Never rolls.
    Json::Value preview(const ChannelAccess& a, const std::string& windowId, const std::string& characterId, const std::string& content);

    Json::Value getAttributes(const ChannelAccess& a, const std::string& characterId);
    // body: {set: {name: value}, remove: [names]} — names are canonicalised (侦查 -> Spot Hidden).
    Json::Value updateAttributes(const ChannelAccess& a, const std::string& characterId, const Json::Value& body);

    // The channel's reply texts; `language` receives the server language (skill names are accepted and shown in it).
    dice::TextSet textsForChannel(const std::string& channelId, std::string* language = nullptr);

    dice::TextSet textsForChannel(pqxx::work& w, const std::string& channelId, std::string* language = nullptr);
    void setRng(std::unique_ptr<dice::Rng> rng) { rng_ = std::move(rng); }   // tests
    dice::Rng& rng() { return *rng_; }                                        // shared with the growth check
private:
    Result run(pqxx::work& w, const ChannelAccess& a, const std::string& windowId, const std::string& characterId, const dice::Command& cmd);
    Json::Value characterFor(const ChannelAccess& a, const std::string& characterId, bool forWrite);
    std::string displayName(const std::string& userId);
    Db& db_; AuthService& auth_; ServerSettingsService& settings_; Notifier& notifier_;
    std::unique_ptr<dice::Rng> rng_;
};

} // namespace acerciae
