#include "AuthService.h"
#include "../core/Crypto.h"
#include <ctime>
#include "../core/Errors.h"
#include "../core/Json.h"
#include <regex>
#include <algorithm>
#include <drogon/utils/Utilities.h>
#include "../servers/ServerSettingsService.h"
#include "../logstudio/MediaService.h"
#include "../logstudio/ObjectStore.h"
#include "../core/Log.h"
#include "../core/Text.h"

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
        "INSERT INTO users(username, display_name, password_hash) VALUES($1,$2,$3) RETURNING id, username, display_name, ui_language, atmosphere_enabled, avatar_version, avatar_data, created_at",
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
    out["user"] = profile(row["id"].asString());
    return out;
}

Json::Value AuthService::profile(const std::string& userId) {
    // avatar_data is only filled for an avatar not yet moved into the object store; clients load the picture from
    // /api/users/{id}/avatar?v=<avatar_version> when has_avatar is true.
    auto result = db_.queryOne("SELECT id, username, display_name, ui_language, atmosphere_enabled, avatar_data, avatar_version, (avatar_data<>'' OR avatar_key IS NOT NULL) AS has_avatar FROM users WHERE id=$1", {userId});
    result["languages"] = Json::arrayValue;
    for (const auto& code : ServerSettingsService::languages()) result["languages"].append(code);
    return result;
}

Json::Value AuthService::updateProfile(const Principal& principal, const Json::Value& body) {
    if (!body.isObject()) throw badRequest("profile must be an object");
    for (const auto& key : body.getMemberNames()) {
        if (key != "username" && key != "display_name" && key != "ui_language" && key != "avatar_data" && key != "atmosphere_enabled") throw badRequest("unknown profile field");
        if (key != "atmosphere_enabled" && !body[key].isString()) throw badRequest("profile fields must be strings");
    }
    // Validate every supplied field before writing; a failed edit cannot partially change the account.
    if (body.isMember("username")) validateUsername(body["username"].asString());
    if (body.isMember("display_name")) {
        auto name = text::trim(body["display_name"].asString());
        if (name.empty() || name.size() > 200 || name.find_first_of("\r\n\t") != std::string::npos) throw badRequest("display name must be 1-200 bytes on one line");
    }
    if (body.isMember("atmosphere_enabled") && !body["atmosphere_enabled"].isBool()) throw badRequest("atmosphere_enabled must be boolean");
    if (body.isMember("ui_language")) {
        auto& languages = ServerSettingsService::languages();
        if (std::find(languages.begin(), languages.end(), body["ui_language"].asString()) == languages.end()) throw badRequest("unsupported interface language");
    }
    std::string avatarBytes, avatarMime;
    if (body.isMember("avatar_data") && !body["avatar_data"].asString().empty()) {
        auto data = body["avatar_data"].asString();
        auto comma = data.find(',');
        auto prefix = data.substr(0, comma);
        if (data.size() > 180000 || comma == std::string::npos || (prefix != "data:image/png;base64" && prefix != "data:image/jpeg;base64")) throw badRequest("avatar must be a PNG or JPEG under 128 KiB");
        auto encoded = data.substr(comma + 1);
        auto bytes = drogon::utils::base64Decode(encoded);
        if (bytes.empty() || bytes.size() > 131072 || drogon::utils::base64Encode(bytes) != encoded) throw badRequest("invalid avatar encoding");
        auto mime = logstudio::MediaService::sniffMime(bytes, "avatar");
        int width = 0, height = 0;
        logstudio::MediaService::probeDimensions(bytes, mime, width, height);
        if (prefix != "data:" + mime + ";base64" || width < 1 || height < 1 || width > 512 || height > 512) throw badRequest("avatar dimensions must be at most 512 by 512");
        avatarBytes = std::move(bytes); avatarMime = mime;
    }
    // A new avatar is written to the object store before the row points at it; "" removes the avatar, and an absent
    // avatar_data leaves it as it is.
    std::string newKey, oldKey;
    if (store_ && !avatarBytes.empty()) {
        newKey = logstudio::avatarObjectKey(*store_, principal.userId, avatarMime == "image/png" ? "png" : "jpg");
        store_->put(newKey, avatarBytes, avatarMime);
    }
    try {
        db_.tx([&](pqxx::work& w) {
            auto current = Db::queryOne(w, "SELECT * FROM users WHERE id=$1 FOR UPDATE", {principal.userId});
            auto username = json::str(body, "username", current["username"].asString());
            auto name = text::trim(json::str(body, "display_name", current["display_name"].asString()));
            auto language = json::str(body, "ui_language", current["ui_language"].asString());
            if(body.isMember("atmosphere_enabled")) Db::exec(w,"UPDATE users SET atmosphere_enabled=$2 WHERE id=$1",{principal.userId,body["atmosphere_enabled"].asBool()});
            Db::exec(w, "UPDATE users SET username=$2, display_name=$3, ui_language=$4 WHERE id=$1", {principal.userId, username, name, language});
            if (!body.isMember("avatar_data")) return;
            bool had = current["avatar_data"].asString() != "" || current["avatar_key"].isString();
            if (current["avatar_key"].isString()) oldKey = current["avatar_key"].asString();
            if (avatarBytes.empty()) {
                if (had) Db::exec(w, "UPDATE users SET avatar_data='', avatar_key=NULL, avatar_mime=NULL, avatar_version=avatar_version+1 WHERE id=$1", {principal.userId});
            } else if (!newKey.empty()) {
                Db::exec(w, "UPDATE users SET avatar_data='', avatar_key=$2, avatar_mime=$3, avatar_version=avatar_version+1 WHERE id=$1", {principal.userId, newKey, avatarMime});
            } else {
                auto data = body["avatar_data"].asString();
                Db::exec(w, "UPDATE users SET avatar_data=$2, avatar_key=NULL, avatar_mime=NULL, avatar_version=avatar_version + CASE WHEN avatar_data<>$2 THEN 1 ELSE 0 END WHERE id=$1", {principal.userId, data});
            }
        });
    } catch (const pqxx::unique_violation&) {
        if (!newKey.empty()) { try { store_->remove(newKey); } catch (...) {} }
        throw conflict("username already taken");
    } catch (...) {
        if (!newKey.empty()) { try { store_->remove(newKey); } catch (...) {} }
        throw;
    }
    if (store_ && !oldKey.empty() && body.isMember("avatar_data")) {
        try { store_->remove(oldKey); } catch (const std::exception& e) { ALOG_WARN << "could not remove the previous avatar " << oldKey << ": " << e.what(); }
    }
    return profile(principal.userId);
}

AuthService::Avatar AuthService::avatar(const Principal& principal, const std::string& userId, bool allowRedirect) {
    auto row = db_.queryOne("SELECT avatar_data, avatar_key, avatar_mime FROM users WHERE id=$1 AND (id=$2 OR EXISTS (SELECT 1 FROM server_members a JOIN server_members b ON a.server_id=b.server_id WHERE a.user_id=$1 AND b.user_id=$2))", {userId, principal.userId});
    if (row.isNull()) throw notFound("avatar not found");
    Avatar out;
    if (row["avatar_key"].isString() && store_) {
        auto key = row["avatar_key"].asString();
        out.mime = row["avatar_mime"].isString() ? row["avatar_mime"].asString() : "image/png";
        if (allowRedirect) { out.url = store_->publicUrl(key); if (!out.url.empty()) return out; }
        auto bytes = store_->get(key);
        if (!bytes) throw notFound("avatar not found");
        out.bytes = std::move(*bytes);
        return out;
    }
    auto data = row["avatar_data"].asString();
    if (data.empty()) throw notFound("avatar not found");
    out.mime = data.substr(5, data.find(';') - 5);
    out.bytes = drogon::utils::base64Decode(data.substr(data.find(',') + 1));
    return out;
}

void AuthService::logout(const std::string& token) {
    db_.exec("DELETE FROM auth_tokens WHERE token_hash=$1", {tokenHash(token)});
}

static const int kFileTokenSeconds = 6 * 3600;
Json::Value AuthService::issueFileToken(const std::string& sessionToken) {
    auto hash = tokenHash(sessionToken);
    auto row = db_.queryOne("SELECT extract(epoch from least(expires_at, now() + make_interval(secs => $2)))::bigint AS exp FROM auth_tokens WHERE token_hash=$1 AND expires_at > now()", {hash, (int64_t)kFileTokenSeconds});
    if (row.isNull()) throw unauthorized("session expired");
    auto exp = std::to_string(row["exp"].asInt64());
    Json::Value out;
    out["token"] = "f1." + hash + "." + exp + "." + crypto::hmacSha256Hex(cfg_.authSecret, "file-token|" + hash + "|" + exp);
    out["expires_at"] = (Json::Int64)row["exp"].asInt64();
    return out;
}
static bool splitFileToken(const std::string& token, std::string& hash, std::string& exp, std::string& sig) {
    if (token.rfind("f1.", 0) != 0) return false;
    auto a = token.find('.', 3), b = a == std::string::npos ? a : token.find('.', a + 1);
    if (b == std::string::npos) return false;
    hash = token.substr(3, a - 3); exp = token.substr(a + 1, b - a - 1); sig = token.substr(b + 1);
    return hash.size() == 64 && !exp.empty() && exp.size() < 12 && std::all_of(exp.begin(), exp.end(), ::isdigit);
}
std::optional<Principal> AuthService::authenticateFileToken(const std::string& token) {
    std::string hash, exp, sig;
    if (!splitFileToken(token, hash, exp, sig)) return std::nullopt;
    if (!crypto::constantTimeEquals(sig, crypto::hmacSha256Hex(cfg_.authSecret, "file-token|" + hash + "|" + exp))) return std::nullopt;
    if (std::stoll(exp) < (long long)std::time(nullptr)) return std::nullopt;
    auto row = db_.queryOne("SELECT u.id, u.username, u.display_name FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.expires_at > now()", {hash});
    if (row.isNull()) return std::nullopt;
    return Principal{row["id"].asString(), row["username"].asString(), row["display_name"].asString()};
}
std::string AuthService::sessionHashOf(const std::string& token) {
    std::string hash, exp, sig;
    if (splitFileToken(token, hash, exp, sig)) return authenticateFileToken(token) ? hash : "";
    return authenticate(token) ? tokenHash(token) : "";
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
    if (!a.isGm) {
        auto group = db_.queryOne("SELECT g.id,g.version FROM player_groups g JOIN player_group_members pm ON pm.group_id=g.id WHERE pm.channel_id=$1 AND pm.user_id=$2", {channelId,userId});
        if (!group.isNull()) { a.playerGroupId=group["id"].asString(); a.playerGroupVersion=group["version"].asInt(); }
    }
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
