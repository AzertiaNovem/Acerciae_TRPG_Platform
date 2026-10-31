#pragma once
#include "../core/Db.h"
#include "../core/Config.h"
#include <json/json.h>
#include <string>
#include <vector>
#include <optional>

namespace acerciae {
namespace logstudio { class ObjectStore; }

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
    // A user's avatar for a viewer who shares a server with them: either `url` (the public object, when redirecting is
    // allowed) or the bytes with their mime type. Throws 404 when there is none.
    struct Avatar { std::string mime, bytes, url; };
    Avatar avatar(const Principal& principal, const std::string& userId, bool allowRedirect = false);
    // Avatars are objects in the media store; without one (unit tests) they stay inline in users.avatar_data.
    void setObjectStore(logstudio::ObjectStore* store) { store_ = store; }
    void logout(const std::string& token);
    std::optional<Principal> authenticate(const std::string& token);
    // Short-lived tokens for URLs a browser loads by itself (images, audio, downloads, the WebSocket), so the session
    // token never lands in a URL, a proxy log or the browser history. Bound to the session: logging out revokes them.
    Json::Value issueFileToken(const std::string& sessionToken);          // {token, expires_at}
    std::optional<Principal> authenticateFileToken(const std::string& token);
    // The session behind a session token or a file token, by its stored hash ("" when neither is valid).
    std::string sessionHashOf(const std::string& token);

    // Authorisation helpers (throw ApiError 403/404)
    ChannelAccess channelAccess(const std::string& userId, const std::string& channelId);
    void requireServerMember(const std::string& userId, const std::string& serverId);
    void requireServerAdmin(const std::string& userId, const std::string& serverId);
    void requireGm(const ChannelAccess& a);
    // The viewer must be a member of the chat window (GM of the channel is implicitly a member).
    void requireWindowMember(const ChannelAccess& a, const std::string& chatWindowId);
    std::optional<std::string> windowCharacter(const std::string& userId, const std::string& chatWindowId);

private:
    logstudio::ObjectStore* store_ = nullptr;
    std::string tokenHash(const std::string& token) const;
    Db& db_;
    const Config& cfg_;
};

} // namespace acerciae
