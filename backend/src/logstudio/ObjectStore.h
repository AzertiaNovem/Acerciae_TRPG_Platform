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
//
// Public media: with R2_PUBLIC_BUCKET and R2_PUBLIC_BASE_URL set, media that is not secret (AI-generated art, voice
// clips, user avatars) is written under keys starting with "pub/" into a second, publicly readable bucket. Those keys
// are unguessable, the bucket is never listed, and the backend still checks permissions before it hands out an
// object's URL (by redirecting to it), so browsers download the bytes straight from Cloudflare. Invariant: a "pub/"
// key always lives in the public bucket (or in a copy made from it).
class ObjectStore {
public:
    virtual ~ObjectStore() = default;
    virtual void put(const std::string& key, const std::string& bytes, const std::string& contentType) = 0;
    virtual std::optional<std::string> get(const std::string& key) = 0;
    virtual bool exists(const std::string& key) = 0;
    virtual void remove(const std::string& key) = 0;
    virtual std::string kind() const = 0;
    // Where a browser can fetch the object directly, or "" when it must be streamed through the backend.
    virtual std::string publicUrl(const std::string& key) const { (void)key; return ""; }
    // Whether new non-secret media should get "pub/" keys (a public bucket is configured).
    virtual bool publicAvailable() const { return false; }
};

constexpr const char* kPublicPrefix = "pub/";
inline bool isPublicKey(const std::string& key) { return key.rfind(kPublicPrefix, 0) == 0; }

std::unique_ptr<ObjectStore> makeObjectStore(const Config& cfg);   // OBJECT_STORE / IMAGE_STORE = local|s3|r2
// One backend by name (local|s3|r2|r2public), configured from the environment; throws when its settings are incomplete.
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
    // The public bucket for "pub/" keys and the base URL browsers fetch them from (e.g. https://media.example.com).
    void setPublic(std::shared_ptr<ObjectStore> store, std::string baseUrl);
    void put(const std::string& key, const std::string& bytes, const std::string& contentType) override;
    std::optional<std::string> get(const std::string& key) override;
    bool exists(const std::string& key) override;
    void remove(const std::string& key) override;
    std::string kind() const override;   // "local", or e.g. "local+images:r2+public:r2public"
    std::string publicUrl(const std::string& key) const override;
    bool publicAvailable() const override { return public_ != nullptr; }
    // The backend new writes of this key go to, and the local directory backend (always present when built by
    // makeObjectStore). Used by the media migrator.
    ObjectStore& targetFor(const std::string& key, const std::string& contentType = "") const;
    ObjectStore* localBackend() const;
    std::vector<ObjectStore*> backends() const;   // every distinct backend, including read-only fallbacks
private:
    std::vector<ObjectStore*> readOrder(const std::string& key) const;
    std::shared_ptr<ObjectStore> general_, images_, public_;
    std::string publicBase_;
    std::vector<std::shared_ptr<ObjectStore>> all_;   // distinct backends: general, images, fallbacks, public
};
std::string safeObjectKey(const std::string& channelId, const std::string& category, const std::string& ext);
// Same key, under "pub/" when the store has a public bucket. Only for media that is not secret.
std::string publicObjectKey(const ObjectStore& store, const std::string& channelId, const std::string& category, const std::string& ext);
// A user's avatar: "users/<id>/avatar/<uuid>.<ext>" (under "pub/" when available).
std::string avatarObjectKey(const ObjectStore& store, const std::string& userId, const std::string& ext);
// Percent-encodes a key for a URL path (keeps "/").
std::string urlEncodeKey(const std::string& key);

} // namespace
