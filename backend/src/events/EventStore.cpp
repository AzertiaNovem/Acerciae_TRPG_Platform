#include "EventStore.h"
#include "../core/Json.h"
#include "../knowledge/Visibility.h"

namespace acerciae {

static DbParam opt(const std::string& s) { return s.empty() ? dbNull() : DbParam(s); }

Json::Value EventStore::append(pqxx::work& w, const NewEvent& e) {
    return Db::queryOne(w,
        "INSERT INTO events(channel_id, chat_window_id, scene_id, message_id, actor_user_id, actor_role, character_id, kind, payload, visibility, audience) "
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::uuid[]) RETURNING *",
        {e.channelId, opt(e.chatWindowId), opt(e.sceneId), opt(e.messageId), opt(e.actorUserId), e.actorRole,
         opt(e.characterId), e.kind, json::dump(e.payload), e.visibility, pgArrayLiteral(e.audience)});
}

Json::Value EventStore::append(const NewEvent& e) {
    return db_.tx([&](pqxx::work& w) { return append(w, e); });
}

Json::Value EventStore::get(const std::string& channelId, const std::string& eventId) {
    return db_.queryOne("SELECT * FROM events WHERE channel_id=$1 AND id=$2", {channelId, eventId});
}

Json::Value EventStore::listAfter(const std::string& channelId, int64_t afterSeq, int limit) {
    return db_.queryJson(
        "SELECT e.*, c.name AS character_name, u.display_name AS actor_name FROM events e "
        "LEFT JOIN characters c ON c.id=e.character_id LEFT JOIN users u ON u.id=e.actor_user_id "
        "WHERE e.channel_id=$1 AND e.seq > $2 ORDER BY e.seq ASC LIMIT $3",
        {channelId, (int64_t)afterSeq, (int64_t)limit});
}

Json::Value EventStore::search(const ChannelAccess& a, const std::string& query, const std::string& sceneId, int limit) {
    std::string sql =
        "SELECT e.id, e.kind, e.seq, e.scene_id, e.chat_window_id, e.character_id, e.created_at, e.payload, "
        "c.name AS character_name, s.title AS scene_title, "
        "ts_rank(to_tsvector('english', coalesce(e.payload->>'content','')), plainto_tsquery('english', $2)) AS rank "
        "FROM events e LEFT JOIN characters c ON c.id=e.character_id LEFT JOIN scenes s ON s.id=e.scene_id "
        "WHERE e.channel_id=$1 AND " + Visibility::eventFilter(a) +
        " AND (to_tsvector('english', coalesce(e.payload->>'content','')) @@ plainto_tsquery('english', $2) "
        "      OR coalesce(e.payload->>'content','') ILIKE '%' || $2 || '%')";
    DbParams p{a.channelId, query};
    if (!sceneId.empty()) { sql += " AND e.scene_id=$3"; p.push_back(sceneId); }
    sql += " ORDER BY rank DESC, e.seq DESC LIMIT " + std::to_string(limit);
    return db_.queryJson(sql, p);
}

Json::Value EventStore::listByIds(const ChannelAccess& a, const std::vector<std::string>& ids) {
    if (ids.empty()) return Json::Value(Json::arrayValue);
    return db_.queryJson(
        "SELECT e.id, e.kind, e.seq, e.scene_id, e.chat_window_id, e.message_id, e.character_id, e.created_at, e.payload, "
        "c.name AS character_name, s.title AS scene_title FROM events e "
        "LEFT JOIN characters c ON c.id=e.character_id LEFT JOIN scenes s ON s.id=e.scene_id "
        "WHERE e.channel_id=$1 AND e.id = ANY(" + Visibility::uuidArray(ids) + ") AND " + Visibility::eventFilter(a) + " ORDER BY e.seq",
        {a.channelId});
}

int64_t EventStore::maxSeq(const std::string& channelId) {
    auto r = db_.queryOne("SELECT coalesce(max(seq),0) AS s FROM events WHERE channel_id=$1", {channelId});
    return r.isNull() ? 0 : r["s"].asInt64();
}

} // namespace acerciae
