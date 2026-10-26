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
    // Returns bytes + mime for streaming; enforces channel membership and GM-only visibility. version 0 = current.
    bool fetch(const ChannelAccess& a, const std::string& assetId, int version, std::string& bytes, std::string& mime, std::string& fileName);
    // Internal: store a generated/derived asset (TTS audio, generated images).
    Json::Value storeInternal(const std::string& channelId, const std::string& assetType, const std::string& sourceType, const std::string& bytes, const std::string& mime, const Json::Value& meta);
    static std::string sniffMime(const std::string& bytes, const std::string& fileName);
    static bool allowedMime(const std::string& mime, const std::string& assetType);
    ObjectStore& store() { return store_; }
    static void probeDimensions(const std::string& bytes, const std::string& mime, int& w, int& h);
private:
    const Config& cfg_; Db& db_; ObjectStore& store_;
};

} // namespace
