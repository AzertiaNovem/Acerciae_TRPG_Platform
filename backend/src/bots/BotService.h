#pragma once
#include "../core/Db.h"
#include <json/json.h>
#include <string>

namespace acerciae {
struct Principal; struct ChannelAccess;
class AuthService; class ChatService; class ServerSettingsService; class Notifier; class DiceService;

// Bots: AI members of a server, set up by its maintainers (owner and admins). Each bot is a user of its own
// (users.is_bot), a member of its server, and a player of the channels it is invited to; it never signs in. Any member
// of a channel may invite one of the server's bots there while the server's bots feature and the channel's switch are
// on; the GM removes them.
class BotService {
public:
    BotService(Db& db, AuthService& auth, ChatService& chat, ServerSettingsService& settings, DiceService& dice, Notifier& notifier)
        : db_(db), auth_(auth), chat_(chat), settings_(settings), dice_(dice), notifier_(notifier) {}

    // The server's bots. Maintainers see every setting and the channels each bot is in; other members see names only.
    Json::Value list(const Principal& p, const std::string& serverId);
    Json::Value create(const Principal& p, const std::string& serverId, const Json::Value& body);
    Json::Value update(const Principal& p, const std::string& serverId, const std::string& botId, const Json::Value& body);
    // Retires a bot: it leaves every channel; its user row stays for the lines it wrote.
    Json::Value remove(const Principal& p, const std::string& serverId, const std::string& botId);

    // A channel's bots for its members: {feature, invites_enabled, can_invite, can_remove, limit, present[], invitable[]}.
    Json::Value channelView(const ChannelAccess& a);
    Json::Value invite(const ChannelAccess& a, const std::string& botId);
    Json::Value removeFromChannel(const ChannelAccess& a, const std::string& botId);
    // The GM's "bots' turn": every bot in the window (or those playing `character_ids`) takes a turn now, whatever its
    // run. `pace: true` (a GM agent) also leaves players' lines to the agent for ten minutes. {called: [{id, name}]}.
    Json::Value callTurn(const ChannelAccess& a, const std::string& windowId, const Json::Value& body);
    // What the GM tells every bot at this table (≤12000 bytes): {bot_brief}. GM only.
    Json::Value setBrief(const ChannelAccess& a, const Json::Value& body);
    // A bot's latest turns, for the server's maintainers.
    Json::Value activity(const Principal& p, const std::string& serverId, const std::string& botId);

    static constexpr int kInvitesPerHour = 10;   // a member's invitations, all channels together

private:
    Json::Value botRow(const std::string& serverId, const std::string& botId);   // 404 when not this server's live bot
    Json::Value view(const Json::Value& row, bool full);
    void requireMaintainer(const Principal& p, const std::string& serverId);
    Db& db_;
    AuthService& auth_;
    ChatService& chat_;
    ServerSettingsService& settings_;
    DiceService& dice_;   // the channel's texts for its system lines
    Notifier& notifier_;
};

} // namespace acerciae
