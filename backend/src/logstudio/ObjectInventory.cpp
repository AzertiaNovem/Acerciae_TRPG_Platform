#include "ObjectInventory.h"
#include "../core/Crypto.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include <map>
#include <set>

namespace acerciae::logstudio {
namespace {
void recordObject(Db& db, ObjectStore& store, const std::string& key, const std::string& bytes, const std::string& mime) {
    auto path = isPublicKey(key) ? key.substr(4) : key;
    auto first = path.find('/');
    auto last = first == std::string::npos ? first : path.find('/', first + 1);
    std::string ownerKind = "unclaimed", ownerId;
    if (first != std::string::npos && last != std::string::npos) {
        const auto category = path.substr(0, first);
        ownerId = path.substr(first + 1, last - first - 1);
        if (category == "channels" && !db.queryOne("SELECT 1 FROM channels WHERE id::text=$1", {ownerId}).isNull()) ownerKind = "channel";
        else if (category == "users" && !db.queryOne("SELECT 1 FROM users WHERE id::text=$1", {ownerId}).isNull()) ownerKind = "user";
        else ownerId.clear();
    }
    db.exec("INSERT INTO stored_objects(bucket,object_key,content_hash,bytes,mime,owner_kind,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7) "
            "ON CONFLICT(bucket,object_key) DO UPDATE SET content_hash=EXCLUDED.content_hash,bytes=EXCLUDED.bytes,"
            "mime=CASE WHEN EXCLUDED.mime='' THEN stored_objects.mime ELSE EXCLUDED.mime END,"
            "owner_kind=EXCLUDED.owner_kind,owner_id=EXCLUDED.owner_id,verified_at=now()",
            {store.identity(),key,crypto::sha256Hex(bytes),int64_t(bytes.size()),mime,ownerKind,ownerId.empty() ? dbNull() : DbParam(ownerId)});
}

class TrackedStore final : public ObjectStore {
public:
    TrackedStore(std::shared_ptr<ObjectStore> inner, Db& db) : inner_(std::move(inner)), db_(db) {}
    void put(const std::string& key, const std::string& bytes, const std::string& mime) override {
        inner_->put(key, bytes, mime);
        recordObject(db_, *inner_, key, bytes, mime);
    }
    std::optional<std::string> get(const std::string& key) override { return inner_->get(key); }
    bool exists(const std::string& key) override { return inner_->exists(key); }
    void retain(const std::string& key) override {
        db_.exec("UPDATE stored_objects SET protected_until=now()+interval '1 day' WHERE bucket=$1 AND object_key=$2", {identity(),key});
    }
    bool removeOrphan(const std::string& key) override {
        return db_.tx([&](pqxx::work& transaction) {
            auto row = Db::queryOne(transaction, "SELECT protected_until<=now() AS expired FROM stored_objects WHERE bucket=$1 AND object_key=$2 FOR UPDATE", {identity(),key});
            if (row.isNull() || !row["expired"].asBool()) return false;
            if (!Db::queryOne(transaction, "SELECT 1 FROM stored_object_claims WHERE object_key=$1 LIMIT 1", {key}).isNull()) return false;
            inner_->remove(key);
            Db::exec(transaction, "DELETE FROM stored_objects WHERE bucket=$1 AND object_key=$2", {identity(),key});
            return true;
        });
    }
    void remove(const std::string& key) override {
        inner_->remove(key);
        db_.exec("DELETE FROM stored_objects WHERE bucket=$1 AND object_key=$2", {identity(),key});
    }
    void removePrefix(const std::string& prefix) override {
        inner_->removePrefix(prefix);
        if (kind() == "local" && !prefix.empty() && prefix.back() == '/' && prefix.front() != '/' && prefix.find("..") == std::string::npos)
            db_.exec("DELETE FROM stored_objects WHERE bucket=$1 AND left(object_key,length($2))=$2", {identity(),prefix});
    }
    std::string kind() const override { return inner_->kind(); }
    std::string identity() const override { return inner_->identity(); }
    void list(const std::string& prefix, const std::function<void(const Listed&)>& fn) override { inner_->list(prefix, fn); }
private:
    std::shared_ptr<ObjectStore> inner_;
    Db& db_;
};
}
std::shared_ptr<ObjectStore> trackedObjectStore(std::shared_ptr<ObjectStore> store, Db& db) {
    return std::make_shared<TrackedStore>(std::move(store), db);
}
int reconcileObjectInventory(Db& db, RoutingObjectStore& store, const std::function<bool()>& stopping) {
    int failed = 0;
    // Read ownership metadata once, rather than scanning all jobs again for every object in every bucket.
    std::map<std::string, Json::Value> claims;
    for (auto claim : db.queryJson("SELECT object_key,kind,id,channel_id,user_id FROM stored_object_claims ORDER BY object_key,kind,id")) {
        const auto key = claim["object_key"].asString();
        claim.removeMember("object_key");
        if (claims[key].size() < 64) claims[key].append(claim);
    }
    for (auto* backend : store.backends()) {
        if (stopping()) break;
        std::map<std::string, Json::Value> previous;
        for (const auto& row : db.queryJson("SELECT object_key,bytes,provenance,verified_at::text AS revision,extract(epoch FROM verified_at)::bigint AS verified "
                                          "FROM stored_objects WHERE bucket=$1", {backend->identity()})) previous.emplace(row["object_key"].asString(),row);
        std::set<std::string> seen;
        try {
            backend->list("", [&](const ObjectStore::Listed& object) {
                seen.insert(object.key);
                if (stopping()) return;
                try {
                    const auto old = previous.find(object.key);
                    if (old == previous.end() || old->second["bytes"].asInt64() != object.size || object.modified == 0 || object.modified > old->second["verified"].asInt64()) {
                        auto bytes = backend->get(object.key);
                        if (!bytes) throw std::runtime_error("listed object missing");
                        recordObject(db, *backend, object.key, *bytes, "");
                    }
                    // Preserve the last receipt when its completed task expires; bound the receipt size.
                    auto claim = claims.find(object.key);
                    if (claim != claims.end() && (old == previous.end() || old->second["provenance"] != claim->second))
                        db.exec("UPDATE stored_objects SET provenance=$3::jsonb WHERE bucket=$1 AND object_key=$2",
                                {backend->identity(),object.key,json::dump(claim->second)});
                } catch (const std::exception& e) { ++failed; ALOG_WARN << "object inventory: " << object.key << ": " << e.what(); }
            });
            // Only prune rows known before this successful scan. Concurrent uploads have their own new receipts.
            if (!stopping()) for (const auto& [key, row] : previous) {
                if (!seen.count(key)) db.exec("DELETE FROM stored_objects WHERE bucket=$1 AND object_key=$2 AND "
                                             "verified_at=$3::timestamptz", {backend->identity(),key,row["revision"].asString()});
            }
        } catch (const std::exception& e) { ++failed; ALOG_WARN << "object inventory listing: " << backend->identity() << ": " << e.what(); }
    }
    return failed;
}
}
