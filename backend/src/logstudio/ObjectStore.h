#pragma once
#include "../core/Config.h"
#include <string>
#include <memory>
#include <optional>
#include <vector>

namespace acerciae::logstudio {

// Media bytes never live in PostgreSQL. Backends: a local directory (development/default), any S3-compatible
// service (MinIO, AWS S3, …) and Cloudflare R2, the latter two via AWS Signature V4 over libcurl.
// OBJECT_STORE picks where media goes; IMAGE_STORE (defaults to OBJECT_STORE) can send images elsewhere, e.g. to R2
// while speech and PDFs stay local. Reads fall back to every other configured backend, so switching either setting
// back and forth never makes an existing object unreadable.
class ObjectStore {
public:
    virtual ~ObjectStore() = default;
    virtual void put(const std::string& key, const std::string& bytes, const std::string& contentType) = 0;
    virtual std::optional<std::string> get(const std::string& key) = 0;
    virtual bool exists(const std::string& key) = 0;
    virtual void remove(const std::string& key) = 0;
    virtual std::string kind() const = 0;
};

std::unique_ptr<ObjectStore> makeObjectStore(const Config& cfg);   // OBJECT_STORE / IMAGE_STORE = local|s3|r2
// One backend by name (local|s3|r2), configured from the environment; throws when its settings are incomplete.
std::unique_ptr<ObjectStore> makeBackend(const std::string& kind, const Config& cfg);
// Copies objects that `to` does not have yet (used by `acerciae-server --copy-images FROM TO`). Never deletes.
struct CopyReport { int copied = 0, alreadyPresent = 0, missingAtSource = 0, failed = 0; };
CopyReport copyObjects(ObjectStore& from, ObjectStore& to, const std::vector<std::pair<std::string, std::string>>& keysAndMimes);

// Images are routed by content type (image/*) when written and by file extension when read.
bool isImageObject(const std::string& key, const std::string& contentType = "");

// Sends images to one backend and everything else to another; reads try the preferred backend, then the others.
class RoutingObjectStore : public ObjectStore {
public:
    // `fallbacks` are extra backends that are only read from (and cleaned up on remove).
    RoutingObjectStore(std::shared_ptr<ObjectStore> general, std::shared_ptr<ObjectStore> images, std::vector<std::shared_ptr<ObjectStore>> fallbacks = {});
    void put(const std::string& key, const std::string& bytes, const std::string& contentType) override;
    std::optional<std::string> get(const std::string& key) override;
    bool exists(const std::string& key) override;
    void remove(const std::string& key) override;
    std::string kind() const override;   // "local", or e.g. "local+images:r2"
private:
    std::vector<ObjectStore*> readOrder(const std::string& key) const;
    std::shared_ptr<ObjectStore> general_, images_;
    std::vector<std::shared_ptr<ObjectStore>> all_;   // distinct backends: general, images, fallbacks
};
std::string safeObjectKey(const std::string& channelId, const std::string& category, const std::string& ext);

} // namespace
