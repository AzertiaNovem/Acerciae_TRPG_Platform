#pragma once
#include "ObjectStore.h"
#include <json/json.h>

namespace acerciae::logstudio {
// A private, content-addressed snapshot survives replacement/deletion of the source asset.
Json::Value freezeImageReference(ObjectStore& store, const std::string& channelId,
                                Json::Value reference, const std::string& bytes, const std::string& mime);
// Converts legacy inline references in place, only after their objects have been stored successfully.
bool externalizeImageReferences(ObjectStore& store, const std::string& channelId, Json::Value& request);
// Builds the provider payload in memory. Never persist the returned data URIs.
Json::Value hydrateImageReferences(ObjectStore& store, const std::string& channelId, const Json::Value& request);
}
