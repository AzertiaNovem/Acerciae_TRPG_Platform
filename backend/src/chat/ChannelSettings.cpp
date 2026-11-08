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
        "(SELECT count(*) FROM messages m WHERE m.channel_id=c.id AND m.recalled_at IS NULL)::int AS message_count FROM channels c WHERE c.server_id=$1 ORDER BY c.created_at", {serverId});
}
Json::Value ChatService::createChannel(const Principal& p, const std::string& serverId, const Json::Value& body) {
    auth_.requireServerMember(p.userId, serverId);
    auto role = serverRole(db_, serverId, p.userId);
    if (role == "guest") throw forbidden("guests cannot create channels");
    if (role == "member" && policy(serverId).channelCreation == "maintainers") throw forbidden("on this server only maintainers create channels");
    auto name = json::requireStr(body, "name");
    auto mode = json::str(body, "knowledge_mode", "isolated");
    if (mode != "public" && mode != "isolated") throw badRequest("knowledge_mode must be public or isolated");
    auto ruleSystem = rules::canonical(json::str(body, "rule_system", "coc7e"));
    if (ruleSystem.empty()) throw badRequest("rule_system must be coc7e, dnd2024 or pbta");
    auto ch = db_.tx([&](pqxx::work& w) {
        auto c = Db::queryOne(w, "INSERT INTO channels(server_id, name, description, rule_system, knowledge_mode, point_buy) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            {serverId, name, json::str(body, "description"), ruleSystem, mode, json::toBool(body, "point_buy")});
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
// The GM's per-channel AI switches (consistency_enabled, inspiration_enabled, illustrations_enabled, …): 403
// feature_disabled when off.
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
    for (const auto* key : {"point_buy", "ai_enabled", "auto_scenarios", "studio_visible", "studio_player_access",
                            "consistency_enabled", "inspiration_enabled", "atmosphere_enabled", "illustrations_enabled"})
        if (body.isMember(key) && !body[key].isBool()) throw badRequest(std::string(key) + " must be boolean");
    auto flag = [&](const char* k) { return json::toBool(body, k, cur[k].asBool()); };
    // The rule system decides the dice commands, the character sheet and how the AI names the game and the GM; point
    // buy makes role cards follow the system's character-creation budget. Both are the GM's to change at any time.
    // A change of rule system is a transition, in one transaction with it: every character keeps its story, the numbers
    // and dice values of the old system go to a read-only archive on its card, and the players are asked (in the main
    // window, and on the cards) to rebuild their characters' numbers for the new system.
    Json::Value transition, message;
    db_.tx([&](pqxx::work& w) {
        const auto from = Db::queryOne(w, "SELECT rule_system FROM channels WHERE id=$1 FOR UPDATE", {a.channelId})["rule_system"].asString();
        const auto ruleSystem = rules::canonical(json::str(body, "rule_system", from));
        if (ruleSystem.empty()) throw badRequest("rule_system must be coc7e, dnd2024 or pbta");
        Db::exec(w, "UPDATE channels SET rule_system=$2, point_buy=$3 WHERE id=$1", {a.channelId, ruleSystem, flag("point_buy")});
        Db::exec(w, "UPDATE channels SET name=$2, description=$3, knowledge_mode=$4, ai_enabled=$5, dice_text_group=$6, auto_scenarios=$7, era=$8, studio_visible=$9, studio_player_access=$10, "
                 "consistency_enabled=$11, inspiration_enabled=$12, atmosphere_enabled=$13, illustrations_enabled=$14 WHERE id=$1",
            {a.channelId, json::str(body, "name", cur["name"].asString()), json::str(body, "description", cur["description"].asString()), mode, flag("ai_enabled"), group, flag("auto_scenarios"), text::utf8Prefix(json::str(body, "era", cur["era"].asString()), 80), flag("studio_visible"), flag("studio_player_access"),
             flag("consistency_enabled"), flag("inspiration_enabled"), flag("atmosphere_enabled"), flag("illustrations_enabled")});
        if (from == ruleSystem) return;
        transition = CharacterSpaceService::transitionCards(w, a.channelId, from, ruleSystem, a.userId);
        auto main = Db::queryOne(w, "SELECT id FROM chat_windows WHERE channel_id=$1 AND kind='main' ORDER BY created_at LIMIT 1", {a.channelId});
        if (main.isNull()) return;
        auto texts = dice_.textsForChannel(w, a.channelId);
        const auto name = [&](const std::string& rs) { return texts.render("rules.name." + rs, {}); };
        std::string content = texts.render("rules.changed", {{"from", name(from)}, {"to", name(ruleSystem)}});
        std::vector<std::string> names; for (const auto& r : transition["rebuild"]) names.push_back(r["name"].asString());
        if (!names.empty()) content += "\n" + texts.render("rules.rebuild", {{"to", name(ruleSystem)}, {"list", text::join(names, ", ")}});
        message = postSystemMessage(w, a.channelId, main["id"].asString(), a.userId, content);
    });
    notifier_.channelUpdated(a.channelId);
    if (!message.isNull()) notifier_.messagePosted(message);
    auto out = getChannel(a);
    if (!transition.isNull()) {
        for (const auto& row : transition["rows"]) notifier_.characterUpdated(a.channelId, row);
        transition.removeMember("rows");
        out["rule_transition"] = transition;
    }
    return out;
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
    auto c = db_.queryOne("SELECT c.server_id, s.suspended_at FROM channels c JOIN servers s ON s.id=c.server_id WHERE c.id=$1", {channelId});
    if (c.isNull() || !c["suspended_at"].isNull()) return false;
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
    // Only lines every Main Chat participant sees; never whispers or GM-only lines.
    std::string sql = MSG_SELECT + "WHERE m.chat_window_id=$1 AND m.visibility='window'";
    DbParams params{win["id"].asString()};
    if (beforeSeq > 0) { sql += " AND m.seq < $2"; params.push_back(beforeSeq); }
    sql += " ORDER BY m.seq DESC LIMIT " + std::to_string(std::max(1, std::min(limit, 200)));
    for (auto m : db_.queryJson("SELECT * FROM (" + sql + ") x ORDER BY seq ASC", params)) out["messages"].append(spectatorMessage(m));
    return out;
}
Json::Value ChatService::spectatorMessage(Json::Value m) {
    // Character art lives in the channel's media library, which spectators cannot open.
    m["character_avatar_asset_id"] = Json::Value(); m["character_avatar_version"] = Json::Value(); m["character_avatar_hash"] = Json::Value();
    m.removeMember("whisper_to");
    m["media_asset_id"] = Json::Value();   // an illustration is served only to channel members who may read the line
    return m;
}

// ---- characters ------------------------------------------------------------------------------

} // namespace acerciae
