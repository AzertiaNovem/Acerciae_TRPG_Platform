#pragma once
#include "../core/Config.h"
#include <string>
#include <memory>
#include <optional>

namespace acerciae::logstudio {

// Media bytes never live in PostgreSQL. Two backends: a local directory (development/default) and any
// S3-compatible service (MinIO, AWS S3, …) via AWS Signature V4 over libcurl.
class ObjectStore {
public:
    virtual ~ObjectStore() = default;
    virtual void put(const std::string& key, const std::string& bytes, const std::string& contentType) = 0;
    virtual std::optional<std::string> get(const std::string& key) = 0;
    virtual bool exists(const std::string& key) = 0;
    virtual void remove(const std::string& key) = 0;
    virtual std::string kind() const = 0;
};

std::unique_ptr<ObjectStore> makeObjectStore(const Config& cfg);   // chooses by OBJECT_STORE=local|s3
std::string safeObjectKey(const std::string& channelId, const std::string& category, const std::string& ext);

} // namespace
