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
    // The GM's "bots' turn": every bot in the window (or those playing `character_ids`; none for an empty list) takes a
    // turn now, whatever its run. `pace: true` (a GM agent) also leaves the bots' turns after players' and GM lines to
    // the agent for ten minutes. {called: [{id, name}]}.
    Json::Value callTurn(const ChannelAccess& a, const std::string& windowId, const Json::Value& body);
    // What the GM tells every bot at this table (≤12000 bytes): {bot_brief}. GM only.
    Json::Value setBrief(const ChannelAccess& a, const Json::Value& body);
    // A bot's latest turns, for the server's maintainers.
    Json::Value activity(const Principal& p, const std::string& serverId, const std::string& botId);

    // What a bot remembers (bots/BotMemory), for the server's maintainers: {share_tables, memories[{id, kind, channel_id,
    // channel_name, user_id, name, text, highlight, source, updated_at}]}. Notes and notes on people show to every
    // maintainer; a table's account to maintainers who are members of that channel (to all of them while the bot shares
    // between tables); what was whispered there and the GM's briefing only to that channel's GMs.
    Json::Value memories(const Principal& p, const std::string& serverId, const std::string& botId);
    // A note for the bot to keep in mind everywhere: {text} (≤4000 bytes; at most 50).
    Json::Value addNote(const Principal& p, const std::string& serverId, const std::string& botId, const Json::Value& body);
    // Corrects one memory the caller may see: {text, highlight?}; it is marked as edited.
    Json::Value editMemory(const Principal& p, const std::string& serverId, const std::string& botId, const std::string& memoryId, const Json::Value& body);
    Json::Value deleteMemory(const Principal& p, const std::string& serverId, const std::string& botId, const std::string& memoryId);
    // The GM's view of what the bot remembers of this table: {table, table_private, briefing} (null when none).
    Json::Value tableMemory(const ChannelAccess& a, const std::string& botId);
    // What only this bot is told at this table: {text} (≤8000 bytes; empty removes it). GM.
    Json::Value setBriefing(const ChannelAccess& a, const std::string& botId, const Json::Value& body);
    // Forget this table: the account and its private part go, and what the bot saw here so far is let go. GM.
    Json::Value forgetTable(const ChannelAccess& a, const std::string& botId);

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
