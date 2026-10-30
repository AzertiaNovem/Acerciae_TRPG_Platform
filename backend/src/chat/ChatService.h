#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>

namespace acerciae {
class EventStore; class Notifier; class SceneManager; class DocumentService; class DiceService;

// Servers, channels, chat windows, characters and messages. Posting a message persists the message
// and appends a `message.posted` event with the audience that witnessed it.
class ChatService {
public:
    ChatService(Db& db, AuthService& auth, EventStore& events, SceneManager& scenes, Notifier& notifier, DocumentService& docs, DiceService& dice)
        : db_(db), auth_(auth), events_(events), scenes_(scenes), notifier_(notifier), docs_(docs), dice_(dice) {}

    // servers
    Json::Value listServers(const Principal& p);
    Json::Value createServer(const Principal& p, const std::string& name);
    // Joining follows the server's join policy: open servers take anyone, invite servers need a valid invite code,
    // closed servers only take members a maintainer adds. A guest who joins becomes a full member.
    Json::Value joinServer(const Principal& p, const std::string& serverId, const std::string& inviteCode = "");
    Json::Value discoverServers(const Principal& p, const std::string& query);   // open servers the user is not in
    // Invite codes (maintainers). An invite may expire and may be limited to a number of uses.
    Json::Value listInvites(const Principal& p, const std::string& serverId);
    Json::Value createInvite(const Principal& p, const std::string& serverId, const Json::Value& body);
    Json::Value revokeInvite(const Principal& p, const std::string& serverId, const std::string& inviteId);
    Json::Value previewInvite(const Principal& p, const std::string& code);
    Json::Value acceptInvite(const Principal& p, const std::string& code);
    // `user` is a user id or a username. Only the owner can grant or change the admin (maintainer) role.
    Json::Value addServerMember(const Principal& p, const std::string& serverId, const std::string& user, const std::string& role);
    Json::Value setServerMemberRole(const Principal& p, const std::string& serverId, const std::string& userId, const std::string& role);
    // Removes the user from the server and from every channel and chat window in it.
    Json::Value removeServerMember(const Principal& p, const std::string& serverId, const std::string& userId);
    Json::Value serverMembers(const Principal& p, const std::string& serverId);
    Json::Value searchUsers(const Principal& p, const std::string& query, int limit);
    // channels
    Json::Value listChannels(const Principal& p, const std::string& serverId);
    Json::Value createChannel(const Principal& p, const std::string& serverId, const Json::Value& body);
    // Maintainers: every channel of the server, member or not ({id, name, description, created_at, member_count, message_count}).
    Json::Value allChannels(const Principal& p, const std::string& serverId);
    Json::Value getChannel(const ChannelAccess& a);
    Json::Value updateChannel(const ChannelAccess& a, const Json::Value& body);
    void requireChannelAi(const ChannelAccess& a, const std::string& column);   // consistency_enabled | inspiration_enabled
    // The Keeper ends the story: every member can then read the whole story in the campaign log, Keeper-only lines
    // included when `reveal_keeper_lines` is set. Reopening returns to the Keeper's own visibility rules.
    Json::Value endStory(const ChannelAccess& a, const Json::Value& body);
    Json::Value reopenStory(const ChannelAccess& a);
    // `user` is a user id or a username. Someone outside the server is added as a member when a maintainer invites
    // them, as a guest (who sees only the channels they are invited to) when the server allows guest invites, and is
    // refused otherwise.
    Json::Value addChannelMember(const ChannelAccess& a, const std::string& user, const std::string& role);
    Json::Value removeChannelMember(const ChannelAccess& a, const std::string& userId);
    Json::Value channelMembers(const ChannelAccess& a);
    // Main Chat spectating: when the server allows it, members (not guests) may read the Main Chat of channels they
    // were not invited to: only lines visible to the whole window, nothing else of the channel.
    bool canSpectate(const std::string& userId, const std::string& channelId);
    Json::Value spectatableChannels(const Principal& p, const std::string& serverId);
    Json::Value spectate(const Principal& p, const std::string& channelId, int limit, int64_t beforeSeq);
    static Json::Value spectatorMessage(Json::Value m);   // what a spectator may see of a public Main Chat line
    // characters
    Json::Value listCharacters(const ChannelAccess& a);
    Json::Value createCharacter(const ChannelAccess& a, const Json::Value& body);
    Json::Value updateCharacter(const ChannelAccess& a, const std::string& characterId, const Json::Value& body);
    // windows
    Json::Value listWindows(const ChannelAccess& a);
    Json::Value createWindow(const ChannelAccess& a, const Json::Value& body);
    Json::Value addWindowMember(const ChannelAccess& a, const std::string& windowId, const std::string& userId, const std::string& characterId);
    Json::Value removeWindowMember(const ChannelAccess& a, const std::string& windowId, const std::string& userId);
    Json::Value windowMembers(const ChannelAccess& a, const std::string& windowId);
    // messages
    Json::Value listMessages(const ChannelAccess& a, const std::string& windowId, int limit, int64_t beforeSeq);
    Json::Value postMessage(const ChannelAccess& a, const std::string& windowId, const Json::Value& body);
    Json::Value getMessage(const ChannelAccess& a, const std::string& messageId);
    Json::Value searchMessages(const ChannelAccess& a, const std::string& query, int limit);
    struct Policy { std::string join = "invite", channelCreation = "members"; bool guestInvites = false, spectators = false; };
    Policy policy(const std::string& serverId);
private:
    Json::Value findUser(const std::string& user);
    bool isServerMaintainer(const std::string& userId, const std::string& serverId);
    Db& db_; AuthService& auth_; EventStore& events_; SceneManager& scenes_; Notifier& notifier_; DocumentService& docs_; DiceService& dice_;
};
}
