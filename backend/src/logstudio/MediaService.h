#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include "ObjectStore.h"
#include <json/json.h>

namespace acerciae::logstudio {

// Media assets: validated uploads, versioning, approval state, permission-checked delivery.
class MediaService {
public:
    MediaService(const Config& cfg, Db& db, ObjectStore& store) : cfg_(cfg), db_(db), store_(store) {}
    Json::Value list(const ChannelAccess& a, const std::string& assetType, const std::string& characterId, const std::string& approval);
    Json::Value get(const ChannelAccess& a, const std::string& assetId);
    Json::Value upload(const ChannelAccess& a, const std::string& fileName, const std::string& bytes, const std::string& contentType, const Json::Value& meta);
    Json::Value update(const ChannelAccess& a, const std::string& assetId, const Json::Value& body);     // name, tags, expression, character, approval
    Json::Value newVersion(const ChannelAccess& a, const std::string& assetId, const std::string& fileName, const std::string& bytes, const std::string& contentType, const std::string& note);
    Json::Value remove(const ChannelAccess& a, const std::string& assetId);
    // What a client may keep: the stored object (one per version, never rewritten), whether the request named a
    // version, and whether a player could see the asset (only then may a client keep it on disk).
    struct MediaMeta { std::string objectKey; bool pinned = false; bool playerVisible = false; /* may be kept for good by a player's client: channel-scoped, approved, not an NPC's */ std::string contentHash; int version = 0; };
    // Returns bytes + mime for streaming; enforces channel membership and GM-only visibility. version 0 = current.
    // With `redirectUrl`, a version stored in the public bucket is not read: its URL is returned there instead.
    bool fetch(const ChannelAccess& a, const std::string& assetId, int version, std::string& bytes, std::string& mime, std::string& fileName, std::string* redirectUrl = nullptr, MediaMeta* meta = nullptr);
    // The same checks as fetch, without reading the bytes (for a revalidation answered with 304).
    bool resolve(const ChannelAccess& a, const std::string& assetId, int version, MediaMeta& meta);
    // AI-generated raster art (and its mock stand-in) is not secret: it may live in the public bucket.
    static bool publicEligible(const std::string& sourceType, const std::string& mime);
    bool fetchRow(const ChannelAccess& a, const std::string& assetId, int version, std::string& mime, std::string& fileName, MediaMeta& meta);
    // Internal: store a generated/derived asset (TTS audio, generated images).
    Json::Value storeInternal(const std::string& channelId, const std::string& assetType, const std::string& sourceType, const std::string& bytes, const std::string& mime, const Json::Value& meta);
    static std::string sniffMime(const std::string& bytes, const std::string& fileName);
    static bool allowedMime(const std::string& mime, const std::string& assetType);
    // One image per character and slot ("avatar", "portrait" or a subtitle such as SAY): the new asset takes the slot
    // and every older image of that slot (the one it held, library images filed under it) is deleted with its stored
    // files. An image a live publication still shows is kept, marked superseded, until that publication is revoked.
    // Returns how many images were deleted.
    int adoptCharacterImage(const std::string& channelId, const std::string& characterId, const std::string& slot, const std::string& subtitle, const std::string& assetId);
    // Deletes superseded images no live publication shows any more.
    int purgeSuperseded(const std::string& channelId);
    ObjectStore& store() { return store_; }
    static void probeDimensions(const std::string& bytes, const std::string& mime, int& w, int& h);
    // Stores the SHA-256 of a version's bytes (content_hash) when it was not known yet.
    void recordHash(const std::string& assetId, int version, const std::string& hash);
private:
    const Config& cfg_; Db& db_; ObjectStore& store_;
};

} // namespace
