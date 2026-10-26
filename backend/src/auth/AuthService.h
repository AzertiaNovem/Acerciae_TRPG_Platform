#pragma once
#include "../core/Db.h"
#include "../core/Config.h"
#include <json/json.h>
#include <string>
#include <vector>
#include <optional>

namespace acerciae {

struct Principal {
    std::string userId;
    std::string username;
    std::string displayName;
};

// Everything the permission model needs to know about a user inside one channel.
struct ChannelAccess {
    std::string channelId;
    std::string serverId;
    std::string userId;
    bool isGm = false;
    std::string knowledgeMode = "isolated";          // 'public' | 'isolated'
    std::vector<std::string> characterIds;            // characters this user controls in the channel
    std::string playerGroupId;                       // empty = KP, or an unassigned player (fail closed)
    int playerGroupVersion = 0;
    std::string primaryCharacterId;                   // first PC, used as default viewpoint
};

class AuthService {
public:
    AuthService(Db& db, const Config& cfg) : db_(db), cfg_(cfg) {}

    Json::Value registerUser(const std::string& username, const std::string& password, const std::string& displayName);
    Json::Value login(const std::string& username, const std::string& password);   // {token, user}
    Json::Value profile(const std::string& userId);
    Json::Value updateProfile(const Principal& principal, const Json::Value& body);
    std::pair<std::string, std::string> avatar(const Principal& principal, const std::string& userId);
    void logout(const std::string& token);
    std::optional<Principal> authenticate(const std::string& token);

    // Authorisation helpers (throw ApiError 403/404)
    ChannelAccess channelAccess(const std::string& userId, const std::string& channelId);
    void requireServerMember(const std::string& userId, const std::string& serverId);
    void requireServerAdmin(const std::string& userId, const std::string& serverId);
    void requireGm(const ChannelAccess& a);
    // The viewer must be a member of the chat window (GM of the channel is implicitly a member).
    void requireWindowMember(const ChannelAccess& a, const std::string& chatWindowId);
    std::optional<std::string> windowCharacter(const std::string& userId, const std::string& chatWindowId);

private:
    std::string tokenHash(const std::string& token) const;
    Db& db_;
    const Config& cfg_;
};

} // namespace acerciae
