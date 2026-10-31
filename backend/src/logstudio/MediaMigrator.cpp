#include "MediaMigrator.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include <drogon/utils/Utilities.h>

namespace acerciae::logstudio {

void MediaMigrator::start() {
    if (thread_.joinable()) return;
    stop_ = false;
    thread_ = std::thread([this] {
        try {
            auto r = runOnce();
            if (r.avatarsMoved + r.madePublic + r.uploaded + r.failed + r.localDeleted > 0) ALOG_INFO << "media migration: " << describe(r);
        } catch (const std::exception& e) { ALOG_WARN << "media migration stopped: " << e.what(); }
    });
}
void MediaMigrator::stop() {
    stop_ = true;
    if (thread_.joinable()) thread_.join();
}

std::string MediaMigrator::describe(const Report& r) {
    return std::to_string(r.avatarsMoved) + " avatars moved out of the database, " + std::to_string(r.madePublic) + " objects moved to the public bucket, " +
           std::to_string(r.uploaded) + " local objects uploaded, " + std::to_string(r.alreadyThere) + " already there, " + std::to_string(r.missing) +
           " missing, " + std::to_string(r.failed) + " failed, " + std::to_string(r.localDeleted) + " local copies deleted";
}

MediaMigrator::Report MediaMigrator::runOnce() {
    Report r;
    moveInlineAvatars(r);
    if (store_.publicAvailable() && !stopping()) makePublic(r);
    if (!stopping()) uploadLocal(r);
    return r;
}

// 1. users.avatar_data (a data URI) → an object; the version is kept so clients' cached pictures stay valid.
void MediaMigrator::moveInlineAvatars(Report& r) {
    for (auto& u : db_.queryJson("SELECT id, avatar_data FROM users WHERE avatar_data<>'' AND avatar_key IS NULL")) {
        if (stopping()) return;
        auto data = u["avatar_data"].asString(), id = u["id"].asString();
        auto comma = data.find(','), semi = data.find(';');
        if (data.rfind("data:", 0) != 0 || comma == std::string::npos || semi == std::string::npos || semi > comma) { ++r.failed; continue; }
        auto mime = data.substr(5, semi - 5);
        auto bytes = drogon::utils::base64Decode(data.substr(comma + 1));
        if (bytes.empty()) { ++r.failed; continue; }
        std::string key;
        try {
            key = avatarObjectKey(store_, id, mime == "image/png" ? "png" : "jpg");
            store_.put(key, bytes, mime);
            // Only if the avatar did not change meanwhile; otherwise the new object is not needed.
            if (db_.queryOne("UPDATE users SET avatar_key=$2, avatar_mime=$3, avatar_data='' WHERE id=$1 AND avatar_data=$4 AND avatar_key IS NULL RETURNING id", {id, key, mime, data}).isNull())
                store_.remove(key);
            else ++r.avatarsMoved;
        } catch (const std::exception& e) { ALOG_WARN << "media migration: avatar of " << id << ": " << e.what(); ++r.failed; }
    }
}

// 2. Non-secret media into the public bucket: AI-generated raster art, voice clips, avatars.
void MediaMigrator::makePublic(Report& r) {
    auto rows = db_.queryJson(
        "SELECT av.object_key AS k, av.mime FROM asset_versions av JOIN media_assets m ON m.id=av.asset_id "
        " WHERE m.source_type IN ('generated','mock') AND av.mime LIKE 'image/%' AND av.mime<>'image/svg+xml' AND av.object_key NOT LIKE 'pub/%' "
        "UNION SELECT object_key, mime FROM media_assets WHERE source_type IN ('generated','mock') AND mime LIKE 'image/%' AND mime<>'image/svg+xml' AND object_key NOT LIKE 'pub/%' "
        "UNION SELECT object_key, mime FROM tts_audio_assets WHERE object_key NOT LIKE 'pub/%' "
        "UNION SELECT avatar_key, coalesce(avatar_mime,'image/png') FROM users WHERE avatar_key IS NOT NULL AND avatar_key NOT LIKE 'pub/%'");
    for (auto& row : rows) {
        if (stopping()) return;
        auto oldKey = row["k"].asString(), mime = row["mime"].asString();
        if (oldKey.empty()) continue;
        auto newKey = std::string(kPublicPrefix) + oldKey;
        auto& target = store_.targetFor(newKey, mime);
        try {
            if (!target.exists(newKey)) {
                auto bytes = store_.get(oldKey);
                if (!bytes) { ++r.missing; continue; }
                target.put(newKey, *bytes, mime);
            }
            // Repoint every row that names the old key, in one transaction, only now that the copy exists.
            db_.tx([&](pqxx::work& w) {
                Db::exec(w, "UPDATE media_assets SET object_key=$2 WHERE object_key=$1", {oldKey, newKey});
                Db::exec(w, "UPDATE asset_versions SET object_key=$2 WHERE object_key=$1", {oldKey, newKey});
                Db::exec(w, "UPDATE tts_audio_assets SET object_key=$2 WHERE object_key=$1", {oldKey, newKey});
                Db::exec(w, "UPDATE users SET avatar_key=$2 WHERE avatar_key=$1", {oldKey, newKey});
                Db::exec(w, "INSERT INTO object_migrations(object_key, target) VALUES($1,$2) ON CONFLICT DO NOTHING", {newKey, target.kind()});
            });
            ++r.madePublic;
            // The old object is no longer referenced: drop remote copies; the local one only when asked to.
            for (auto* b : store_.backends()) {
                if (b == &target || (b->kind() == "local" && !deleteLocal_)) continue;
                try { if (b->exists(oldKey)) { b->remove(oldKey); if (b->kind() == "local") ++r.localDeleted; } } catch (const std::exception& e) { ALOG_WARN << "media migration: could not remove " << oldKey << " from " << b->kind() << ": " << e.what(); }
            }
        } catch (const std::exception& e) { ALOG_WARN << "media migration: " << oldKey << ": " << e.what(); ++r.failed; }
    }
}

// 3. Everything still on the local disk that belongs in object storage now.
void MediaMigrator::uploadLocal(Report& r) {
    auto* local = store_.localBackend();
    if (!local) return;
    auto rows = db_.queryJson(
        "SELECT object_key AS k, mime FROM media_assets UNION SELECT object_key, mime FROM asset_versions "
        "UNION SELECT object_key, mime FROM tts_audio_assets UNION SELECT object_key, 'application/pdf' FROM pdf_render_jobs WHERE object_key IS NOT NULL "
        "UNION SELECT raw_object_key, 'application/octet-stream' FROM log_imports WHERE raw_object_key IS NOT NULL "
        "UNION SELECT avatar_key, coalesce(avatar_mime,'image/png') FROM users WHERE avatar_key IS NOT NULL");
    for (auto& row : rows) {
        if (stopping()) return;
        auto key = row["k"].asString(), mime = row["mime"].asString();
        if (key.empty()) continue;
        auto& target = store_.targetFor(key, mime);
        if (&target == local) continue;
        try {
            if (!local->exists(key)) continue;   // not (or no longer) on the local disk
            bool recorded = !db_.queryOne("SELECT 1 AS ok FROM object_migrations WHERE object_key=$1 AND target=$2", {key, target.kind()}).isNull();
            if (!recorded) {
                if (target.exists(key)) ++r.alreadyThere;
                else {
                    auto bytes = local->get(key);
                    if (!bytes) { ++r.missing; continue; }
                    target.put(key, *bytes, mime);
                    ++r.uploaded;
                }
                db_.exec("INSERT INTO object_migrations(object_key, target) VALUES($1,$2) ON CONFLICT DO NOTHING", {key, target.kind()});
            }
            if (deleteLocal_ && target.exists(key)) { local->remove(key); ++r.localDeleted; }
        } catch (const std::exception& e) { ALOG_WARN << "media migration: " << key << ": " << e.what(); ++r.failed; }
    }
}

} // namespace acerciae::logstudio
