#include "ChatService.h"
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

namespace acerciae {

static const std::string MSG_SELECT =
    "SELECT m.*, c.name AS character_name, c.avatar_asset_id AS character_avatar_asset_id, ca.version AS character_avatar_version, u.display_name AS author_name, CASE WHEN u.avatar_data<>'' OR u.avatar_key IS NOT NULL THEN u.avatar_version ELSE 0 END AS author_avatar_version FROM messages m "
    "LEFT JOIN characters c ON c.id=m.character_id LEFT JOIN media_assets ca ON ca.id=c.avatar_asset_id LEFT JOIN users u ON u.id=m.author_id ";

// ---- servers ---------------------------------------------------------------------------------
Json::Value ChatService::listServers(const Principal& p) {
    return db_.queryJson("SELECT s.*, sm.role AS my_role FROM servers s JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=$1 ORDER BY s.created_at", {p.userId});
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
static std::string serverRole(Db& db, const std::string& serverId, const std::string& userId);
Json::Value ChatService::joinServer(const Principal& p, const std::string& serverId, const std::string& inviteCode) {
    if (!Visibility::isUuid(serverId)) throw notFound("server not found");
    auto s = db_.queryOne("SELECT * FROM servers WHERE id=$1", {serverId});
    if (s.isNull()) throw notFound("server not found");
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
                         "WHERE NOT EXISTS (SELECT 1 FROM server_members me WHERE me.server_id=s.id AND me.user_id=$1 AND me.role<>'guest') "
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
    auto r = db_.queryOne("SELECT s.id AS server_id, s.name, coalesce(ss.join_policy, 'invite') AS join_policy, "
                          "(i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > now()) AND (i.max_uses=0 OR i.uses < i.max_uses)) AS active, "
                          "(SELECT count(*) FROM server_members m WHERE m.server_id=s.id AND m.role<>'guest') AS member_count "
                          "FROM server_invites i JOIN servers s ON s.id=i.server_id LEFT JOIN server_settings ss ON ss.server_id=s.id WHERE i.code=$1", {text::trim(code)});
    if (r.isNull()) throw notFound("invite not found");
    Json::Value v;
    v["server_id"] = r["server_id"]; v["name"] = r["name"]; v["member_count"] = r["member_count"];
    v["valid"] = r["active"].asBool() && r["join_policy"].asString() != "closed";
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
static std::string serverRole(Db& db, const std::string& serverId, const std::string& userId) {
    auto r = db.queryOne("SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2", {serverId, userId});
    return r.isNull() ? "" : r["role"].asString();
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

// ---- channels --------------------------------------------------------------------------------
Json::Value ChatService::listChannels(const Principal& p, const std::string& serverId) {
    auth_.requireServerMember(p.userId, serverId);
    return db_.queryJson(
        "SELECT c.*, cm.role AS my_role FROM channels c JOIN channel_members cm ON cm.channel_id=c.id AND cm.user_id=$2 WHERE c.server_id=$1 ORDER BY c.created_at",
        {serverId, p.userId});
}
Json::Value ChatService::allChannels(const Principal& p, const std::string& serverId) {
    auth_.requireServerMember(p.userId, serverId);
    auto role = serverRole(db_, serverId, p.userId);
    if (role != "owner" && role != "admin") throw forbidden("server maintainer required");
    return db_.queryJson(
        "SELECT c.id, c.name, c.description, c.created_at, (SELECT count(*) FROM channel_members cm WHERE cm.channel_id=c.id)::int AS member_count, "
        "(SELECT count(*) FROM messages m WHERE m.channel_id=c.id)::int AS message_count FROM channels c WHERE c.server_id=$1 ORDER BY c.created_at", {serverId});
}
Json::Value ChatService::createChannel(const Principal& p, const std::string& serverId, const Json::Value& body) {
    auth_.requireServerMember(p.userId, serverId);
    auto role = serverRole(db_, serverId, p.userId);
    if (role == "guest") throw forbidden("guests cannot create channels");
    if (role == "member" && policy(serverId).channelCreation == "maintainers") throw forbidden("on this server only maintainers create channels");
    auto name = json::requireStr(body, "name");
    auto mode = json::str(body, "knowledge_mode", "isolated");
    if (mode != "public" && mode != "isolated") throw badRequest("knowledge_mode must be public or isolated");
    auto ch = db_.tx([&](pqxx::work& w) {
        auto c = Db::queryOne(w, "INSERT INTO channels(server_id, name, description, rule_system, knowledge_mode) VALUES($1,$2,$3,$4,$5) RETURNING *",
            {serverId, name, json::str(body, "description"), json::str(body, "rule_system", "coc7e"), mode});
        auto id = c["id"].asString();
        Db::exec(w, "INSERT INTO channel_members(channel_id, user_id, role) VALUES($1,$2,'gm')", {id, p.userId});
        auto win = Db::queryOne(w, "INSERT INTO chat_windows(channel_id, name, kind, created_by) VALUES($1,'Main Chat','main',$2) RETURNING id", {id, p.userId});
        Db::exec(w, "INSERT INTO chat_window_members(chat_window_id, user_id) VALUES($1,$2)", {win["id"].asString(), p.userId});
        docs_.ensureCoreDocuments(w, id);
        c["my_role"] = "gm";
        return c;
    });
    return ch;
}
// The GM's per-channel AI switches (consistency_enabled, inspiration_enabled, …): 403 feature_disabled when off.
void ChatService::requireChannelAi(const ChannelAccess& a, const std::string& column) {
    auto r = db_.queryOne("SELECT " + column + " AS on FROM channels WHERE id=$1", {a.channelId});
    if (r.isNull() || !r["on"].asBool()) throw ApiError(403, "feature_disabled", "The GM turned this off for this channel");
}
Json::Value ChatService::getChannel(const ChannelAccess& a) {
    auto c = db_.queryOne("SELECT c.*, s.title AS current_scene_title FROM channels c LEFT JOIN scenes s ON s.id=c.current_scene_id WHERE c.id=$1", {a.channelId});
    if(!a.isGm) c["current_scene_title"]=Json::Value();
    if(!a.playerGroupId.empty()) c["player_group_name"]=db_.queryOne("SELECT name FROM player_groups WHERE id=$1",{a.playerGroupId})["name"];
    c["player_group_id"]=a.playerGroupId; c["player_group_version"]=a.playerGroupVersion;
    c["my_role"] = a.isGm ? "gm" : "player";
    c["my_character_ids"] = json::fromStrArray(a.characterIds);
    return c;
}
Json::Value ChatService::updateChannel(const ChannelAccess& a, const Json::Value& body) {
    auth_.requireGm(a);
    auto cur = getChannel(a);
    auto mode = json::str(body, "knowledge_mode", cur["knowledge_mode"].asString());
    if (mode != "public" && mode != "isolated") throw badRequest("knowledge_mode must be public or isolated");
    // Dice text group: '' (follow the server language), a built-in group, or one of this server's groups.
    auto group = json::str(body, "dice_text_group", cur["dice_text_group"].asString());
    if (!group.empty() && group != "builtin:en" && group != "builtin:zh") {
        if (!Visibility::isUuid(group) || db_.queryOne("SELECT 1 AS ok FROM dice_text_groups WHERE id=$1 AND server_id=$2", {group, a.serverId}).isNull())
            throw badRequest("unknown dice text group");
    }
    auto flag = [&](const char* k) { return json::toBool(body, k, cur[k].asBool()); };
    db_.exec("UPDATE channels SET name=$2, description=$3, knowledge_mode=$4, ai_enabled=$5, dice_text_group=$6, auto_scenarios=$7, era=$8, studio_visible=$9, studio_player_access=$10, "
             "consistency_enabled=$11, inspiration_enabled=$12, atmosphere_enabled=$13 WHERE id=$1",
        {a.channelId, json::str(body, "name", cur["name"].asString()), json::str(body, "description", cur["description"].asString()), mode, flag("ai_enabled"), group, flag("auto_scenarios"), text::utf8Prefix(json::str(body, "era", cur["era"].asString()), 80), flag("studio_visible"), flag("studio_player_access"),
         flag("consistency_enabled"), flag("inspiration_enabled"), flag("atmosphere_enabled")});
    notifier_.channelUpdated(a.channelId);
    return getChannel(a);
}
Json::Value ChatService::endStory(const ChannelAccess& a, const Json::Value& body) {
    auth_.requireGm(a);
    db_.exec("UPDATE channels SET story_status='ended', story_ended_at=coalesce(story_ended_at, now()), story_reveal_all=$2 WHERE id=$1", {a.channelId, json::toBool(body, "reveal_keeper_lines")});
    notifier_.channelUpdated(a.channelId);
    return getChannel(a);
}
Json::Value ChatService::reopenStory(const ChannelAccess& a) {
    auth_.requireGm(a);
    db_.exec("UPDATE channels SET story_status='ongoing', story_ended_at=NULL, story_reveal_all=false WHERE id=$1", {a.channelId});
    notifier_.channelUpdated(a.channelId);
    return getChannel(a);
}
Json::Value ChatService::addChannelMember(const ChannelAccess& a, const std::string& user, const std::string& role) {
    auth_.requireGm(a);
    if (role != "gm" && role != "player") throw badRequest("role must be gm or player");
    auto u = findUser(user);
    auto uid = u["id"].asString();
    // Outsiders join the server as members when a maintainer invites them, as guests when the server allows GMs to
    // invite guests, and not at all otherwise.
    std::string serverRoleForNew;
    if (serverRole(db_, a.serverId, uid).empty()) {
        if (isServerMaintainer(a.userId, a.serverId)) serverRoleForNew = "member";
        else if (policy(a.serverId).guestInvites) serverRoleForNew = "guest";
        else throw badRequest("that user is not on this server — ask a server maintainer to invite them");
    }
    std::string mainId;
    db_.tx([&](pqxx::work& w) {
        if (!serverRoleForNew.empty()) Db::exec(w, "INSERT INTO server_members(server_id, user_id, role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", {a.serverId, uid, serverRoleForNew});
        Db::exec(w, "INSERT INTO channel_members(channel_id, user_id, role) VALUES($1,$2,$3) ON CONFLICT (channel_id,user_id) DO UPDATE SET role=EXCLUDED.role", {a.channelId, uid, role});
        // A newcomer starts with the history read: the unread counters count what is posted from now on.
        Db::exec(w, "INSERT INTO chat_window_reads(chat_window_id, user_id, last_read_seq) SELECT cw.id, $2, coalesce((SELECT max(seq) FROM messages m WHERE m.chat_window_id=cw.id), 0) FROM chat_windows cw WHERE cw.channel_id=$1 ON CONFLICT DO NOTHING", {a.channelId, uid});
        // Everyone joins the main window by default.
        auto main = Db::queryOne(w, "SELECT id FROM chat_windows WHERE channel_id=$1 AND kind='main' ORDER BY created_at LIMIT 1", {a.channelId});
        if (!main.isNull()) { mainId = main["id"].asString(); Db::exec(w, "INSERT INTO chat_window_members(chat_window_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", {mainId, uid}); }
    });
    if (!mainId.empty()) notifier_.windowChanged(a.channelId, db_.queryOne("SELECT * FROM chat_windows WHERE id=$1", {mainId}));
    u["role"] = role;
    u["server_role"] = serverRole(db_, a.serverId, uid);
    return u;
}
Json::Value ChatService::removeChannelMember(const ChannelAccess& a, const std::string& userId) {
    auth_.requireGm(a);
    if (userId == a.userId) throw badRequest("you cannot remove yourself from the channel");
    if (!Visibility::isUuid(userId)) throw notFound("not a member of this channel");
    std::vector<std::string> windows;
    db_.tx([&](pqxx::work& w) {
        auto m = Db::queryOne(w, "DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2 RETURNING role", {a.channelId, userId});
        if (m.isNull()) throw notFound("not a member of this channel");
        for (auto& r : Db::queryJson(w, "DELETE FROM chat_window_members wm USING chat_windows cw WHERE cw.id=wm.chat_window_id AND cw.channel_id=$1 AND wm.user_id=$2 RETURNING cw.id", {a.channelId, userId}))
            windows.push_back(r["id"].asString());
        // A guest belongs to the server only through their channels.
        Db::exec(w, "DELETE FROM server_members sm WHERE sm.server_id=$1 AND sm.user_id=$2 AND sm.role='guest' AND NOT EXISTS "
                    "(SELECT 1 FROM channel_members cm JOIN channels c ON c.id=cm.channel_id WHERE c.server_id=$1 AND cm.user_id=$2)", {a.serverId, userId});
    });
    for (auto& wid : windows) notifier_.windowChanged(a.channelId, db_.queryOne("SELECT * FROM chat_windows WHERE id=$1", {wid}));
    notifier_.revokeChannel(userId, a.channelId);
    return channelMembers(a);
}
Json::Value ChatService::channelMembers(const ChannelAccess& a) {
    return db_.queryJson(
        "SELECT u.id, u.username, u.display_name, cm.role, "
        "(SELECT json_agg(json_build_object('id', ch.id, 'name', ch.name)) FROM characters ch WHERE ch.channel_id=cm.channel_id AND ch.user_id=u.id) AS characters "
        "FROM channel_members cm JOIN users u ON u.id=cm.user_id WHERE cm.channel_id=$1 ORDER BY cm.role, cm.joined_at", {a.channelId});
}

// ---- Main Chat spectating ------------------------------------------------------------------
bool ChatService::canSpectate(const std::string& userId, const std::string& channelId) {
    if (!Visibility::isUuid(channelId)) return false;
    auto c = db_.queryOne("SELECT server_id FROM channels WHERE id=$1", {channelId});
    if (c.isNull()) return false;
    auto sid = c["server_id"].asString();
    auto role = serverRole(db_, sid, userId);
    return !role.empty() && role != "guest" && policy(sid).spectators;
}
Json::Value ChatService::spectatableChannels(const Principal& p, const std::string& serverId) {
    auth_.requireServerMember(p.userId, serverId);
    auto role = serverRole(db_, serverId, p.userId);
    if (role == "guest" || !policy(serverId).spectators) return Json::Value(Json::arrayValue);
    return db_.queryJson("SELECT c.id, c.name, c.description FROM channels c WHERE c.server_id=$1 "
                         "AND NOT EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.user_id=$2) ORDER BY c.created_at", {serverId, p.userId});
}
Json::Value ChatService::spectate(const Principal& p, const std::string& channelId, int limit, int64_t beforeSeq) {
    if (!canSpectate(p.userId, channelId)) {
        if (!Visibility::isUuid(channelId) || db_.queryOne("SELECT 1 AS ok FROM channels WHERE id=$1", {channelId}).isNull()) throw notFound("channel not found");
        throw forbidden("this server does not let members read channels they were not invited to");
    }
    Json::Value out;
    out["channel"] = db_.queryOne("SELECT id, server_id, name, description FROM channels WHERE id=$1", {channelId});
    auto win = db_.queryOne("SELECT id, name FROM chat_windows WHERE channel_id=$1 AND kind='main' ORDER BY created_at LIMIT 1", {channelId});
    out["window"] = win;
    out["messages"] = Json::Value(Json::arrayValue);
    if (win.isNull()) return out;
    // Only lines every Main Chat participant sees; never whispers or Keeper-only lines.
    std::string sql = MSG_SELECT + "WHERE m.chat_window_id=$1 AND m.visibility='window'";
    DbParams params{win["id"].asString()};
    if (beforeSeq > 0) { sql += " AND m.seq < $2"; params.push_back(beforeSeq); }
    sql += " ORDER BY m.seq DESC LIMIT " + std::to_string(std::max(1, std::min(limit, 200)));
    for (auto m : db_.queryJson("SELECT * FROM (" + sql + ") x ORDER BY seq ASC", params)) out["messages"].append(spectatorMessage(m));
    return out;
}
Json::Value ChatService::spectatorMessage(Json::Value m) {
    // Character art lives in the channel's media library, which spectators cannot open.
    m["character_avatar_asset_id"] = Json::Value(); m["character_avatar_version"] = Json::Value();
    m.removeMember("whisper_to");
    return m;
}

// ---- characters ------------------------------------------------------------------------------
Json::Value ChatService::listCharacters(const ChannelAccess& a) {
    // Players see all PC names (table knowledge) but GM-only NPC sheets stay hidden.
    std::string sql = "SELECT c.*, u.display_name AS player_name FROM characters c LEFT JOIN users u ON u.id=c.user_id WHERE c.channel_id=$1";
    if (!a.isGm) sql += " AND c.kind='pc'";
    sql += " ORDER BY c.kind, c.created_at";
    return db_.queryJson(sql, {a.channelId});
}
Json::Value ChatService::createCharacter(const ChannelAccess& a, const Json::Value& body) {
    auto name = json::requireStr(body, "name");
    auto kind = json::str(body, "kind", "pc");
    if (kind != "pc" && kind != "npc") throw badRequest("kind must be pc or npc");
    std::string ownerId = a.userId;
    if (kind == "npc") { auth_.requireGm(a); ownerId.clear(); }
    else if (a.isGm && !json::str(body, "user_id").empty()) ownerId = json::str(body, "user_id");
    auto sheet = dice::normalizeSheet(body.isMember("sheet") && body["sheet"].isObject() ? body["sheet"] : Json::Value(Json::objectValue));
    return db_.tx([&](pqxx::work& w) {
        auto c = Db::queryOne(w, "INSERT INTO characters(channel_id, user_id, name, kind, speaking_style, sheet) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *",
            {a.channelId, ownerId.empty() ? dbNull() : DbParam(ownerId), name, kind, json::str(body, "speaking_style"), json::dump(sheet)});
        if (kind == "pc" && !ownerId.empty()) {
            // Bind the character to the windows its player is already in and has no character yet.
            Db::exec(w, "UPDATE chat_window_members wm SET character_id=$2 FROM chat_windows cw WHERE cw.id=wm.chat_window_id AND cw.channel_id=$1 AND wm.user_id=$3 AND wm.character_id IS NULL",
                {a.channelId, c["id"].asString(), ownerId});
        }
        Db::exec(w, "INSERT INTO entities(channel_id, kind, name, character_id, description) VALUES($1,$2,$3,$4,$5) ON CONFLICT (channel_id, kind, name) WHERE player_group_id IS NULL DO UPDATE SET character_id=EXCLUDED.character_id",
            {a.channelId, kind, name, c["id"].asString(), json::str(body, "description")});
        return c;
    });
}
Json::Value ChatService::updateCharacter(const ChannelAccess& a, const std::string& characterId, const Json::Value& body) {
    auto cur = db_.queryOne("SELECT * FROM characters WHERE id=$1 AND channel_id=$2", {characterId, a.channelId});
    if (cur.isNull()) throw notFound("character not found");
    if (!a.isGm && (cur["user_id"].isNull() || cur["user_id"].asString() != a.userId)) throw forbidden("not your character");
    auto sheet = body.isMember("sheet") && body["sheet"].isObject() ? dice::normalizeSheet(body["sheet"]) : cur["sheet"];
    return db_.queryOne("UPDATE characters SET name=$3, speaking_style=$4, sheet=$5::jsonb WHERE id=$1 AND channel_id=$2 RETURNING *",
        {characterId, a.channelId, json::str(body, "name", cur["name"].asString()), json::str(body, "speaking_style", cur["speaking_style"].asString()), json::dump(sheet)});
}

// ---- windows ---------------------------------------------------------------------------------
Json::Value ChatService::listWindows(const ChannelAccess& a) {
    std::string sql =
        "SELECT w.*, " + std::string(a.isGm ? "s.title" : "NULL::text") + " AS scene_title, "
        "(SELECT json_agg(json_build_object('user_id', wm.user_id, 'character_id', wm.character_id, 'display_name', u.display_name, 'character_name', ch.name)) "
        " FROM chat_window_members wm JOIN users u ON u.id=wm.user_id LEFT JOIN characters ch ON ch.id=wm.character_id WHERE wm.chat_window_id=w.id) AS members, "
        "(SELECT max(seq) FROM messages m WHERE m.chat_window_id=w.id) AS last_seq, "
        // Messages this viewer may read, posted by someone else after what they last read (counted up to 100).
        "(SELECT count(*) FROM (SELECT 1 FROM messages m WHERE m.chat_window_id=w.id AND m.author_id IS DISTINCT FROM $2::uuid "
        "   AND m.seq > coalesce((SELECT r.last_read_seq FROM chat_window_reads r WHERE r.chat_window_id=w.id AND r.user_id=$2::uuid), 0) "
        "   AND " + Visibility::messageFilter(a) + " LIMIT 100) u) AS unread "
        "FROM chat_windows w LEFT JOIN scenes s ON s.id=w.active_scene_id WHERE w.channel_id=$1";
    if (!a.isGm) sql += " AND EXISTS (SELECT 1 FROM chat_window_members wm2 JOIN player_group_members pm ON pm.user_id=wm2.user_id WHERE pm.channel_id=w.channel_id AND pm.group_id=$3::uuid AND wm2.chat_window_id=w.id) AND " + Visibility::groupGuard(a);
    sql += " ORDER BY w.created_at";
    DbParams p{a.channelId, a.userId}; if (!a.isGm) p.push_back(a.playerGroupId.empty()?dbNull():DbParam(a.playerGroupId));
    return db_.queryJson(sql, p);
}
Json::Value ChatService::createWindow(const ChannelAccess& a, const Json::Value& body) {
    auth_.requireGm(a);
    auto name = json::requireStr(body, "name");
    auto kind = json::str(body, "kind", "group");
    if (kind != "group" && kind != "private" && kind != "main") throw badRequest("kind must be main, group or private");
    auto win = db_.tx([&](pqxx::work& w) {
        auto row = Db::queryOne(w, "INSERT INTO chat_windows(channel_id, name, kind, created_by) VALUES($1,$2,$3,$4) RETURNING *", {a.channelId, name, kind, a.userId});
        auto wid = row["id"].asString();
        Db::exec(w, "INSERT INTO chat_window_members(chat_window_id, user_id) VALUES($1,$2)", {wid, a.userId});
        for (auto& m : body["members"]) {
            auto uid = json::str(m, "user_id"); if (uid.empty()) continue;
            auto cid = json::str(m, "character_id");
            auto cm = Db::queryOne(w, "SELECT 1 AS ok FROM channel_members WHERE channel_id=$1 AND user_id=$2", {a.channelId, uid});
            if (cm.isNull()) throw badRequest("user is not a channel member: " + uid);
            if (cid.empty()) {
                auto c = Db::queryOne(w, "SELECT id FROM characters WHERE channel_id=$1 AND user_id=$2 AND kind='pc' ORDER BY created_at LIMIT 1", {a.channelId, uid});
                if (!c.isNull()) cid = c["id"].asString();
            }
            Db::exec(w, "INSERT INTO chat_window_members(chat_window_id, user_id, character_id) VALUES($1,$2,$3) ON CONFLICT (chat_window_id,user_id) DO UPDATE SET character_id=EXCLUDED.character_id",
                {wid, uid, cid.empty() ? dbNull() : DbParam(cid)});
        }
        // Scenarios are campaign-wide: a new window joins the channel's current scenario (a scene_id in the body is ignored).
        auto cur = Db::queryOne(w, "SELECT current_scene_id FROM channels WHERE id=$1", {a.channelId});
        if (!cur.isNull() && !cur["current_scene_id"].isNull()) {
            Db::exec(w, "UPDATE chat_windows SET active_scene_id=$2 WHERE id=$1", {wid, cur["current_scene_id"].asString()});
            Db::exec(w, "INSERT INTO chat_window_scenes(chat_window_id, scene_id) VALUES($1,$2) ON CONFLICT DO NOTHING", {wid, cur["current_scene_id"].asString()});
        }
        return Db::queryOne(w, "SELECT * FROM chat_windows WHERE id=$1", {wid});
    });
    notifier_.windowChanged(a.channelId, win);
    return win;
}
Json::Value ChatService::addWindowMember(const ChannelAccess& a, const std::string& windowId, const std::string& userId, const std::string& characterId) {
    auth_.requireGm(a);
    auth_.requireWindowMember(a, windowId);
    auto cm = db_.queryOne("SELECT 1 AS ok FROM channel_members WHERE channel_id=$1 AND user_id=$2", {a.channelId, userId});
    if (cm.isNull()) throw badRequest("user is not a channel member");
    std::string cid = characterId;
    if (cid.empty()) {
        auto c = db_.queryOne("SELECT id FROM characters WHERE channel_id=$1 AND user_id=$2 AND kind='pc' ORDER BY created_at LIMIT 1", {a.channelId, userId});
        if (!c.isNull()) cid = c["id"].asString();
    }
    db_.exec("INSERT INTO chat_window_members(chat_window_id, user_id, character_id) VALUES($1,$2,$3) ON CONFLICT (chat_window_id,user_id) DO UPDATE SET character_id=EXCLUDED.character_id",
        {windowId, userId, cid.empty() ? dbNull() : DbParam(cid)});
    auto win = db_.queryOne("SELECT * FROM chat_windows WHERE id=$1", {windowId});
    notifier_.windowChanged(a.channelId, win);
    return windowMembers(a, windowId);
}
Json::Value ChatService::removeWindowMember(const ChannelAccess& a, const std::string& windowId, const std::string& userId) {
    auth_.requireGm(a);
    auth_.requireWindowMember(a, windowId);
    db_.exec("DELETE FROM chat_window_members WHERE chat_window_id=$1 AND user_id=$2", {windowId, userId});
    auto win = db_.queryOne("SELECT * FROM chat_windows WHERE id=$1", {windowId});
    notifier_.windowChanged(a.channelId, win);
    return windowMembers(a, windowId);
}
Json::Value ChatService::windowMembers(const ChannelAccess& a, const std::string& windowId) {
    auth_.requireWindowMember(a, windowId);
    return db_.queryJson("SELECT wm.user_id, wm.character_id, u.display_name, u.username, ch.name AS character_name FROM chat_window_members wm JOIN users u ON u.id=wm.user_id LEFT JOIN characters ch ON ch.id=wm.character_id WHERE wm.chat_window_id=$1", {windowId});
}

// ---- messages --------------------------------------------------------------------------------
Json::Value ChatService::listMessages(const ChannelAccess& a, const std::string& windowId, int limit, int64_t beforeSeq) {
    auto window=db_.queryOne("SELECT id FROM chat_windows WHERE id=$1 AND channel_id=$2",{windowId,a.channelId});
    if(window.isNull()) throw notFound("chat window not found");
    if(!a.isGm && db_.queryOne("SELECT 1 AS ok FROM chat_window_members wm JOIN player_group_members pm ON pm.user_id=wm.user_id WHERE wm.chat_window_id=$1 AND pm.channel_id=$2 AND pm.group_id=$3::uuid AND "+Visibility::groupGuard(a)+" LIMIT 1",{windowId,a.channelId,a.playerGroupId.empty()?dbNull():DbParam(a.playerGroupId)}).isNull()) throw forbidden("Chat window is outside this player group's views");
    std::string sql = MSG_SELECT + "WHERE m.chat_window_id=$1 AND " + Visibility::messageFilter(a);
    DbParams p{windowId};
    if (beforeSeq > 0) { sql += " AND m.seq < $2"; p.push_back(beforeSeq); }
    sql += " ORDER BY m.seq DESC LIMIT " + std::to_string(std::max(1, std::min(limit, 200)));
    auto rows = db_.queryJson("SELECT * FROM (" + sql + ") x ORDER BY seq ASC", p);
    return rows;
}
Json::Value ChatService::markRead(const ChannelAccess& a, const std::string& windowId, int64_t seq) {
    listMessages(a, windowId, 1, 0);   // the same access check as reading the window
    auto row = db_.queryOne("INSERT INTO chat_window_reads(chat_window_id, user_id, last_read_seq) VALUES($1,$2,LEAST($3, coalesce((SELECT max(seq) FROM messages WHERE chat_window_id=$1), 0))) "
        "ON CONFLICT (chat_window_id, user_id) DO UPDATE SET last_read_seq=GREATEST(chat_window_reads.last_read_seq, EXCLUDED.last_read_seq), updated_at=now() RETURNING last_read_seq",
        {windowId, a.userId, seq});
    Json::Value v; v["last_read_seq"] = row["last_read_seq"]; return v;
}
Json::Value ChatService::getMessage(const ChannelAccess& a, const std::string& messageId) {
    auto m = db_.queryOne(MSG_SELECT + "WHERE m.id=$1 AND m.channel_id=$2 AND " + Visibility::messageFilter(a), {messageId, a.channelId});
    if (m.isNull()) throw notFound("message not found");
    return m;
}
Json::Value ChatService::searchMessages(const ChannelAccess& a, const std::string& query, int limit) {
    if (query.empty()) throw badRequest("query required");
    return db_.queryJson(MSG_SELECT + "WHERE m.channel_id=$1 AND " + Visibility::messageFilter(a) +
        " AND (m.search @@ plainto_tsquery('english', $2) OR m.content ILIKE '%' || $2 || '%') ORDER BY m.seq DESC LIMIT " + std::to_string(std::max(1, std::min(limit, 100))),
        {a.channelId, query});
}
Json::Value ChatService::postSystemMessage(pqxx::work& w, const std::string& channelId, const std::string& windowId, const std::string& authorId, const std::string& content) {
    auto sceneId = scenes_.resolveSceneForWindow(w, channelId, windowId);
    auto id = Db::queryOne(w,
        "INSERT INTO messages(channel_id, chat_window_id, scene_id, author_id, author_role, kind, content, visibility, whisper_to) VALUES($1,$2,$3,$4,'gm','system',$5,'window','{}'::uuid[]) RETURNING id",
        {channelId, windowId, sceneId, authorId, content})["id"].asString();
    NewEvent e; e.channelId = channelId; e.chatWindowId = windowId; e.sceneId = sceneId; e.messageId = id; e.actorUserId = authorId; e.actorRole = "system"; e.kind = "message.posted";
    for (auto& r : Db::queryJson(w, "SELECT character_id FROM chat_window_members WHERE chat_window_id=$1 AND character_id IS NOT NULL", {windowId})) e.audience.push_back(r["character_id"].asString());
    e.payload["content"] = content; e.payload["message_kind"] = "system";
    events_.append(w, e);
    return Db::queryOne(w, MSG_SELECT + "WHERE m.id=$1", {id});
}
Json::Value ChatService::postMessage(const ChannelAccess& a, const std::string& windowId, const Json::Value& body) {
    auth_.requireWindowMember(a, windowId);
    auto content = json::str(body, "content");
    if (content.empty()) throw badRequest("content required");
    if (content.size() > 20000) throw badRequest("message too long");
    auto kind = json::str(body, "kind", "ic");
    if (kind != "ic" && kind != "ooc" && kind != "narration" && kind != "roll") throw badRequest("invalid message kind");
    auto visibility = json::str(body, "visibility", "window");
    if (visibility != "window" && visibility != "gm_only" && visibility != "whisper") throw badRequest("invalid visibility");
    if (visibility != "window" && !a.isGm) throw forbidden("only the GM can post gm_only or whisper messages");
    if(body.isMember("reference_ids") && !body["reference_ids"].isArray()) throw badRequest("reference_ids must be an array");
    if(body["reference_ids"].size()>5) throw badRequest("At most five chat references");
    for(const auto& ref : body["reference_ids"]) if(!ref.isString()) throw badRequest("Reference IDs must be strings");
    auto references=json::strArray(body["reference_ids"]);
    if(references.size()>5) throw badRequest("At most five chat references");
    for(const auto& id : references) { if(!Visibility::isUuid(id)) throw badRequest("Invalid reference ID"); getMessage(a,id); }
    auto whisperTo = json::strArray(body["whisper_to"]);
    if (visibility == "whisper" && whisperTo.empty()) throw badRequest("whisper_to required for whisper");

    std::string characterId = json::str(body, "character_id");
    if (characterId.empty()) { auto wc = auth_.windowCharacter(a.userId, windowId); if (wc) characterId = *wc; }
    std::string characterKind;
    if (!characterId.empty()) {
        auto c = db_.queryOne("SELECT user_id, kind FROM characters WHERE id=$1 AND channel_id=$2", {characterId, a.channelId});
        if (c.isNull()) throw badRequest("character not in this channel");
        if (!a.isGm && (c["user_id"].isNull() || c["user_id"].asString() != a.userId)) throw forbidden("not your character");
        characterKind = c["kind"].asString();
    }
    // Sealdice-style commands (.r .ra .sc .st .en ...) are evaluated by the dice service and stored as roll messages.
    auto diceCmd = dice_.recognise(a, content);
    if (diceCmd) kind = "roll";
    else if (kind == "roll") throw badRequest("roll messages come from dice commands: start the message with a dot command such as .ra or .r");

    DiceService::Result diceResult;
    Json::Value notice;
    auto msg = db_.tx([&](pqxx::work& w) {
        auto sceneId = scenes_.resolveSceneForWindow(w, a.channelId, windowId);
        std::string eventText = content;
        Json::Value diceJson;
        if (diceCmd) {
            diceResult = dice_.execute(w, a, characterId, *diceCmd);
            diceJson = diceResult.dice; eventText = diceResult.text;
            if (diceResult.hidden) {
                // Hidden rolls: the result reaches the roller's character and the GM; the window only sees a notice.
                if (!characterId.empty() && characterKind == "pc") { visibility = "whisper"; whisperTo = {characterId}; }
                else if (a.isGm) { visibility = "gm_only"; whisperTo.clear(); }
                else throw ApiError(400, "dice_error", "Hidden rolls need a character to speak as, so the result has someone to reach.");
            }
        }
        auto insert = [&](const std::string& vis, const std::vector<std::string>& to, const std::string& text, const Json::Value& dice) {
            return Db::queryOne(w,
                "INSERT INTO messages(channel_id, chat_window_id, scene_id, author_id, author_role, character_id, kind, content, visibility, whisper_to, dice) "
                "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid[],$11::jsonb) RETURNING id",
                {a.channelId, windowId, sceneId, a.userId, a.isGm ? "gm" : "player", characterId.empty() ? dbNull() : DbParam(characterId), kind, text, vis,
                 pgArrayLiteral(to), dice.isNull() ? dbNull() : DbParam(json::dump(dice))})["id"].asString();
        };
        auto messageId = insert(visibility, whisperTo, content, diceJson);
        for(const auto& id : references) if(Db::queryOne(w,MSG_SELECT+"WHERE m.id=$1 AND m.channel_id=$2 AND "+Visibility::messageFilter(a),{id,a.channelId}).isNull()) throw forbidden("Referenced chat is no longer accessible");
        Db::exec(w,"UPDATE messages SET reference_ids=$2::uuid[] WHERE id=$1",{messageId,pgArrayLiteral(references)});
        if (diceCmd && diceResult.hidden) {
            Json::Value nd; nd["type"] = "hidden_notice"; nd["command"] = diceCmd->raw; nd["text"] = diceResult.hiddenNotice;
            notice = Db::queryOne(w, MSG_SELECT + "WHERE m.id=$1", {insert("window", {}, diceCmd->raw, nd)});
        }
        // Sheet maintenance (.st/.en) is bookkeeping, not something that happened in the story.
        if (!diceCmd || diceResult.narrative) {
            // Audience = characters who can read this message in-fiction.
            std::vector<std::string> audience;
            std::string evVis = "window";
            if (visibility == "window") {
                for (auto& r : Db::queryJson(w, "SELECT character_id FROM chat_window_members WHERE chat_window_id=$1 AND character_id IS NOT NULL", {windowId}))
                    audience.push_back(r["character_id"].asString());
            } else if (visibility == "whisper") { audience = whisperTo; evVis = "whisper"; }
            else evVis = "gm_only";
            NewEvent e; e.channelId = a.channelId; e.chatWindowId = windowId; e.sceneId = sceneId; e.messageId = messageId;
            e.actorUserId = a.userId; e.actorRole = a.isGm ? "gm" : "player"; e.characterId = characterId; e.kind = "message.posted";
            e.visibility = evVis; e.audience = audience;
            e.payload["content"] = eventText; e.payload["message_kind"] = kind; e.payload["reference_message_ids"]=json::fromStrArray(references);
            if (diceCmd) { e.payload["command"] = content; e.payload["dice"] = diceJson; }
            events_.append(w, e);
        }
        return Db::queryOne(w, MSG_SELECT + "WHERE m.id=$1", {messageId});
    });
    notifier_.messagePosted(msg);
    if (!notice.isNull()) notifier_.messagePosted(notice);
    if (diceCmd) dice_.afterCommit(a, characterId, diceResult);
    return msg;
}

} // namespace acerciae
