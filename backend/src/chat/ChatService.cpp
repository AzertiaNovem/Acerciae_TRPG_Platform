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

namespace acerciae {

static const std::string MSG_SELECT =
    "SELECT m.*, c.name AS character_name, u.display_name AS author_name, CASE WHEN u.avatar_data<>'' THEN u.avatar_version ELSE 0 END AS author_avatar_version FROM messages m "
    "LEFT JOIN characters c ON c.id=m.character_id LEFT JOIN users u ON u.id=m.author_id ";

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
Json::Value ChatService::joinServer(const Principal& p, const std::string& serverId) {
    auto s = db_.queryOne("SELECT * FROM servers WHERE id=$1", {serverId});
    if (s.isNull()) throw notFound("server not found");
    db_.exec("INSERT INTO server_members(server_id, user_id, role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING", {serverId, p.userId});
    s["my_role"] = "member";
    return s;
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
    if (self) { Json::Value v; v["ok"] = true; return v; }
    return serverMembers(p, serverId);
}
Json::Value ChatService::serverMembers(const Principal& p, const std::string& serverId) {
    auth_.requireServerMember(p.userId, serverId);
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
Json::Value ChatService::createChannel(const Principal& p, const std::string& serverId, const Json::Value& body) {
    auth_.requireServerMember(p.userId, serverId);
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
    db_.exec("UPDATE channels SET name=$2, description=$3, knowledge_mode=$4, ai_enabled=$5, dice_text_group=$6 WHERE id=$1",
        {a.channelId, json::str(body, "name", cur["name"].asString()), json::str(body, "description", cur["description"].asString()), mode, json::toBool(body, "ai_enabled", cur["ai_enabled"].asBool()), group});
    return getChannel(a);
}
Json::Value ChatService::addChannelMember(const ChannelAccess& a, const std::string& user, const std::string& role) {
    auth_.requireGm(a);
    if (role != "gm" && role != "player") throw badRequest("role must be gm or player");
    auto u = findUser(user);
    auto uid = u["id"].asString();
    bool inServer = !db_.queryOne("SELECT 1 AS ok FROM server_members WHERE server_id=$1 AND user_id=$2", {a.serverId, uid}).isNull();
    if (!inServer && !isServerMaintainer(a.userId, a.serverId)) throw badRequest("that user is not on this server yet — ask a server maintainer to invite them");
    std::string mainId;
    db_.tx([&](pqxx::work& w) {
        Db::exec(w, "INSERT INTO server_members(server_id, user_id, role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING", {a.serverId, uid});
        Db::exec(w, "INSERT INTO channel_members(channel_id, user_id, role) VALUES($1,$2,$3) ON CONFLICT (channel_id,user_id) DO UPDATE SET role=EXCLUDED.role", {a.channelId, uid, role});
        // Everyone joins the main window by default.
        auto main = Db::queryOne(w, "SELECT id FROM chat_windows WHERE channel_id=$1 AND kind='main' ORDER BY created_at LIMIT 1", {a.channelId});
        if (!main.isNull()) { mainId = main["id"].asString(); Db::exec(w, "INSERT INTO chat_window_members(chat_window_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", {mainId, uid}); }
    });
    if (!mainId.empty()) notifier_.windowChanged(a.channelId, db_.queryOne("SELECT * FROM chat_windows WHERE id=$1", {mainId}));
    u["role"] = role;
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
    });
    for (auto& wid : windows) notifier_.windowChanged(a.channelId, db_.queryOne("SELECT * FROM chat_windows WHERE id=$1", {wid}));
    return channelMembers(a);
}
Json::Value ChatService::channelMembers(const ChannelAccess& a) {
    return db_.queryJson(
        "SELECT u.id, u.username, u.display_name, cm.role, "
        "(SELECT json_agg(json_build_object('id', ch.id, 'name', ch.name)) FROM characters ch WHERE ch.channel_id=cm.channel_id AND ch.user_id=u.id) AS characters "
        "FROM channel_members cm JOIN users u ON u.id=cm.user_id WHERE cm.channel_id=$1 ORDER BY cm.role, cm.joined_at", {a.channelId});
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
        "(SELECT max(seq) FROM messages m WHERE m.chat_window_id=w.id) AS last_seq "
        "FROM chat_windows w LEFT JOIN scenes s ON s.id=w.active_scene_id WHERE w.channel_id=$1";
    if (!a.isGm) sql += " AND EXISTS (SELECT 1 FROM chat_window_members wm2 JOIN player_group_members pm ON pm.user_id=wm2.user_id WHERE pm.channel_id=w.channel_id AND pm.group_id=$2::uuid AND wm2.chat_window_id=w.id) AND " + Visibility::groupGuard(a);
    sql += " ORDER BY w.created_at";
    DbParams p{a.channelId}; if (!a.isGm) p.push_back(a.playerGroupId.empty()?dbNull():DbParam(a.playerGroupId));
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
        auto sceneId = json::str(body, "scene_id");
        if (!sceneId.empty()) {
            Db::exec(w, "UPDATE chat_windows SET active_scene_id=$2 WHERE id=$1", {wid, sceneId});
            Db::exec(w, "INSERT INTO chat_window_scenes(chat_window_id, scene_id) VALUES($1,$2) ON CONFLICT DO NOTHING", {wid, sceneId});
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
