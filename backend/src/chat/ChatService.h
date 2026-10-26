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
    Json::Value joinServer(const Principal& p, const std::string& serverId);
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
    Json::Value getChannel(const ChannelAccess& a);
    Json::Value updateChannel(const ChannelAccess& a, const Json::Value& body);
    // `user` is a user id or a username. Players must already be server members unless the GM is a server maintainer.
    Json::Value addChannelMember(const ChannelAccess& a, const std::string& user, const std::string& role);
    Json::Value removeChannelMember(const ChannelAccess& a, const std::string& userId);
    Json::Value channelMembers(const ChannelAccess& a);
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
private:
    Json::Value findUser(const std::string& user);
    bool isServerMaintainer(const std::string& userId, const std::string& serverId);
    Db& db_; AuthService& auth_; EventStore& events_; SceneManager& scenes_; Notifier& notifier_; DocumentService& docs_; DiceService& dice_;
};
}
