#include "AuthService.h"
#include "../core/Crypto.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include <regex>

namespace acerciae {

static void validateUsername(const std::string& u) {
    static const std::regex re("^[a-zA-Z0-9_.-]{3,32}$");
    if (!std::regex_match(u, re)) throw badRequest("username must be 3-32 chars of letters, digits, _ . -");
}

std::string AuthService::tokenHash(const std::string& token) const {
    return crypto::hmacSha256Hex(cfg_.authSecret, token);
}

Json::Value AuthService::registerUser(const std::string& username, const std::string& password, const std::string& displayName) {
    validateUsername(username);
    if (password.size() < 6) throw badRequest("password must be at least 6 characters");
    auto existing = db_.queryOne("SELECT id FROM users WHERE username=$1", {username});
    if (!existing.isNull()) throw conflict("username already taken");
    auto row = db_.queryOne(
        "INSERT INTO users(username, display_name, password_hash) VALUES($1,$2,$3) RETURNING id, username, display_name, created_at",
        {username, displayName.empty() ? username : displayName, crypto::hashPassword(password)});
    return row;
}

Json::Value AuthService::login(const std::string& username, const std::string& password) {
    auto row = db_.queryOne("SELECT id, username, display_name, password_hash FROM users WHERE username=$1", {username});
    if (row.isNull() || !crypto::verifyPassword(password, row["password_hash"].asString()))
        throw unauthorized("invalid username or password");
    auto token = crypto::randomHex(32);
    db_.exec("INSERT INTO auth_tokens(token_hash, user_id, expires_at) VALUES($1,$2, now() + ($3 || ' hours')::interval)",
             {tokenHash(token), row["id"].asString(), std::to_string(cfg_.authTokenTtlHours)});
    Json::Value out;
    out["token"] = token;
    Json::Value user; user["id"] = row["id"]; user["username"] = row["username"]; user["display_name"] = row["display_name"];
    out["user"] = user;
    return out;
}

void AuthService::logout(const std::string& token) {
    db_.exec("DELETE FROM auth_tokens WHERE token_hash=$1", {tokenHash(token)});
}

std::optional<Principal> AuthService::authenticate(const std::string& token) {
    if (token.empty()) return std::nullopt;
    auto row = db_.queryOne(
        "SELECT u.id, u.username, u.display_name FROM auth_tokens t JOIN users u ON u.id=t.user_id "
        "WHERE t.token_hash=$1 AND t.expires_at > now()", {tokenHash(token)});
    if (row.isNull()) return std::nullopt;
    return Principal{row["id"].asString(), row["username"].asString(), row["display_name"].asString()};
}

ChannelAccess AuthService::channelAccess(const std::string& userId, const std::string& channelId) {
    auto row = db_.queryOne(
        "SELECT c.id, c.server_id, c.knowledge_mode, m.role FROM channels c "
        "JOIN channel_members m ON m.channel_id=c.id AND m.user_id=$2 WHERE c.id=$1", {channelId, userId});
    if (row.isNull()) {
        auto exists = db_.queryOne("SELECT id FROM channels WHERE id=$1", {channelId});
        if (exists.isNull()) throw notFound("channel not found");
        throw forbidden("not a member of this channel");
    }
    ChannelAccess a;
    a.channelId = channelId; a.serverId = row["server_id"].asString(); a.userId = userId;
    a.isGm = row["role"].asString() == "gm";
    a.knowledgeMode = row["knowledge_mode"].asString();
    auto chars = db_.queryJson("SELECT id FROM characters WHERE channel_id=$1 AND user_id=$2 AND kind='pc' ORDER BY created_at", {channelId, userId});
    for (auto& c : chars) a.characterIds.push_back(c["id"].asString());
    if (!a.characterIds.empty()) a.primaryCharacterId = a.characterIds.front();
    return a;
}

void AuthService::requireServerMember(const std::string& userId, const std::string& serverId) {
    auto r = db_.queryOne("SELECT 1 AS ok FROM server_members WHERE server_id=$1 AND user_id=$2", {serverId, userId});
    if (r.isNull()) throw forbidden("not a member of this server");
}
void AuthService::requireServerAdmin(const std::string& userId, const std::string& serverId) {
    auto r = db_.queryOne("SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2", {serverId, userId});
    if (r.isNull() || (r["role"].asString() != "owner" && r["role"].asString() != "admin")) throw forbidden("server admin required");
}
void AuthService::requireGm(const ChannelAccess& a) {
    if (!a.isGm) throw forbidden("GM role required");
}
void AuthService::requireWindowMember(const ChannelAccess& a, const std::string& chatWindowId) {
    auto w = db_.queryOne("SELECT channel_id FROM chat_windows WHERE id=$1", {chatWindowId});
    if (w.isNull() || w["channel_id"].asString() != a.channelId) throw notFound("chat window not found");
    if (a.isGm) return;
    auto r = db_.queryOne("SELECT 1 AS ok FROM chat_window_members WHERE chat_window_id=$1 AND user_id=$2", {chatWindowId, a.userId});
    if (r.isNull()) throw forbidden("not a participant of this chat window");
}
std::optional<std::string> AuthService::windowCharacter(const std::string& userId, const std::string& chatWindowId) {
    auto r = db_.queryOne("SELECT character_id FROM chat_window_members WHERE chat_window_id=$1 AND user_id=$2", {chatWindowId, userId});
    if (r.isNull() || r["character_id"].isNull()) return std::nullopt;
    return r["character_id"].asString();
}

} // namespace acerciae
