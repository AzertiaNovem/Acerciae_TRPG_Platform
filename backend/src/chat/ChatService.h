#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>

namespace acerciae {
class EventStore; class Notifier; class SceneManager; class DocumentService; class DiceService;

// A line an interactive message (kind hypertext) produces: said as the viewer who acted (effect 0) or replied as the
// card's sender (effect 1). Built only by HypertextService, never from a request body. The audience is the server's
// (the card's or a narrower one), and (card, user, interaction, effect) identifies the line, so a retry returns it.
// A new line is posted only while the card is not recalled and the action's claim (hypertext_interactions) is pending.
struct HypertextOrigin {
    std::string cardId, userId, interactionId; int effect = 0;   // userId: who acted (the clicker), also for replies
    std::string visibility; std::vector<std::string> whisperTo;   // window | gm_only | whisper
    bool fixedCharacter = false; std::string characterId;          // replies: the template's character, or none
    bool allowDice = true;                                         // false: the text is never a dice command
    std::string sayCharacterId;                                    // says: the viewer's active character (their own), "" = the window's
};

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
    void requireChannelAi(const ChannelAccess& a, const std::string& column);   // consistency_enabled | inspiration_enabled | illustrations_enabled
    // A system tip in a window (kind system, visible to the window, logged as a message.posted event); returns the message row.
    Json::Value postSystemMessage(pqxx::work& w, const std::string& channelId, const std::string& windowId, const std::string& authorId, const std::string& content);
    // The GM ends the story: every member can then read the whole story in the campaign log, GM-only lines
    // included when `reveal_keeper_lines` is set. Reopening returns to the GM's own visibility rules.
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
    Json::Value setCharacterPresence(const ChannelAccess& a, const std::string& characterId, const Json::Value& body);
    Json::Value listCharacters(const ChannelAccess& a);
    Json::Value createCharacter(const ChannelAccess& a, const Json::Value& body);
    Json::Value updateCharacter(const ChannelAccess& a, const std::string& characterId, const Json::Value& body);
    // windows
    Json::Value listWindows(const ChannelAccess& a);
    Json::Value createWindow(const ChannelAccess& a, const Json::Value& body);
    Json::Value forkWindow(const ChannelAccess& a, const std::string& parentId, const Json::Value& body);
    Json::Value updateWindow(const ChannelAccess& a, const std::string& windowId, const Json::Value& body);
    Json::Value addWindowMember(const ChannelAccess& a, const std::string& windowId, const std::string& userId, const std::string& characterId);
    Json::Value removeWindowMember(const ChannelAccess& a, const std::string& windowId, const std::string& userId);
    Json::Value windowMembers(const ChannelAccess& a, const std::string& windowId);
    Json::Value setWindowVisibility(const ChannelAccess& a, const std::string& windowId, const std::string& userId, const Json::Value& body);
    // Records that the viewer has read a window up to `seq` (never backwards); the window list's `unread` counts after it.
    Json::Value markRead(const ChannelAccess& a, const std::string& windowId, int64_t seq);
    // messages
    // The newest `limit` lines (before `beforeSeq` when given), or with `afterSeq` (0 or more) the first `limit` lines
    // after it: how a client that keeps the history catches up from the last line it has. Oldest first either way.
    Json::Value listMessages(const ChannelAccess& a, const std::string& windowId, int limit, int64_t beforeSeq, bool includeHistory = true, int64_t afterSeq = -1);
    // `mediaAssetId`: the picture the line shows (an illustration posted by the server; never from the request body).
    // `origin`: the line comes from an interactive message (see HypertextOrigin). A line already posted for the same
    // origin is returned as it is, marked `repeated: true`, without running its dice again or notifying anyone. Never
    // called inside another transaction. Without an origin, interactive messages themselves are refused (they have
    // their own route) and `via_*` keys of the body are never read.
    Json::Value postMessage(const ChannelAccess& a, const std::string& windowId, const Json::Value& body, const Json::Value& ruling = {}, const std::string& mediaAssetId = "", const HypertextOrigin* origin = nullptr);
    Json::Value getMessage(const ChannelAccess& a, const std::string& messageId);   // 404 once recalled
    Json::Value searchMessages(const ChannelAccess& a, const std::string& query, int limit);
    // Recall: the author takes back their own line (ic, ooc, narration or an interactive message; not dice rolls,
    // system lines or a PbtA move's record) within kRecallSeconds of sending it. The row becomes a tombstone: text,
    // dice, references and card document erased, `recalled_at` set, its events and campaign-log copies deleted (a card
    // also closes, losing its viewers' states and reply templates); everyone who could read it is told
    // (Notifier::messageRecalled) and what the AI made of it is forgotten (recall::forget). Returns
    // {message: tombstone, content: the original text, for the author to edit and send again ("" for a card)}.
    // Repeating it is a no-op.
    // Every message row carries `recall_seconds_left`: seconds until it can no longer be recalled, null when it cannot.
    static constexpr int kRecallSeconds = 120;
    Json::Value recallMessage(const ChannelAccess& a, const std::string& messageId);
    struct Policy { std::string join = "invite", channelCreation = "members"; bool guestInvites = false, spectators = false; };
    Policy policy(const std::string& serverId);
private:
    Json::Value findUser(const std::string& user);
    bool isServerMaintainer(const std::string& userId, const std::string& serverId);
    Db& db_; AuthService& auth_; EventStore& events_; SceneManager& scenes_; Notifier& notifier_; DocumentService& docs_; DiceService& dice_;
};
}
