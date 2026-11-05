#include "ImageReferences.h"
#include "../core/Crypto.h"
#include "../core/Json.h"
#include "../knowledge/Visibility.h"
#include <drogon/utils/Utilities.h>
#include <stdexcept>

namespace acerciae::logstudio {
Json::Value freezeImageReference(ObjectStore& store, const std::string& channelId,
                                Json::Value reference, const std::string& bytes, const std::string& mime) {
    if (!Visibility::isUuid(channelId) || mime.rfind("image/", 0) != 0 || bytes.empty() || bytes.size() > 20 * 1024 * 1024)
        throw std::runtime_error("invalid image reference snapshot");
    const auto hash = crypto::sha256Hex(bytes);
    // A fixed extension routes these private snapshots through IMAGE_STORE, including legacy image formats.
    const auto key = "channels/" + channelId + "/image-references/" + hash + ".png";
    store.retain(key);
    if (!store.exists(key)) store.put(key, bytes, mime);
    reference.removeMember("data_uri");
    reference["object_key"] = key;
    reference["content_hash"] = hash;
    reference["mime"] = mime;
    reference["bytes"] = Json::Int64(bytes.size());
    return reference;
}

bool externalizeImageReferences(ObjectStore& store, const std::string& channelId, Json::Value& request) {
    bool changed = false;
    for (auto& reference : request["reference_images"]) {
        const auto uri = json::str(reference, "data_uri");
        if (uri.empty()) continue;
        const auto separator = uri.find(";base64,");
        if (uri.rfind("data:image/", 0) != 0 || separator == std::string::npos)
            throw std::runtime_error("invalid inline image reference");
        const auto encoded = uri.substr(separator + 8);
        if (encoded.size() > 28 * 1024 * 1024) throw std::runtime_error("oversized inline image reference");
        const auto bytes = drogon::utils::base64Decode(encoded);
        if (drogon::utils::base64Encode(bytes) != encoded) throw std::runtime_error("invalid reference encoding");
        reference = freezeImageReference(store, channelId, reference, bytes, uri.substr(5, separator - 5));
        changed = true;
    }
    return changed;
}

Json::Value hydrateImageReferences(ObjectStore& store, const std::string& channelId, const Json::Value& request) {
    Json::Value result = request;
    size_t total = 0;
    for (auto& reference : result["reference_images"]) {
        const auto hash = json::str(reference, "content_hash");
        const auto key = json::str(reference, "object_key");
        const auto expected = "channels/" + channelId + "/image-references/" + hash + ".png";
        if (hash.size() != 64 || key != expected) throw std::runtime_error("invalid reference ownership");
        const auto bytes = store.get(key);
        if (!bytes || crypto::sha256Hex(*bytes) != hash) throw std::runtime_error("reference snapshot missing or checksum mismatch");
        total += bytes->size();
        if (total > 20 * 1024 * 1024) throw std::runtime_error("reference images exceed 20 MB");
        reference["data_uri"] = "data:" + json::str(reference, "mime") + ";base64," + drogon::utils::base64Encode(*bytes);
    }
    return result;
}
}
