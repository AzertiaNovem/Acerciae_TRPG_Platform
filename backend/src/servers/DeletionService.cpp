#include "DeletionService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../knowledge/Visibility.h"
#include "../logstudio/ObjectStore.h"
#include "../ws/Notifier.h"

namespace acerciae {
namespace {
void requirePhrase(const Json::Value& body, const char* phrase) {
    if (json::str(body, "confirm") != phrase) throw ApiError(400, "confirmation_required", std::string("type \"") + phrase + "\" to confirm");
}
// Every stored object of the channels matched by `where` (a condition on channel_id taking $1).
std::vector<std::string> objectKeys(pqxx::work& w, const std::string& where, const std::string& param) {
    std::vector<std::string> keys;
    for (auto& r : Db::queryJson(w,
        "SELECT object_key AS k FROM media_assets WHERE channel_id " + where +
        " UNION SELECT av.object_key FROM asset_versions av JOIN media_assets m ON m.id=av.asset_id WHERE m.channel_id " + where +
        " UNION SELECT object_key FROM tts_audio_assets WHERE channel_id " + where +
        " UNION SELECT object_key FROM pdf_render_jobs WHERE channel_id " + where +
        " UNION SELECT raw_object_key FROM log_imports WHERE channel_id " + where, {param}))
        if (r["k"].isString() && !r["k"].asString().empty()) keys.push_back(r["k"].asString());
    return keys;
}
std::vector<std::string> column(const Json::Value& rows, const char* key) { std::vector<std::string> v; for (auto& r : rows) v.push_back(r[key].asString()); return v; }
}

int DeletionService::removeObjects(const std::vector<std::string>& keys) {
    int removed = 0;
    for (auto& k : keys) {
        try { store_.remove(k); ++removed; } catch (const std::exception& e) { ALOG_WARN << "delete: could not remove object " << k << ": " << e.what(); }
    }
    return removed;
}

Json::Value DeletionService::deleteServer(const Principal& p, const std::string& serverId, const Json::Value& body) {
    if (!Visibility::isUuid(serverId)) throw notFound("server not found");
    auto s = db_.queryOne("SELECT s.owner_id, sm.role FROM servers s LEFT JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=$2 WHERE s.id=$1", {serverId, p.userId});
    if (s.isNull() || s["role"].isNull()) throw notFound("server not found");
    if (s["owner_id"].asString() != p.userId) throw forbidden("only the server owner can delete the server");
    requirePhrase(body, kServerPhrase);
    std::vector<std::string> members, channels, keys;
    db_.tx([&](pqxx::work& w) {
        members = column(Db::queryJson(w, "SELECT user_id FROM server_members WHERE server_id=$1", {serverId}), "user_id");
        channels = column(Db::queryJson(w, "SELECT id FROM channels WHERE server_id=$1", {serverId}), "id");
        keys = objectKeys(w, "IN (SELECT id FROM channels WHERE server_id=$1)", serverId);
        Db::exec(w, "DELETE FROM servers WHERE id=$1", {serverId});
    });
    int files = removeObjects(keys);
    notifier_.serverDeleted(serverId, channels, members);
    Json::Value v; v["ok"] = true; v["channels"] = (int)channels.size(); v["files"] = files;
    return v;
}

Json::Value DeletionService::deleteChannel(const Principal& p, const std::string& channelId, const Json::Value& body) {
    if (!Visibility::isUuid(channelId)) throw notFound("channel not found");
    auto c = db_.queryOne("SELECT c.server_id, sm.role FROM channels c LEFT JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=$2 WHERE c.id=$1", {channelId, p.userId});
    if (c.isNull() || c["role"].isNull()) throw notFound("channel not found");
    auto role = c["role"].asString();
    if (role != "owner" && role != "admin") throw forbidden("only server maintainers can delete channels");
    requirePhrase(body, kChannelPhrase);
    auto serverId = c["server_id"].asString();
    std::vector<std::string> members, keys;
    db_.tx([&](pqxx::work& w) {
        members = column(Db::queryJson(w, "SELECT user_id FROM server_members WHERE server_id=$1", {serverId}), "user_id");
        keys = objectKeys(w, "= $1::uuid", channelId);
        Db::exec(w, "DELETE FROM channels WHERE id=$1", {channelId});
    });
    int files = removeObjects(keys);
    notifier_.channelDeleted(serverId, channelId, members);
    Json::Value v; v["ok"] = true; v["files"] = files;
    return v;
}

} // namespace acerciae
