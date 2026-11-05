#include "AdminService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../knowledge/Visibility.h"
#include "../logstudio/ObjectStore.h"
#include "../ws/WsGateway.h"
#include <algorithm>

namespace acerciae {
namespace {

// Every stored object with its channel, kind and who made it. An asset's versions are each an object (the current one
// included), so versions are the source of truth and media_assets.bytes only stands in for an asset without any.
const char* kObjects =
    "objects AS ("
    "  SELECT m.channel_id, m.created_by, coalesce(v.bytes, m.bytes) AS bytes, coalesce(v.n, 1) AS n, "
    "         CASE WHEN m.mime LIKE 'image/%' THEN 'image' WHEN m.mime LIKE 'audio/%' THEN 'audio' WHEN m.mime LIKE 'video/%' THEN 'video' ELSE 'other' END AS kind "
    "  FROM media_assets m LEFT JOIN (SELECT asset_id, sum(bytes) AS bytes, count(*) AS n FROM asset_versions GROUP BY asset_id) v ON v.asset_id=m.id "
    "  UNION ALL SELECT channel_id, NULL, bytes, 1, 'image' FROM image_reference_objects "
    "  UNION ALL SELECT channel_id, NULL, bytes, 1, 'audio' FROM tts_audio_assets "
    "  UNION ALL SELECT channel_id, created_by, coalesce(bytes, 0), 1, 'pdf' FROM pdf_render_jobs WHERE object_key IS NOT NULL "
    "  UNION ALL SELECT channel_id, requested_by, coalesce(bytes, 0), 1, 'bundle' FROM vn_bundle_jobs WHERE object_key IS NOT NULL"
    ")";

// Bytes, objects and images per channel.
const char* kChannelUse =
    "channel_use AS ("
    "  SELECT channel_id, sum(bytes) AS bytes, sum(n) AS objects, sum(n) FILTER (WHERE kind='image') AS images, sum(bytes) FILTER (WHERE kind='image') AS image_bytes "
    "  FROM objects GROUP BY channel_id"
    ")";

std::string like(const std::string& q) {
    std::string out;
    for (char c : text::trim(q)) { if (c == '%' || c == '_' || c == '\\') out += '\\'; out += c; }
    return out;
}
int clampLimit(int limit) { return std::max(1, std::min(200, limit <= 0 ? 50 : limit)); }
int clampOffset(int offset) { return std::max(0, offset); }
std::string reasonOf(const Json::Value& body, bool required) {
    auto r = text::trim(json::str(body, "reason"));
    if (required && r.empty()) throw badRequest("a reason is required");
    if (r.size() > 500) throw badRequest("the reason must be at most 500 characters");
    return r;
}
Json::Value paged(Json::Value rows, int64_t total, int limit, int offset) {
    Json::Value out; out["rows"] = std::move(rows); out["total"] = (Json::Int64)total; out["limit"] = limit; out["offset"] = offset; return out;
}
} // namespace

Json::Value AdminService::overview(const Principal& p) {
    auth_.requireAdmin(p);
    Json::Value out;
    auto users = db_.queryOne(
        "SELECT count(*) AS total, count(*) FILTER (WHERE suspended_at IS NOT NULL) AS suspended, count(*) FILTER (WHERE is_admin) AS admins, "
        "count(*) FILTER (WHERE created_at > now() - interval '7 days') AS new_7d, count(*) FILTER (WHERE created_at > now() - interval '30 days') AS new_30d, "
        "(SELECT count(*) FROM auth_tokens WHERE expires_at > now()) AS active_sessions, "
        "(SELECT count(DISTINCT user_id) FROM auth_tokens WHERE created_at > now() - interval '7 days') AS signed_in_7d FROM users");
    users["listed_admins"] = Json::arrayValue;
    for (const auto& u : auth_.listedAdminUsernames()) users["listed_admins"].append(u);
    out["users"] = users;
    out["servers"] = db_.queryOne(
        "SELECT count(*) AS total, count(*) FILTER (WHERE suspended_at IS NOT NULL) AS suspended, "
        "count(*) FILTER (WHERE created_at > now() - interval '30 days') AS new_30d, "
        "(SELECT count(*) FROM channels) AS channels, (SELECT count(*) FROM messages) AS messages, "
        "(SELECT count(*) FROM messages WHERE created_at > now() - interval '7 days') AS messages_7d FROM servers");
    auto storage = db_.queryOne(std::string("WITH ") + kObjects +
        " SELECT coalesce(sum(bytes),0) AS bytes, coalesce(sum(n),0) AS objects, "
        " coalesce(sum(bytes) FILTER (WHERE kind='image'),0) AS image_bytes, coalesce(sum(n) FILTER (WHERE kind='image'),0) AS images, "
        " coalesce(sum(bytes) FILTER (WHERE kind='audio'),0) AS audio_bytes, coalesce(sum(n) FILTER (WHERE kind='audio'),0) AS audio, "
        " coalesce(sum(bytes) FILTER (WHERE kind='pdf'),0) AS pdf_bytes, coalesce(sum(n) FILTER (WHERE kind='pdf'),0) AS pdfs, "
        " coalesce(sum(bytes) FILTER (WHERE kind='bundle'),0) AS bundle_bytes, coalesce(sum(n) FILTER (WHERE kind='bundle'),0) AS bundles, "
        " coalesce(sum(bytes) FILTER (WHERE kind IN ('video','other')),0) AS other_bytes, coalesce(sum(n) FILTER (WHERE kind IN ('video','other')),0) AS other FROM objects");
    storage["store"] = store_.kind();
    storage["avatars"] = db_.queryOne("SELECT count(*) AS n FROM users WHERE avatar_key IS NOT NULL OR avatar_data<>''")["n"];
    storage["images_7d"] = db_.queryOne("SELECT count(*) AS n FROM media_assets WHERE mime LIKE 'image/%' AND created_at > now() - interval '7 days'")["n"];
    out["storage"] = storage;
    Json::Value database;
    database["bytes"] = db_.queryOne("SELECT pg_database_size(current_database()) AS b")["b"];
    database["tables"] = db_.queryJson(
        "SELECT relname AS name, pg_total_relation_size(relid) AS bytes, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 12");
    out["database"] = database;
    out["ai"] = db_.queryOne(
        "SELECT coalesce(sum(prompt_tokens + completion_tokens),0) AS tokens_30d, coalesce(sum(images),0) AS images_30d, "
        "count(DISTINCT server_id) AS servers_30d FROM ai_usage_records WHERE created_at > now() - interval '30 days'");
    out["recent_actions"] = actions(p, 8, 0)["rows"];
    return out;
}

Json::Value AdminService::servers(const Principal& p, const std::string& q, const std::string& sort, int limit, int offset) {
    auth_.requireAdmin(p);
    limit = clampLimit(limit); offset = clampOffset(offset);
    static const std::map<std::string, std::string> sorts = {
        {"created", "s.created_at DESC"}, {"storage", "bytes DESC NULLS LAST, s.created_at DESC"}, {"images", "images DESC NULLS LAST, s.created_at DESC"},
        {"members", "member_count DESC, s.created_at DESC"}, {"messages", "message_count DESC, s.created_at DESC"}, {"name", "lower(s.name), s.created_at"},
        {"suspended", "s.suspended_at DESC NULLS LAST, s.created_at DESC"}};
    auto it = sorts.find(sort); std::string order = it == sorts.end() ? sorts.at("storage") : it->second;
    const std::string where = " WHERE ($1='' OR s.name ILIKE '%' || $1 || '%' OR o.username ILIKE '%' || $1 || '%') ";
    auto total = db_.queryOne("SELECT count(*) AS n FROM servers s LEFT JOIN users o ON o.id=s.owner_id" + where, {like(q)})["n"].asInt64();
    auto rows = db_.queryJson(std::string("WITH ") + kObjects + ", " + kChannelUse +
        ", server_use AS (SELECT c.server_id, sum(u.bytes) AS bytes, sum(u.objects) AS objects, sum(u.images) AS images, sum(u.image_bytes) AS image_bytes FROM channels c JOIN channel_use u ON u.channel_id=c.id GROUP BY c.server_id) "
        "SELECT s.id, s.name, s.created_at, s.suspended_at IS NOT NULL AS suspended, s.suspended_reason, o.id AS owner_id, o.username AS owner_username, o.display_name AS owner_name, "
        " (SELECT count(*) FROM server_members m WHERE m.server_id=s.id AND m.role<>'guest') AS member_count, "
        " (SELECT count(*) FROM channels c WHERE c.server_id=s.id) AS channel_count, "
        " (SELECT count(*) FROM messages msg JOIN channels c ON c.id=msg.channel_id WHERE c.server_id=s.id) AS message_count, "
        " (SELECT max(msg.created_at) FROM messages msg JOIN channels c ON c.id=msg.channel_id WHERE c.server_id=s.id) AS last_message_at, "
        " coalesce(su.bytes,0) AS bytes, coalesce(su.objects,0) AS objects, coalesce(su.images,0) AS images, coalesce(su.image_bytes,0) AS image_bytes, "
        " (SELECT coalesce(sum(images),0) FROM ai_usage_records r WHERE r.server_id=s.id AND r.created_at > now() - interval '30 days') AS ai_images_30d, "
        " (SELECT coalesce(sum(prompt_tokens + completion_tokens),0) FROM ai_usage_records r WHERE r.server_id=s.id AND r.created_at > now() - interval '30 days') AS ai_tokens_30d "
        "FROM servers s LEFT JOIN users o ON o.id=s.owner_id LEFT JOIN server_use su ON su.server_id=s.id" + where +
        "ORDER BY " + order + " LIMIT $2 OFFSET $3", {like(q), (int64_t)limit, (int64_t)offset});
    return paged(rows, total, limit, offset);
}

Json::Value AdminService::users(const Principal& p, const std::string& q, const std::string& sort, int limit, int offset) {
    auth_.requireAdmin(p);
    limit = clampLimit(limit); offset = clampOffset(offset);
    static const std::map<std::string, std::string> sorts = {
        {"created", "u.created_at DESC"}, {"storage", "bytes DESC NULLS LAST, u.created_at DESC"}, {"images", "images DESC NULLS LAST, u.created_at DESC"},
        {"last_seen", "last_seen_at DESC NULLS LAST, u.created_at DESC"}, {"servers", "server_count DESC, u.created_at DESC"}, {"name", "lower(u.username)"},
        {"suspended", "u.suspended_at DESC NULLS LAST, u.created_at DESC"}};
    auto it = sorts.find(sort); std::string order = it == sorts.end() ? sorts.at("created") : it->second;
    const std::string where = " WHERE ($1='' OR u.username ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%') ";
    auto total = db_.queryOne("SELECT count(*) AS n FROM users u" + where, {like(q)})["n"].asInt64();
    auto rows = db_.queryJson(std::string("WITH ") + kObjects +
        ", user_use AS (SELECT created_by AS user_id, sum(bytes) AS bytes, sum(n) AS objects, sum(n) FILTER (WHERE kind='image') AS images, sum(bytes) FILTER (WHERE kind='image') AS image_bytes FROM objects WHERE created_by IS NOT NULL GROUP BY created_by) "
        "SELECT u.id, u.username, u.display_name, u.created_at, u.is_admin, u.suspended_at IS NOT NULL AS suspended, u.suspended_reason, "
        " (SELECT max(created_at) FROM auth_tokens t WHERE t.user_id=u.id) AS last_seen_at, "
        " (SELECT count(*) FROM server_members m WHERE m.user_id=u.id AND m.role<>'guest') AS server_count, "
        " (SELECT count(*) FROM servers s WHERE s.owner_id=u.id) AS owned_count, "
        " (SELECT count(*) FROM messages msg WHERE msg.author_id=u.id) AS message_count, "
        " coalesce(uu.bytes,0) AS bytes, coalesce(uu.objects,0) AS objects, coalesce(uu.images,0) AS images, coalesce(uu.image_bytes,0) AS image_bytes "
        "FROM users u LEFT JOIN user_use uu ON uu.user_id=u.id" + where + "ORDER BY " + order + " LIMIT $2 OFFSET $3", {like(q), (int64_t)limit, (int64_t)offset});
    for (auto& r : rows) { r["listed_admin"] = auth_.listedAdmin(r["username"].asString()); r["is_admin"] = r["is_admin"].asBool() || r["listed_admin"].asBool(); }
    return paged(rows, total, limit, offset);
}

Json::Value AdminService::serverRow(const std::string& serverId) {
    auto rows = db_.queryJson(std::string("WITH ") + kObjects + ", " + kChannelUse +
        " SELECT s.id, s.name, s.created_at, s.suspended_at, s.suspended_at IS NOT NULL AS suspended, s.suspended_reason, sb.username AS suspended_by_name, "
        " o.id AS owner_id, o.username AS owner_username, o.display_name AS owner_name, "
        " (SELECT count(*) FROM server_members m WHERE m.server_id=s.id AND m.role<>'guest') AS member_count, "
        " (SELECT count(*) FROM channels c WHERE c.server_id=s.id) AS channel_count, "
        " (SELECT count(*) FROM messages msg JOIN channels c ON c.id=msg.channel_id WHERE c.server_id=s.id) AS message_count, "
        " (SELECT max(msg.created_at) FROM messages msg JOIN channels c ON c.id=msg.channel_id WHERE c.server_id=s.id) AS last_message_at, "
        " (SELECT coalesce(sum(u.bytes),0) FROM channels c JOIN channel_use u ON u.channel_id=c.id WHERE c.server_id=s.id) AS bytes, "
        " (SELECT coalesce(sum(u.objects),0) FROM channels c JOIN channel_use u ON u.channel_id=c.id WHERE c.server_id=s.id) AS objects, "
        " (SELECT coalesce(sum(u.images),0) FROM channels c JOIN channel_use u ON u.channel_id=c.id WHERE c.server_id=s.id) AS images, "
        " (SELECT coalesce(sum(u.image_bytes),0) FROM channels c JOIN channel_use u ON u.channel_id=c.id WHERE c.server_id=s.id) AS image_bytes, "
        " (SELECT coalesce(sum(images),0) FROM ai_usage_records r WHERE r.server_id=s.id AND r.created_at > now() - interval '30 days') AS ai_images_30d, "
        " (SELECT coalesce(sum(prompt_tokens + completion_tokens),0) FROM ai_usage_records r WHERE r.server_id=s.id AND r.created_at > now() - interval '30 days') AS ai_tokens_30d "
        "FROM servers s LEFT JOIN users o ON o.id=s.owner_id LEFT JOIN users sb ON sb.id=s.suspended_by WHERE s.id=$1", {serverId});
    if (rows.empty()) throw notFound("server not found");
    return rows[0];
}

Json::Value AdminService::server(const Principal& p, const std::string& serverId) {
    auth_.requireAdmin(p);
    if (!Visibility::isUuid(serverId)) throw notFound("server not found");
    auto out = serverRow(serverId);
    out["channels"] = db_.queryJson(std::string("WITH ") + kObjects + ", " + kChannelUse +
        " SELECT c.id, c.name, c.rule_system, c.created_at, c.story_status, coalesce(u.bytes,0) AS bytes, coalesce(u.objects,0) AS objects, coalesce(u.images,0) AS images, "
        " (SELECT count(*) FROM channel_members cm WHERE cm.channel_id=c.id) AS member_count, (SELECT count(*) FROM messages m WHERE m.channel_id=c.id) AS message_count, "
        " (SELECT max(created_at) FROM messages m WHERE m.channel_id=c.id) AS last_message_at "
        "FROM channels c LEFT JOIN channel_use u ON u.channel_id=c.id WHERE c.server_id=$1 ORDER BY bytes DESC, c.created_at", {serverId});
    out["members"] = db_.queryJson(
        "SELECT u.id, u.username, u.display_name, m.role, m.joined_at, u.suspended_at IS NOT NULL AS suspended FROM server_members m JOIN users u ON u.id=m.user_id "
        "WHERE m.server_id=$1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, m.joined_at LIMIT 500", {serverId});
    out["actions"] = db_.queryJson("SELECT id, admin_name, action, reason, created_at FROM admin_actions WHERE target_type='server' AND target_id=$1 ORDER BY created_at DESC LIMIT 50", {serverId});
    return out;
}

Json::Value AdminService::userRow(const std::string& userId) {
    auto rows = db_.queryJson(std::string("WITH ") + kObjects +
        " SELECT u.id, u.username, u.display_name, u.created_at, u.is_admin, u.suspended_at, u.suspended_at IS NOT NULL AS suspended, u.suspended_reason, sb.username AS suspended_by_name, "
        " (SELECT max(created_at) FROM auth_tokens t WHERE t.user_id=u.id) AS last_seen_at, (SELECT count(*) FROM auth_tokens t WHERE t.user_id=u.id AND t.expires_at > now()) AS sessions, "
        " (SELECT count(*) FROM server_members m WHERE m.user_id=u.id AND m.role<>'guest') AS server_count, (SELECT count(*) FROM servers s WHERE s.owner_id=u.id) AS owned_count, "
        " (SELECT count(*) FROM messages msg WHERE msg.author_id=u.id) AS message_count, (SELECT count(*) FROM characters ch WHERE ch.user_id=u.id) AS character_count, "
        " (SELECT coalesce(sum(bytes),0) FROM objects o WHERE o.created_by=u.id) AS bytes, (SELECT coalesce(sum(n),0) FROM objects o WHERE o.created_by=u.id) AS objects, "
        " (SELECT coalesce(sum(n),0) FROM objects o WHERE o.created_by=u.id AND kind='image') AS images, (SELECT coalesce(sum(bytes),0) FROM objects o WHERE o.created_by=u.id AND kind='image') AS image_bytes "
        "FROM users u LEFT JOIN users sb ON sb.id=u.suspended_by WHERE u.id=$1", {userId});
    if (rows.empty()) throw notFound("user not found");
    auto r = rows[0];
    r["listed_admin"] = auth_.listedAdmin(r["username"].asString()); r["is_admin"] = r["is_admin"].asBool() || r["listed_admin"].asBool();
    return r;
}

Json::Value AdminService::user(const Principal& p, const std::string& userId) {
    auth_.requireAdmin(p);
    if (!Visibility::isUuid(userId)) throw notFound("user not found");
    auto out = userRow(userId);
    out["servers"] = db_.queryJson(
        "SELECT s.id, s.name, m.role, m.joined_at, s.suspended_at IS NOT NULL AS suspended, "
        " (SELECT count(*) FROM channel_members cm JOIN channels c ON c.id=cm.channel_id WHERE c.server_id=s.id AND cm.user_id=$1) AS channel_count "
        "FROM server_members m JOIN servers s ON s.id=m.server_id WHERE m.user_id=$1 ORDER BY m.joined_at", {userId});
    out["actions"] = db_.queryJson("SELECT id, admin_name, action, reason, created_at FROM admin_actions WHERE target_type='user' AND target_id=$1 ORDER BY created_at DESC LIMIT 50", {userId});
    return out;
}

void AdminService::record(pqxx::work& w, const Principal& p, const char* action, const char* targetType, const std::string& targetId, const std::string& targetName, const std::string& reason) {
    Db::exec(w, "INSERT INTO admin_actions(admin_id, admin_name, action, target_type, target_id, target_name, reason) VALUES($1,$2,$3,$4,$5,$6,$7)",
             {p.userId, p.username, std::string(action), std::string(targetType), targetId, targetName, reason});
}

Json::Value AdminService::suspendServer(const Principal& p, const std::string& serverId, const Json::Value& body) {
    auth_.requireAdmin(p);
    if (!Visibility::isUuid(serverId)) throw notFound("server not found");
    if (!body.isObject() || !body["suspended"].isBool()) throw badRequest("suspended must be true or false");
    bool suspend = body["suspended"].asBool();
    auto reason = reasonOf(body, suspend);
    std::vector<std::string> channels;
    db_.tx([&](pqxx::work& w) {
        auto s = Db::queryOne(w, "SELECT name, suspended_at FROM servers WHERE id=$1 FOR UPDATE", {serverId});
        if (s.isNull()) throw notFound("server not found");
        bool now = !s["suspended_at"].isNull();
        if (now == suspend) return;   // already in that state: nothing to record
        if (suspend) Db::exec(w, "UPDATE servers SET suspended_at=now(), suspended_reason=$2, suspended_by=$3 WHERE id=$1", {serverId, reason, p.userId});
        else Db::exec(w, "UPDATE servers SET suspended_at=NULL, suspended_reason='', suspended_by=NULL WHERE id=$1", {serverId});
        record(w, p, suspend ? "suspend_server" : "unsuspend_server", "server", serverId, s["name"].asString(), reason);
        if (suspend) for (const auto& c : Db::queryJson(w, "SELECT id FROM channels WHERE server_id=$1", {serverId})) channels.push_back(c["id"].asString());
    });
    // Nobody follows a suspended server's channels any more (members and spectators alike).
    for (const auto& c : channels) WsGateway::instance().dropChannel(c);
    return serverRow(serverId);
}

Json::Value AdminService::suspendUser(const Principal& p, const std::string& userId, const Json::Value& body) {
    auth_.requireAdmin(p);
    if (!Visibility::isUuid(userId)) throw notFound("user not found");
    if (!body.isObject() || !body["suspended"].isBool()) throw badRequest("suspended must be true or false");
    bool suspend = body["suspended"].asBool();
    auto reason = reasonOf(body, suspend);
    if (suspend && userId == p.userId) throw badRequest("you cannot suspend your own account");
    bool changed = false;
    db_.tx([&](pqxx::work& w) {
        auto u = Db::queryOne(w, "SELECT username, suspended_at FROM users WHERE id=$1 FOR UPDATE", {userId});
        if (u.isNull()) throw notFound("user not found");
        if (suspend && auth_.listedAdmin(u["username"].asString())) throw badRequest("this account is named in PLATFORM_ADMINS; remove it there first");
        bool now = !u["suspended_at"].isNull();
        if (now == suspend) return;
        if (suspend) Db::exec(w, "UPDATE users SET suspended_at=now(), suspended_reason=$2, suspended_by=$3 WHERE id=$1", {userId, reason, p.userId});
        else Db::exec(w, "UPDATE users SET suspended_at=NULL, suspended_reason='', suspended_by=NULL WHERE id=$1", {userId});
        record(w, p, suspend ? "suspend_user" : "unsuspend_user", "user", userId, u["username"].asString(), reason);
        changed = true;
    });
    if (suspend && changed) auth_.revokeUserSessions(userId);
    return userRow(userId);
}

Json::Value AdminService::setAdmin(const Principal& p, const std::string& userId, const Json::Value& body) {
    auth_.requireAdmin(p);
    if (!Visibility::isUuid(userId)) throw notFound("user not found");
    if (!body.isObject() || !body["admin"].isBool()) throw badRequest("admin must be true or false");
    bool admin = body["admin"].asBool();
    auto reason = reasonOf(body, false);
    if (!admin && userId == p.userId) throw badRequest("you cannot revoke your own administrator role");
    db_.tx([&](pqxx::work& w) {
        auto u = Db::queryOne(w, "SELECT username, is_admin FROM users WHERE id=$1 FOR UPDATE", {userId});
        if (u.isNull()) throw notFound("user not found");
        if (!admin && auth_.listedAdmin(u["username"].asString())) throw badRequest("this account is named in PLATFORM_ADMINS; remove it there to revoke it");
        if (u["is_admin"].asBool() == admin) return;
        Db::exec(w, "UPDATE users SET is_admin=$2 WHERE id=$1", {userId, admin});
        record(w, p, admin ? "grant_admin" : "revoke_admin", "user", userId, u["username"].asString(), reason);
    });
    return userRow(userId);
}

Json::Value AdminService::actions(const Principal& p, int limit, int offset) {
    auth_.requireAdmin(p);
    limit = clampLimit(limit); offset = clampOffset(offset);
    auto total = db_.queryOne("SELECT count(*) AS n FROM admin_actions")["n"].asInt64();
    auto rows = db_.queryJson("SELECT id, admin_id, admin_name, action, target_type, target_id, target_name, reason, created_at FROM admin_actions ORDER BY created_at DESC LIMIT $1 OFFSET $2",
                              {(int64_t)limit, (int64_t)offset});
    return paged(rows, total, limit, offset);
}

} // namespace acerciae
