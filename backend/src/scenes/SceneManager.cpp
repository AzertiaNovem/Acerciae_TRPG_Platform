#include "SceneManager.h"
#include "../events/EventStore.h"
#include "../ws/Notifier.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../knowledge/Visibility.h"

namespace acerciae {

Json::Value SceneManager::list(const ChannelAccess& a) {
    if(!a.isGm) return db_.queryJson("SELECT s.id,s.channel_id,'Scene '||s.sequence AS title,s.sequence,s.status,count(e.id) AS event_count FROM scenes s JOIN events e ON e.scene_id=s.id WHERE s.channel_id=$1 AND "+Visibility::eventFilter(a)+" GROUP BY s.id ORDER BY s.sequence",{a.channelId});
    return db_.queryJson(
        "SELECT s.*, (SELECT count(*) FROM events e WHERE e.scene_id=s.id) AS event_count, "
        "(SELECT json_agg(json_build_object('chat_window_id', ws.chat_window_id, 'name', cw.name)) FROM chat_window_scenes ws JOIN chat_windows cw ON cw.id=ws.chat_window_id WHERE ws.scene_id=s.id) AS windows "
        "FROM scenes s WHERE s.channel_id=$1 ORDER BY s.sequence, s.created_at", {a.channelId});
}
Json::Value SceneManager::get(const ChannelAccess& a, const std::string& sceneId) {
    if(!a.isGm) { for(const auto& scene : list(a)) if(scene["id"].asString()==sceneId) return scene; throw notFound("scene not found"); }
    auto s = db_.queryOne("SELECT * FROM scenes WHERE id=$1 AND channel_id=$2", {sceneId, a.channelId});
    if (s.isNull()) throw notFound("scene not found");
    return s;
}
Json::Value SceneManager::create(const ChannelAccess& a, const Json::Value& body) {
    if (!a.isGm) throw forbidden("GM role required");
    auto title = json::requireStr(body, "title");
    auto s = db_.tx([&](pqxx::work& w) {
        Db::exec(w, "SELECT 1 FROM channels WHERE id=$1 FOR UPDATE", {a.channelId});   // serialises sequence numbers
        auto row = Db::queryOne(w,
            "INSERT INTO scenes(channel_id, title, location, narrative_time, summary, sequence) "
            "VALUES($1,$2,$3,$4,$5,(SELECT coalesce(max(sequence),0)+1 FROM scenes WHERE channel_id=$1)) RETURNING *",
            {a.channelId, title, json::str(body, "location"), json::str(body, "narrative_time"), json::str(body, "summary")});
        NewEvent e; e.channelId = a.channelId; e.sceneId = row["id"].asString(); e.actorUserId = a.userId; e.actorRole = "gm";
        e.kind = "scene.created"; e.visibility = "public";
        e.payload["title"] = title; e.payload["location"] = json::str(body, "location");
        e.payload["content"] = "Scene created: " + title + (json::str(body, "location").empty() ? "" : " @ " + json::str(body, "location"));
        events_.append(w, e);
        return row;
    });
    notifier_.sceneChanged(a.channelId, s);
    return s;
}
Json::Value SceneManager::update(const ChannelAccess& a, const std::string& sceneId, const Json::Value& body) {
    if (!a.isGm) throw forbidden("GM role required");
    auto cur = get(a, sceneId);
    auto s = db_.tx([&](pqxx::work& w) {
        auto row = Db::queryOne(w,
            "UPDATE scenes SET title=$3, location=$4, narrative_time=$5, summary=$6, off_module=$7, summary_status=CASE WHEN $6<>summary THEN 'gm_edited' ELSE summary_status END WHERE id=$1 AND channel_id=$2 RETURNING *",
            {sceneId, a.channelId, json::str(body, "title", cur["title"].asString()), json::str(body, "location", cur["location"].asString()),
             json::str(body, "narrative_time", cur["narrative_time"].asString()), json::str(body, "summary", cur["summary"].asString()),
             json::toBool(body, "off_module", cur["off_module"].asBool())});
        NewEvent e; e.channelId = a.channelId; e.sceneId = sceneId; e.actorUserId = a.userId; e.actorRole = "gm"; e.kind = "scene.updated"; e.visibility = "public";
        e.payload["content"] = "Scene updated: " + row["title"].asString() + " @ " + row["location"].asString() + " (" + row["narrative_time"].asString() + ")";
        e.payload["location"] = row["location"]; e.payload["narrative_time"] = row["narrative_time"];
        events_.append(w, e);
        return row;
    });
    notifier_.sceneChanged(a.channelId, s);
    return s;
}
Json::Value SceneManager::close(const ChannelAccess& a, const std::string& sceneId) {
    if (!a.isGm) throw forbidden("GM role required");
    get(a, sceneId);
    auto s = db_.tx([&](pqxx::work& w) {
        auto row = Db::queryOne(w, "UPDATE scenes SET status='closed', closed_at=now() WHERE id=$1 AND channel_id=$2 RETURNING *", {sceneId, a.channelId});
        NewEvent e; e.channelId = a.channelId; e.sceneId = sceneId; e.actorUserId = a.userId; e.actorRole = "gm"; e.kind = "scene.closed"; e.visibility = "public";
        e.payload["content"] = "Scene closed: " + row["title"].asString();
        events_.append(w, e);
        return row;
    });
    notifier_.sceneChanged(a.channelId, s);
    return s;
}
std::string SceneManager::moveChannel(pqxx::work& w, const std::string& channelId, const std::string& sceneId, const std::string& actorUserId, const std::string& note) {
    auto ch = Db::queryOne(w, "SELECT current_scene_id FROM channels WHERE id=$1 FOR UPDATE", {channelId});
    std::string previous = ch.isNull() || ch["current_scene_id"].isNull() ? "" : ch["current_scene_id"].asString();
    if (previous == sceneId) return previous;
    auto scene = Db::queryOne(w, "SELECT * FROM scenes WHERE id=$1 AND channel_id=$2", {sceneId, channelId});
    if (scene.isNull()) throw notFound("scene not found");
    if (scene["status"].asString() == "closed") throw conflict("a closed scenario can only be consulted, not entered again");
    if (!previous.empty()) Db::exec(w, "UPDATE scenes SET status='closed', closed_at=now() WHERE id=$1 AND status='active'", {previous});
    Db::exec(w, "UPDATE channels SET current_scene_id=$2 WHERE id=$1", {channelId, sceneId});
    Db::exec(w, "UPDATE chat_windows SET active_scene_id=$2 WHERE channel_id=$1", {channelId, sceneId});
    Db::exec(w, "INSERT INTO chat_window_scenes(chat_window_id, scene_id) SELECT id, $2 FROM chat_windows WHERE channel_id=$1 ON CONFLICT DO NOTHING", {channelId, sceneId});
    for (auto& win : Db::queryJson(w, "SELECT id FROM chat_windows WHERE channel_id=$1", {channelId})) {
        auto wid = win["id"].asString();
        std::vector<std::string> audience;
        for (auto& m : Db::queryJson(w, "SELECT character_id FROM chat_window_members WHERE chat_window_id=$1 AND character_id IS NOT NULL", {wid})) audience.push_back(m["character_id"].asString());
        NewEvent e; e.channelId = channelId; e.chatWindowId = wid; e.sceneId = sceneId; e.actorUserId = actorUserId; e.actorRole = actorUserId.empty() ? "system" : "gm";
        e.kind = "scene.entered"; e.visibility = "window"; e.audience = audience;
        e.payload["content"] = note + scene["title"].asString() + (scene["location"].asString().empty() ? "" : " at " + scene["location"].asString());
        e.payload["scene_title"] = scene["title"]; e.payload["location"] = scene["location"]; e.payload["previous_scene_id"] = previous;
        events_.append(w, e);
    }
    return previous;
}
Json::Value SceneManager::enterScene(const ChannelAccess& a, const std::string& sceneId) {
    if (!a.isGm) throw forbidden("GM role required");
    get(a, sceneId);
    auto out = db_.tx([&](pqxx::work& w) {
        auto previous = moveChannel(w, a.channelId, sceneId, a.userId, "The story enters: ");
        Json::Value r; r["scene"] = Db::queryOne(w, "SELECT * FROM scenes WHERE id=$1", {sceneId});
        r["previous"] = previous.empty() ? Json::Value() : Db::queryOne(w, "SELECT * FROM scenes WHERE id=$1", {previous});
        r["windows"] = Db::queryJson(w, "SELECT * FROM chat_windows WHERE channel_id=$1", {a.channelId});
        return r;
    });
    if (!out["previous"].isNull()) notifier_.sceneChanged(a.channelId, out["previous"]);
    notifier_.sceneChanged(a.channelId, out["scene"]);
    for (auto& win : out["windows"]) notifier_.windowChanged(a.channelId, win);
    return out;
}
std::string SceneManager::resolveSceneForWindow(pqxx::work& w, const std::string& channelId, const std::string& chatWindowId) {
    // Locked so that a message racing the Keeper's "next scenario" lands in one scenario or the other, never in a
    // just-closed one, and two first messages do not each open a scenario.
    auto ch = Db::queryOne(w, "SELECT c.current_scene_id, s.status FROM channels c LEFT JOIN scenes s ON s.id=c.current_scene_id WHERE c.id=$1 FOR NO KEY UPDATE OF c", {channelId});
    std::string sceneId;
    if (!ch.isNull() && !ch["current_scene_id"].isNull() && ch["status"].asString() == "active") sceneId = ch["current_scene_id"].asString();
    else {
        // No open scenario (or the Keeper closed the current one without opening the next): start a fresh one.
        auto row = Db::queryOne(w, "INSERT INTO scenes(channel_id, title, sequence) SELECT $1, CASE WHEN coalesce(max(sequence),0)=0 THEN 'Opening scene' ELSE 'Scenario ' || (max(sequence)+1)::text END, coalesce(max(sequence),0)+1 FROM scenes WHERE channel_id=$1 RETURNING id", {channelId});
        sceneId = row["id"].asString();
        Db::exec(w, "UPDATE channels SET current_scene_id=$2 WHERE id=$1", {channelId, sceneId});
        Db::exec(w, "UPDATE chat_windows SET active_scene_id=$2 WHERE channel_id=$1", {channelId, sceneId});
        Db::exec(w, "INSERT INTO chat_window_scenes(chat_window_id, scene_id) SELECT id, $2 FROM chat_windows WHERE channel_id=$1 ON CONFLICT DO NOTHING", {channelId, sceneId});
        return sceneId;
    }
    Db::exec(w, "UPDATE chat_windows SET active_scene_id=$2 WHERE id=$1 AND active_scene_id IS DISTINCT FROM $2", {chatWindowId, sceneId});
    Db::exec(w, "INSERT INTO chat_window_scenes(chat_window_id, scene_id) VALUES($1,$2) ON CONFLICT DO NOTHING", {chatWindowId, sceneId});
    return sceneId;
}
Json::Value SceneManager::sceneLog(const ChannelAccess& a, const std::string& sceneId, int limit, int64_t afterSeq) {
    get(a, sceneId);
    return db_.queryJson(
        "SELECT e.id, e.kind, e.seq, e.chat_window_id, e.message_id, e.character_id, e.actor_role, e.created_at, e.payload, c.name AS character_name "
        "FROM events e LEFT JOIN characters c ON c.id=e.character_id WHERE e.channel_id=$1 AND e.scene_id=$2 AND e.seq > $3 AND " + Visibility::eventFilter(a) +
        " ORDER BY e.seq LIMIT $4", {a.channelId, sceneId, afterSeq, (int64_t)std::max(1, std::min(limit, 500))});
}

} // namespace acerciae
