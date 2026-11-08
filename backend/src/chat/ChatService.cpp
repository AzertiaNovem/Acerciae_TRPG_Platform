#include "ChatService.h"
#include "../characters/CharacterSpaceService.h"
#include "../events/EventStore.h"
#include "../scenes/SceneManager.h"
#include "../ws/Notifier.h"
#include "../documents/DocumentService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../knowledge/Visibility.h"
#include "../dice/Dice.h"
#include "../dice/DiceService.h"
#include "../core/Text.h"
#include "../core/Crypto.h"
#include "../rules/RuleSystem.h"
#include "../rules/PbtaRuling.h"
#include "../core/Log.h"
#include "Recall.h"

#include "ChatQueries.h"
namespace acerciae {
using namespace chatQueries;
// ---- servers ---------------------------------------------------------------------------------
Json::Value ChatService::listServers(const Principal& p) {
    // A suspended server is still listed (with the reason), so its members see why it is closed; nothing inside it answers.
    return db_.queryJson("SELECT s.id, s.name, s.owner_id, s.created_at, sm.role AS my_role, s.suspended_at IS NOT NULL AS suspended, "
                         "CASE WHEN s.suspended_at IS NULL THEN '' ELSE s.suspended_reason END AS suspended_reason "
                         "FROM servers s JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=$1 ORDER BY s.created_at", {p.userId});
}
Json::Value ChatService::createServer(const Principal& p, const std::string& name) {
    if (name.empty() || name.size() > 80) throw badRequest("server name must be 1-80 chars");
    return db_.tx([&](pqxx::work& w) {
        auto s = Db::queryOne(w, "INSERT INTO servers(name, owner_id) VALUES($1,$2) RETURNING *", {name, p.userId});
        Db::exec(w, "INSERT INTO server_members(server_id, user_id, role) VALUES($1,$2,'owner')", {s["id"].asString(), p.userId});
        s["my_role"] = "owner";
        return s;
    });
}
ChatService::Policy ChatService::policy(const std::string& serverId) {
    Policy pol;
    auto r = db_.queryOne("SELECT join_policy, channel_creation, guest_invites, main_chat_spectators FROM server_settings WHERE server_id=$1", {serverId});
    if (r.isNull()) return pol;   // no settings row yet: the defaults
    pol.join = r["join_policy"].asString(); pol.channelCreation = r["channel_creation"].asString();
    pol.guestInvites = r["guest_invites"].asBool(); pol.spectators = r["main_chat_spectators"].asBool();
    return pol;
}
Json::Value ChatService::joinServer(const Principal& p, const std::string& serverId, const std::string& inviteCode) {
    if (!Visibility::isUuid(serverId)) throw notFound("server not found");
    auto s = db_.queryOne("SELECT id, name, owner_id, created_at FROM servers WHERE id=$1", {serverId});
    if (s.isNull()) throw notFound("server not found");
    auth_.requireServerActive(serverId);
    auto role = serverRole(db_, serverId, p.userId);
    if (!role.empty() && role != "guest") { s["my_role"] = role; return s; }
    auto pol = policy(serverId);
    if (pol.join == "closed") throw forbidden("this server is closed; a server maintainer must add you");
    if (inviteCode.empty() && pol.join != "open") throw forbidden("this server needs an invite code from a maintainer");
    db_.tx([&](pqxx::work& w) {
        if (!inviteCode.empty()) {
            auto used = Db::queryOne(w, "UPDATE server_invites SET uses=uses+1 WHERE code=$1 AND server_id=$2 AND revoked_at IS NULL "
                                        "AND (expires_at IS NULL OR expires_at > now()) AND (max_uses=0 OR uses < max_uses) RETURNING id", {inviteCode, serverId});
            if (used.isNull()) throw ApiError(410, "invite_invalid", "this invite has expired, been used up or been revoked");
        }
        Db::exec(w, "INSERT INTO server_members(server_id, user_id, role) VALUES($1,$2,'member') ON CONFLICT (server_id,user_id) DO UPDATE SET role='member' WHERE server_members.role='guest'", {serverId, p.userId});
    });
    s["my_role"] = "member";
    return s;
}
Json::Value ChatService::discoverServers(const Principal& p, const std::string& query) {
    auto q = text::trim(query);
    std::string like;
    for (char c : q) { if (c == '%' || c == '_' || c == '\\') like += '\\'; like += c; }
    return db_.queryJson("SELECT s.id, s.name, (SELECT count(*) FROM server_members m WHERE m.server_id=s.id AND m.role<>'guest') AS member_count "
                         "FROM servers s JOIN server_settings ss ON ss.server_id=s.id AND ss.join_policy='open' "
                         "WHERE s.suspended_at IS NULL AND NOT EXISTS (SELECT 1 FROM server_members me WHERE me.server_id=s.id AND me.user_id=$1 AND me.role<>'guest') "
                         "AND ($2='' OR s.name ILIKE '%' || $2 || '%') ORDER BY member_count DESC, s.created_at LIMIT 50", {p.userId, like});
}
static std::string inviteCode() {
    // 10 characters from an unambiguous alphabet (~50 bits).
    static const char* A = "abcdefghjkmnpqrstuvwxyz23456789";
    auto hex = crypto::randomHex(10);
    std::string out;
    for (std::size_t i = 0; i < 10; ++i) out += A[std::stoi(hex.substr(i * 2, 2), nullptr, 16) % 31];
    return out;
}
Json::Value ChatService::listInvites(const Principal& p, const std::string& serverId) {
    auth_.requireServerAdmin(p.userId, serverId);
    return db_.queryJson("SELECT i.id, i.code, i.max_uses, i.uses, i.expires_at, i.revoked_at, i.created_at, u.display_name AS created_by_name, "
                         "(i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > now()) AND (i.max_uses=0 OR i.uses < i.max_uses)) AS active "
                         "FROM server_invites i LEFT JOIN users u ON u.id=i.created_by WHERE i.server_id=$1 ORDER BY i.created_at DESC LIMIT 100", {serverId});
}
Json::Value ChatService::createInvite(const Principal& p, const std::string& serverId, const Json::Value& body) {
    auth_.requireServerAdmin(p.userId, serverId);
    if (policy(serverId).join == "closed") throw badRequest("the server is closed; switch its join policy to invite first");
    auto num = [&](const char* k, int def, int lo, int hi) {
        if (!body.isMember(k) || body[k].isNull()) return def;
        if (!body[k].isNumeric()) throw badRequest(std::string(k) + " must be a number");
        double d = body[k].asDouble();
        if (d < lo || d > hi) throw badRequest(std::string(k) + " must be between " + std::to_string(lo) + " and " + std::to_string(hi));
        return (int)d;
    };
    int maxUses = num("max_uses", 0, 0, 10000);
    int hours = num("expires_in_hours", 168, 0, 24 * 365);   // 0 = never
    if ((int)db_.queryOne("SELECT count(*) AS n FROM server_invites WHERE server_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", {serverId})["n"].asInt64() >= 50)
        throw badRequest("this server already has 50 active invites; revoke some first");
    return db_.queryOne("INSERT INTO server_invites(server_id, code, created_by, max_uses, expires_at) "
                        "VALUES($1,$2,$3,$4, CASE WHEN $5::int > 0 THEN now() + make_interval(hours => $5::int) END) "
                        "RETURNING id, code, max_uses, uses, expires_at, revoked_at, created_at, true AS active",
                        {serverId, inviteCode(), p.userId, (int64_t)maxUses, (int64_t)hours});
}
Json::Value ChatService::revokeInvite(const Principal& p, const std::string& serverId, const std::string& inviteId) {
    auth_.requireServerAdmin(p.userId, serverId);
    if (!Visibility::isUuid(inviteId)) throw notFound("invite not found");
    if (db_.queryOne("UPDATE server_invites SET revoked_at=coalesce(revoked_at, now()) WHERE id=$1 AND server_id=$2 RETURNING id", {inviteId, serverId}).isNull())
        throw notFound("invite not found");
    return listInvites(p, serverId);
}
Json::Value ChatService::previewInvite(const Principal& p, const std::string& code) {
    auto r = db_.queryOne("SELECT s.id AS server_id, s.name, coalesce(ss.join_policy, 'invite') AS join_policy, s.suspended_at IS NULL AS server_active, "
                          "(i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > now()) AND (i.max_uses=0 OR i.uses < i.max_uses)) AS active, "
                          "(SELECT count(*) FROM server_members m WHERE m.server_id=s.id AND m.role<>'guest') AS member_count "
                          "FROM server_invites i JOIN servers s ON s.id=i.server_id LEFT JOIN server_settings ss ON ss.server_id=s.id WHERE i.code=$1", {text::trim(code)});
    if (r.isNull()) throw notFound("invite not found");
    Json::Value v;
    v["server_id"] = r["server_id"]; v["name"] = r["name"]; v["member_count"] = r["member_count"];
    v["valid"] = r["active"].asBool() && r["join_policy"].asString() != "closed" && r["server_active"].asBool();
    auto role = serverRole(db_, r["server_id"].asString(), p.userId);
    v["already_member"] = !role.empty() && role != "guest";
    return v;
}
Json::Value ChatService::acceptInvite(const Principal& p, const std::string& code) {
    auto c = text::trim(code);
    auto r = db_.queryOne("SELECT server_id FROM server_invites WHERE code=$1", {c});
    if (r.isNull()) throw notFound("invite not found");
    return joinServer(p, r["server_id"].asString(), c);
}
Json::Value ChatService::findUser(const std::string& user) {
    auto u = Visibility::isUuid(user)
        ? db_.queryOne("SELECT id, username, display_name FROM users WHERE id=$1", {user})
        : db_.queryOne("SELECT id, username, display_name FROM users WHERE username=$1", {user});
    if (u.isNull()) throw notFound("user not found");
    return u;
}
bool ChatService::isServerMaintainer(const std::string& userId, const std::string& serverId) {
    auto r = db_.queryOne("SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2", {serverId, userId});
    return !r.isNull() && (r["role"].asString() == "owner" || r["role"].asString() == "admin");
}

Json::Value ChatService::addServerMember(const Principal& p, const std::string& serverId, const std::string& user, const std::string& role) {
    auth_.requireServerAdmin(p.userId, serverId);
    if (role != "admin" && role != "member") throw badRequest("role must be admin or member");
    if (role == "admin" && serverRole(db_, serverId, p.userId) != "owner") throw forbidden("only the server owner can appoint maintainers");
    auto u = findUser(user);
    auto existing = serverRole(db_, serverId, u["id"].asString());
    if (existing == "owner") throw badRequest("the owner is already a member");
    if (existing == "admin" && role == "member" && serverRole(db_, serverId, p.userId) != "owner") throw forbidden("only the server owner can change a maintainer's role");
    db_.exec("INSERT INTO server_members(server_id, user_id, role) VALUES($1,$2,$3) ON CONFLICT (server_id,user_id) DO UPDATE SET role=EXCLUDED.role", {serverId, u["id"].asString(), role});
    u["role"] = role;
    return u;
}
Json::Value ChatService::setServerMemberRole(const Principal& p, const std::string& serverId, const std::string& userId, const std::string& role) {
    if (serverRole(db_, serverId, p.userId) != "owner") throw forbidden("only the server owner can change roles");
    if (role != "admin" && role != "member") throw badRequest("role must be admin or member");
    auto cur = serverRole(db_, serverId, userId);
    if (cur.empty()) throw notFound("not a member of this server");
    if (cur == "owner") throw badRequest("the owner's role cannot be changed");
    db_.exec("UPDATE server_members SET role=$3 WHERE server_id=$1 AND user_id=$2", {serverId, userId, role});
    return serverMembers(p, serverId);
}
Json::Value ChatService::removeServerMember(const Principal& p, const std::string& serverId, const std::string& userId) {
    auto mine = serverRole(db_, serverId, p.userId);
    auto theirs = serverRole(db_, serverId, userId);
    if (theirs.empty()) throw notFound("not a member of this server");
    if (theirs == "owner") throw badRequest("the owner cannot be removed");
    bool self = userId == p.userId;
    if (!self) {
        if (mine != "owner" && mine != "admin") throw forbidden("server maintainer required");
        if (theirs == "admin" && mine != "owner") throw forbidden("only the server owner can remove a maintainer");
    }
    std::vector<std::string> windows;
    db_.tx([&](pqxx::work& w) {
        for (auto& r : Db::queryJson(w, "DELETE FROM chat_window_members wm USING chat_windows cw, channels c WHERE cw.id=wm.chat_window_id AND c.id=cw.channel_id AND c.server_id=$1 AND wm.user_id=$2 RETURNING cw.id", {serverId, userId}))
            windows.push_back(r["id"].asString());
        Db::exec(w, "DELETE FROM channel_members cm USING channels c WHERE c.id=cm.channel_id AND c.server_id=$1 AND cm.user_id=$2", {serverId, userId});
        Db::exec(w, "DELETE FROM server_members WHERE server_id=$1 AND user_id=$2", {serverId, userId});
    });
    for (auto& wid : windows) { auto win = db_.queryOne("SELECT * FROM chat_windows WHERE id=$1", {wid}); if (!win.isNull()) notifier_.windowChanged(win["channel_id"].asString(), win); }
    notifier_.revokeServer(userId, serverId);
    if (self) { Json::Value v; v["ok"] = true; return v; }
    return serverMembers(p, serverId);
}
Json::Value ChatService::serverMembers(const Principal& p, const std::string& serverId) {
    auth_.requireServerMember(p.userId, serverId);
    if (serverRole(db_, serverId, p.userId) == "guest") throw forbidden("guests only see the channels they were invited to");
    return db_.queryJson("SELECT u.id, u.username, u.display_name, sm.role, sm.joined_at FROM server_members sm JOIN users u ON u.id=sm.user_id WHERE sm.server_id=$1 "
                         "ORDER BY CASE sm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, sm.joined_at", {serverId});
}
Json::Value ChatService::searchUsers(const Principal& p, const std::string& query, int limit) {
    auto q = text::trim(query);
    if (q.empty()) return Json::Value(Json::arrayValue);
    std::string like;
    for (char c : q) { if (c == '%' || c == '_' || c == '\\') like += '\\'; like += c; }
    return db_.queryJson("SELECT id, username, display_name FROM users WHERE username ILIKE '%' || $1 || '%' OR display_name ILIKE '%' || $1 || '%' "
                         "ORDER BY (lower(username) = lower($2)) DESC, username LIMIT " + std::to_string(std::max(1, std::min(limit, 25))), {like, q});
}


} // namespace acerciae
