#include "StorageCleanup.h"
#include "MediaService.h"
#include "../core/Log.h"
#include <chrono>
#include <ctime>
#include <set>
#include <unordered_set>

namespace acerciae::logstudio {
namespace {
// Objects a live publication serves straight from storage (its frozen images and voice lines).
const std::string kLiveKeys =
    "SELECT f.value->>'object_key' AS k FROM published_logs p, jsonb_each(CASE WHEN jsonb_typeof(p.frozen_content->'assets')='object' THEN p.frozen_content->'assets' ELSE '{}'::jsonb END) f WHERE NOT p.revoked "
    "UNION SELECT f.value->>'object_key' FROM published_logs p, jsonb_each(CASE WHEN jsonb_typeof(p.frozen_content->'audio')='object' THEN p.frozen_content->'audio' ELSE '{}'::jsonb END) f WHERE NOT p.revoked";
const char* kAge = "interval '1 day'";
}

void StorageCleanup::start() {
    if (thread_.joinable()) return;
    stop_ = false;
    thread_ = std::thread([this] {
        while (!stopping()) {
            try {
                auto r = runOnce();
                if (r.characterImages + r.oldVersions + r.superseded + r.orphans + r.failed > 0) ALOG_INFO << "storage cleanup: " << describe(r);
            } catch (const std::exception& e) { ALOG_WARN << "storage cleanup stopped: " << e.what(); }
            for (int i = 0; i < 24 * 3600 && !stopping(); ++i) std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    });
}
void StorageCleanup::stop() {
    stop_ = true;
    if (thread_.joinable()) thread_.join();
}

std::string StorageCleanup::describe(const Report& r, bool dryRun) {
    return std::string(dryRun ? "would delete " : "deleted ") + std::to_string(r.characterImages) + " replaced or unused character images, " + std::to_string(r.oldVersions) +
           " old asset versions, " + std::to_string(r.superseded) + " images no publication shows any more, " + std::to_string(r.orphans) + " stored objects nothing refers to (" +
           std::to_string(r.bytes / (1024 * 1024)) + " MB); " + std::to_string(r.failed) + " failed";
}

StorageCleanup::Report StorageCleanup::runOnce(bool dryRun) {
    Report r;
    characterImages(r, dryRun);
    if (!stopping()) oldVersions(r, dryRun);
    if (!stopping()) {
        for (auto& c : db_.queryJson("SELECT DISTINCT m.channel_id AS id, count(*) OVER (PARTITION BY m.channel_id) AS n FROM media_assets m WHERE m.source_reference ? 'superseded_by' "
                                     "AND NOT EXISTS (SELECT 1 FROM published_logs p WHERE p.channel_id=m.channel_id AND NOT p.revoked AND p.frozen_asset_versions ? m.id::text)")) {
            if (dryRun) { r.superseded += c["n"].asInt(); continue; }
            try { r.superseded += media_.purgeSuperseded(c["id"].asString()); } catch (const std::exception& e) { ALOG_WARN << "storage cleanup: " << e.what(); ++r.failed; }
        }
    }
    if (!stopping()) orphans(r, dryRun);
    return r;
}

void StorageCleanup::removeObject(const std::string& key) {
    const std::string pub = kPublicPrefix;
    const std::string twin = isPublicKey(key) ? key.substr(pub.size()) : pub + key;   // the migrator's copy under the other name
    bool twinUsed = !db_.queryOne("SELECT 1 AS x FROM media_assets WHERE object_key=$1 UNION ALL SELECT 1 FROM asset_versions WHERE object_key=$1 UNION ALL SELECT 1 FROM tts_audio_assets WHERE object_key=$1 LIMIT 1", {twin}).isNull();
    for (const auto& k : {key, twin}) {
        if (k == twin && twinUsed) continue;
        try { store_.remove(k); } catch (const std::exception& e) { ALOG_WARN << "storage cleanup: could not remove " << k << ": " << e.what(); }
    }
    try { db_.exec("DELETE FROM object_migrations WHERE object_key = ANY($1::text[])", {pgArrayLiteral({key, isPublicKey(key) ? key.substr(pub.size()) : pub + key})}); } catch (const std::exception&) {}
}

// 1. A character keeps one image per slot (avatar, portrait, subtitle). Anything else filed under the character that
// nothing points at is an older or rejected image. The newest approved library standee of a subtitle the character
// space has no image for stays: a visual novel's stage falls back to it.
void StorageCleanup::characterImages(Report& r, bool dryRun) {
    const std::string unused =
        "SELECT m.id FROM media_assets m WHERE m.character_id IS NOT NULL AND m.asset_type IN ('standee','portrait') AND m.approval_status<>'candidate' "
        "AND NOT (m.source_reference ? 'superseded_by') AND m.created_at < now() - " + std::string(kAge) + " AND m.updated_at < now() - " + kAge +
        " AND NOT EXISTS (SELECT 1 FROM characters ch WHERE ch.avatar_asset_id=m.id OR ch.portrait_asset_id=m.id)"
        " AND NOT EXISTS (SELECT 1 FROM character_visual_profiles cv WHERE cv.default_asset_id=m.id OR m.id = ANY(cv.reference_asset_ids)"
        "     OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(cv.expressions)='object' THEN cv.expressions ELSE '{}'::jsonb END) e WHERE e.value = m.id::text))"
        " AND NOT EXISTS (SELECT 1 FROM visual_style_profiles vs WHERE m.id = ANY(vs.reference_asset_ids))"
        " AND NOT EXISTS (SELECT 1 FROM media_assets o WHERE m.id = ANY(o.reference_asset_ids))"
        " AND NOT EXISTS (SELECT 1 FROM presentation_scenes s WHERE s.background_asset_id=m.id OR s.bgm_asset_id=m.id)"
        " AND NOT EXISTS (SELECT 1 FROM published_logs p WHERE NOT p.revoked AND p.frozen_asset_versions ? m.id::text)"
        " AND NOT EXISTS (SELECT 1 FROM asset_generation_jobs j WHERE j.character_id=m.character_id AND j.status IN ('pending','running'))"
        " AND NOT (m.asset_type='standee' AND m.approval_status='approved' AND lower(btrim(m.expression)) NOT IN ('','default')"
        "     AND NOT EXISTS (SELECT 1 FROM character_visual_profiles cv CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(cv.expressions)='object' THEN cv.expressions ELSE '{}'::jsonb END) e"
        "                     JOIN media_assets pm ON pm.id::text = e.value AND pm.approval_status='approved'"
        "                     WHERE cv.character_id=m.character_id AND lower(btrim(e.key))=lower(btrim(m.expression)))"
        "     AND NOT EXISTS (SELECT 1 FROM media_assets n WHERE n.character_id=m.character_id AND n.asset_type='standee' AND n.approval_status='approved'"
        "                     AND NOT (n.source_reference ? 'superseded_by') AND n.visibility_scope=m.visibility_scope AND lower(btrim(n.expression))=lower(btrim(m.expression))"
        "                     AND (n.updated_at, n.created_at, n.id) > (m.updated_at, m.created_at, m.id)))";
    std::vector<std::string> keys;
    db_.tx([&](pqxx::work& w) {
        auto ids = Db::queryJson(w, unused);
        if (ids.empty()) return;
        std::vector<std::string> list; for (auto& i : ids) list.push_back(i["id"].asString());
        auto arr = pgArrayLiteral(list);
        for (auto& k : Db::queryJson(w, "SELECT object_key AS k, bytes FROM asset_versions WHERE asset_id = ANY($1::uuid[]) UNION SELECT object_key, bytes FROM media_assets WHERE id = ANY($1::uuid[])", {arr})) {
            keys.push_back(k["k"].asString()); r.bytes += k["bytes"].asInt64();
        }
        r.characterImages += (int)list.size();
        if (!dryRun) Db::exec(w, "DELETE FROM media_assets WHERE id = ANY($1::uuid[])", {arr});
    });
    if (!dryRun) for (const auto& k : keys) removeObject(k);
}

// 2. Earlier versions of an approved asset nothing pins.
void StorageCleanup::oldVersions(Report& r, bool dryRun) {
    auto rows = db_.queryJson(
        "WITH live AS (" + kLiveKeys + ") "
        "SELECT av.asset_id, av.version, av.object_key, av.bytes FROM asset_versions av JOIN media_assets m ON m.id=av.asset_id "
        "WHERE av.version <> m.version AND av.object_key <> m.object_key AND m.approval_status='approved' AND av.created_at < now() - " + std::string(kAge) +
        " AND NOT EXISTS (SELECT 1 FROM presentation_scenes s WHERE s.background_asset_id=av.asset_id AND s.background_asset_version=av.version)"
        " AND NOT EXISTS (SELECT 1 FROM published_logs p WHERE NOT p.revoked AND p.frozen_asset_versions->>(av.asset_id::text) = av.version::text)"
        " AND NOT EXISTS (SELECT 1 FROM live WHERE live.k = av.object_key)"
        " AND NOT EXISTS (SELECT 1 FROM asset_versions o WHERE o.object_key=av.object_key AND (o.asset_id<>av.asset_id OR o.version<>av.version))");
    for (auto& v : rows) {
        if (stopping()) return;
        ++r.oldVersions; r.bytes += v["bytes"].asInt64();
        if (dryRun) continue;
        try {
            db_.exec("DELETE FROM asset_versions WHERE asset_id=$1 AND version=$2", {v["asset_id"].asString(), (int64_t)v["version"].asInt()});
            removeObject(v["object_key"].asString());
        } catch (const std::exception& e) { ALOG_WARN << "storage cleanup: " << e.what(); ++r.failed; }
    }
}

// 3. Stored objects nothing names. Only the folders this platform writes, only objects of channels and users this
// database knows (a bucket shared with another installation keeps that installation's objects), only after a day.
void StorageCleanup::orphans(Report& r, bool dryRun) {
    std::unordered_set<std::string> referenced, channels, users;
    for (auto& k : db_.queryJson(
            "SELECT object_key AS k FROM media_assets UNION SELECT object_key FROM asset_versions UNION SELECT object_key FROM tts_audio_assets "
            "UNION SELECT object_key FROM pdf_render_jobs WHERE object_key IS NOT NULL UNION SELECT raw_object_key FROM log_imports WHERE raw_object_key IS NOT NULL "
            "UNION SELECT object_key FROM vn_bundle_jobs WHERE object_key IS NOT NULL UNION SELECT avatar_key FROM users WHERE avatar_key IS NOT NULL UNION " + kLiveKeys))
        if (k["k"].isString()) referenced.insert(k["k"].asString());
    for (auto& c : db_.queryJson("SELECT id FROM channels")) channels.insert(c["id"].asString());
    for (auto& u : db_.queryJson("SELECT id FROM users")) users.insert(u["id"].asString());
    const std::time_t cutoff = std::time(nullptr) - 24 * 3600;
    auto owner = [&](const std::string& key) {
        auto k = isPublicKey(key) ? key.substr(std::string(kPublicPrefix).size()) : key;   // channels/<id>/… or users/<id>/…
        auto slash = k.find('/'); if (slash == std::string::npos) return false;
        auto rest = k.substr(slash + 1); auto id = rest.substr(0, rest.find('/'));
        return k.rfind("channels/", 0) == 0 ? channels.count(id) > 0 : users.count(id) > 0;
    };
    for (auto* backend : store_.backends()) {
        if (stopping()) return;
        std::vector<ObjectStore::Listed> found;
        try {
            for (const char* prefix : {"channels/", "users/", "pub/channels/", "pub/users/"})
                backend->list(prefix, [&](const ObjectStore::Listed& o) { found.push_back(o); });
        } catch (const std::exception& e) { ALOG_WARN << "storage cleanup: cannot list " << backend->kind() << ": " << e.what(); ++r.failed; continue; }   // nothing is deleted from a backend that cannot be listed in full
        for (const auto& o : found) {
            if (stopping()) return;
            if (o.modified == 0 || o.modified > cutoff || !owner(o.key)) continue;
            try {
                if (referenced.count(o.key)) continue;
                ++r.orphans; r.bytes += o.size;
                if (!dryRun) backend->remove(o.key);
            } catch (const std::exception& e) { ALOG_WARN << "storage cleanup: " << o.key << ": " << e.what(); ++r.failed; }
        }
    }
}

} // namespace acerciae::logstudio
