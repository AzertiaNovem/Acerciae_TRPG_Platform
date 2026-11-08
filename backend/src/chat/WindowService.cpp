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
static void insertWindowMembers(pqxx::work& w, const ChannelAccess& a, const std::string& wid, const Json::Value& members) {
    if (!members.isNull() && !members.isArray()) throw badRequest("members must be an array");
    Db::exec(w, "INSERT INTO chat_window_members(chat_window_id,user_id) VALUES($1,$2)", {wid,a.userId});
    for (const auto& m : members) {
        auto uid=json::requireStr(m,"user_id");
        if (!Visibility::isUuid(uid)) throw badRequest("invalid member id");
        auto cm=Db::queryOne(w,"SELECT role FROM channel_members WHERE channel_id=$1 AND user_id=$2",{a.channelId,uid});
        if (cm.isNull()) throw badRequest("user is not a channel member");
        auto cid=json::str(m,"character_id");
        if (!cid.empty()) {
            if (!Visibility::isUuid(cid) || Db::queryOne(w,"SELECT id FROM characters WHERE id=$1 AND channel_id=$2 AND user_id=$3",{cid,a.channelId,uid}).isNull())
                throw badRequest("character does not belong to this channel member");
        } else if (cm["role"]!="gm") {
            auto c=Db::queryOne(w,"SELECT id FROM characters WHERE channel_id=$1 AND user_id=$2 AND kind='pc' ORDER BY created_at LIMIT 1",{a.channelId,uid});
            if (!c.isNull()) cid=c["id"].asString();
        }
        Db::exec(w,"INSERT INTO chat_window_members(chat_window_id,user_id,character_id) VALUES($1,$2,$3) ON CONFLICT(chat_window_id,user_id) DO UPDATE SET character_id=EXCLUDED.character_id",
            {wid,uid,cid.empty()?dbNull():DbParam(cid)});
    }
}

Json::Value ChatService::listWindows(const ChannelAccess& a) {
    std::string sql =
        "SELECT w.*, " + std::string(a.isGm ? "s.title" : "NULL::text") + " AS scene_title, "
        "(SELECT json_agg(json_build_object('user_id', wm.user_id, 'character_id', wm.character_id, 'display_name', u.display_name, 'character_name', ch.name, 'visibility_paused', wm.visibility_paused)) "
        " FROM chat_window_members wm JOIN users u ON u.id=wm.user_id LEFT JOIN characters ch ON ch.id=wm.character_id WHERE wm.chat_window_id=w.id) AS members, "
        "(SELECT max(seq) FROM messages m WHERE m.chat_window_id=w.id) AS last_seq, "
        // Messages this viewer may read, posted by someone else after what they last read (counted up to 100). A
        // recalled line no longer counts.
        "(SELECT count(*) FROM (SELECT 1 FROM messages m WHERE m.chat_window_id=w.id AND m.author_id IS DISTINCT FROM $2::uuid AND m.recalled_at IS NULL "
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
    if (name.size()>240 || text::trim(name).empty()) throw badRequest("invalid window name");
    auto kind = json::str(body, "kind", "group");
    if (kind != "group" && kind != "private" && kind != "main") throw badRequest("kind must be main, group or private");
    auto win = db_.tx([&](pqxx::work& w) {
        auto row = Db::queryOne(w, "INSERT INTO chat_windows(channel_id, name, kind, created_by) VALUES($1,$2,$3,$4) RETURNING *", {a.channelId, name, kind, a.userId});
        auto wid = row["id"].asString();
        insertWindowMembers(w,a,wid,body["members"]);
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
Json::Value ChatService::forkWindow(const ChannelAccess& a, const std::string& parentId, const Json::Value& body) {
    auth_.requireGm(a);
    auto name=json::requireStr(body,"name");
    if (name.size()>240 || text::trim(name).empty()) throw badRequest("invalid window name");
    auto kind=json::str(body,"kind","group");
    if (kind!="group" && kind!="private") throw badRequest("a fork must be group or private");
    if (!body.isMember("members") || !body["members"].isArray()) throw badRequest("choose members for the fork");
    if (body.isMember("through_seq") && (!body["through_seq"].isInt64() || body["through_seq"].asInt64()<0)) throw badRequest("invalid fork sequence");
    auto key=json::str(body,"request_id");
    if (key.size()>160) throw badRequest("request_id too long");
    Json::Value intent;
    intent["name"]=name; intent["kind"]=kind; intent["members"]=body["members"];
    if (body.isMember("through_seq")) intent["through_seq"]=body["through_seq"];
    auto fingerprint=crypto::sha256Hex(json::dump(intent));
    auto win=db_.tx([&](pqxx::work& w) {
        // Serialise duplicate requests; coordinate the cut with posts to this window.
        Db::queryOne(w,"SELECT id FROM channels WHERE id=$1 FOR UPDATE",{a.channelId});
        auto parent=Db::queryOne(w,"SELECT * FROM chat_windows WHERE id=$1 AND channel_id=$2 FOR UPDATE",{parentId,a.channelId});
        if (parent.isNull()) throw notFound("chat window not found");
        if (!key.empty()) {
            auto existing=Db::queryOne(w,"SELECT * FROM chat_windows WHERE channel_id=$1 AND created_by=$2 AND fork_request_id=$3",{a.channelId,a.userId,key});
            if (!existing.isNull()) {
                if (existing["fork_parent_id"]!=parentId) throw conflict("request_id already used for another parent");
                if (existing["fork_request_fingerprint"]!=fingerprint) throw conflict("This fork request was already created with different settings; reopen the fork dialog to start another scene");
                return existing;
            }
        }
        auto history=Db::queryOne(w,WINDOW_HISTORY+"SELECT max(depth) AS depth,coalesce((SELECT max(m.seq) FROM messages m JOIN lineage l ON m.chat_window_id=l.id WHERE l.cutoff IS NULL OR m.seq<=l.cutoff),0) AS last_seq FROM lineage",{parentId});
        if (history["depth"].asInt()>=127) throw badRequest("window ancestry is too deep");
        auto cut=body.isMember("through_seq")?body["through_seq"].asInt64():history["last_seq"].asInt64();
        if (cut>history["last_seq"].asInt64()) throw badRequest("fork sequence exceeds the parent's history");
        auto row=Db::queryOne(w,"INSERT INTO chat_windows(channel_id,name,kind,created_by,fork_parent_id,fork_seq,fork_request_id,fork_request_fingerprint,active_scene_id) "
            "VALUES($1,$2,$3,$4,$5,$6,$7,$8,(SELECT current_scene_id FROM channels WHERE id=$1)) RETURNING *",
            {a.channelId,name,kind,a.userId,parentId,cut,key.empty()?dbNull():DbParam(key),key.empty()?dbNull():DbParam(fingerprint)});
        auto id=row["id"].asString();
        insertWindowMembers(w,a,id,body["members"]);
        if (!row["active_scene_id"].isNull()) Db::exec(w,"INSERT INTO chat_window_scenes(chat_window_id,scene_id) VALUES($1,$2)",{id,row["active_scene_id"].asString()});
        return row;
    });
    notifier_.windowChanged(a.channelId,win);
    return win;
}
Json::Value ChatService::updateWindow(const ChannelAccess& a, const std::string& windowId, const Json::Value& body) {
    auth_.requireGm(a);
    if (body.isMember("archived") && !body["archived"].isBool()) throw badRequest("archived must be a boolean");
    auto row=db_.tx([&](pqxx::work& w) {
        auto cur=Db::queryOne(w,"SELECT * FROM chat_windows WHERE id=$1 AND channel_id=$2 FOR UPDATE",{windowId,a.channelId});
        if (cur.isNull()) throw notFound("chat window not found");
        auto name=json::str(body,"name",cur["name"].asString());
        if (name.size()>240 || text::trim(name).empty()) throw badRequest("invalid window name");
        bool archive=body.isMember("archived")?body["archived"].asBool():!cur["archived_at"].isNull();
        if (cur["kind"]=="main" && archive) throw conflict("Main Chat remains available for public communication");
        return Db::queryOne(w,"UPDATE chat_windows SET name=$2,archived_at=CASE WHEN $3::boolean THEN coalesce(archived_at,now()) ELSE NULL END WHERE id=$1 RETURNING *",{windowId,name,archive});
    });
    notifier_.windowChanged(a.channelId,row);
    return row;
}
Json::Value ChatService::addWindowMember(const ChannelAccess& a, const std::string& windowId, const std::string& userId, const std::string& characterId) {
    auth_.requireGm(a);
    auth_.requireWindowMember(a, windowId);
    auto cm = db_.queryOne("SELECT role FROM channel_members WHERE channel_id=$1 AND user_id=$2", {a.channelId, userId});
    if (cm.isNull()) throw badRequest("user is not a channel member");
    std::string cid = characterId;
    // A GM speaks as any character; their GM-cast PCs are never their default identity in a window.
    if (cid.empty() && cm["role"].asString() != "gm") {
        auto c = db_.queryOne("SELECT id FROM characters WHERE channel_id=$1 AND user_id=$2 AND kind='pc' ORDER BY created_at LIMIT 1", {a.channelId, userId});
        if (!c.isNull()) cid = c["id"].asString();
    }
    if (!cid.empty() && (!Visibility::isUuid(cid) || db_.queryOne("SELECT id FROM characters WHERE id=$1 AND channel_id=$2 AND user_id=$3",{cid,a.channelId,userId}).isNull())) throw badRequest("character does not belong to this channel member");
    db_.tx([&](pqxx::work& w) {
        Db::queryOne(w,"SELECT id FROM channels WHERE id=$1 FOR NO KEY UPDATE",{a.channelId});
        auto win=Db::queryOne(w,"SELECT archived_at FROM chat_windows WHERE id=$1 FOR UPDATE",{windowId});
        if (!win["archived_at"].isNull()) throw conflict("Restore this window before adding participants");
        Db::exec(w,"INSERT INTO chat_window_members(chat_window_id,user_id,character_id,history_after_seq) VALUES($1,$2,$3,coalesce((SELECT max(seq) FROM messages WHERE chat_window_id=$1),0)) "
            "ON CONFLICT(chat_window_id,user_id) DO UPDATE SET character_id=EXCLUDED.character_id",
            {windowId,userId,cid.empty()?dbNull():DbParam(cid)});
    });
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
    return db_.queryJson("SELECT wm.user_id, wm.character_id, wm.visibility_paused, u.display_name, u.username, ch.name AS character_name FROM chat_window_members wm JOIN users u ON u.id=wm.user_id LEFT JOIN characters ch ON ch.id=wm.character_id WHERE wm.chat_window_id=$1", {windowId});
}
Json::Value ChatService::setWindowVisibility(const ChannelAccess& a, const std::string& windowId, const std::string& userId, const Json::Value& body) {
    auth_.requireGm(a);
    if (!body["paused"].isBool()) throw badRequest("paused must be a boolean");
    const bool paused=body["paused"].asBool();
    auto win=db_.tx([&](pqxx::work& w) {
        Db::queryOne(w,"SELECT id FROM channels WHERE id=$1 FOR NO KEY UPDATE",{a.channelId});
        auto row=Db::queryOne(w,"SELECT * FROM chat_windows WHERE id=$1 AND channel_id=$2 FOR UPDATE",{windowId,a.channelId});
        if (row.isNull()) throw notFound("chat window not found");
        if (row["kind"]=="main") throw conflict("Main Chat is public communication; use a scene window for restricted play");
        auto member=Db::queryOne(w,"SELECT wm.visibility_paused,cm.role FROM chat_window_members wm JOIN channel_members cm ON cm.channel_id=$3 AND cm.user_id=wm.user_id WHERE wm.chat_window_id=$1 AND wm.user_id=$2",{windowId,userId,a.channelId});
        if (member.isNull()) throw notFound("window member not found");
        if (member["role"]=="gm") throw badRequest("GM visibility cannot be paused");
        if (member["visibility_paused"].asBool()==paused) return row; // retries cannot shift an interval boundary
        auto cut=Db::queryOne(w,"SELECT coalesce(max(seq),0) AS seq FROM messages WHERE chat_window_id=$1",{windowId})["seq"].asInt64();
        if (paused) Db::exec(w,"UPDATE chat_window_member_periods SET through_seq=$3 WHERE chat_window_id=$1 AND user_id=$2 AND through_seq IS NULL",{windowId,userId,cut});
        else Db::exec(w,"INSERT INTO chat_window_member_periods(chat_window_id,user_id,after_seq) VALUES($1,$2,$3)",{windowId,userId,cut});
        Db::exec(w,"UPDATE chat_window_members SET visibility_paused=$3 WHERE chat_window_id=$1 AND user_id=$2",{windowId,userId,paused});
        return row;
    });
    notifier_.windowChanged(a.channelId,win);
    return windowMembers(a,windowId);
}

// ---- messages --------------------------------------------------------------------------------

} // namespace acerciae
