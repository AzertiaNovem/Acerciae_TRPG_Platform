#pragma once
#include <json/json.h>
#include <string>

namespace acerciae::logstudio::contentPolicy {
// Pure decisions. Callers must first establish current channel membership and query
// the source/owner in that channel. No database, storage or notification side effects.
inline bool privateArt(const Json::Value& asset) {
    return asset["source_reference"].isMember("private_presentation_id") || asset["source_reference"].isMember("private_chat_window_id");
}
inline bool sharedMedia(const Json::Value& asset) {
    return !privateArt(asset) && asset["visibility_scope"] == "channel" && asset["approval_status"] == "approved";
}
inline bool readMedia(bool gm, bool ownsSource, const Json::Value& asset) {
    return gm || (asset["approval_status"] == "approved" &&
                  (privateArt(asset) ? ownsSource : asset["visibility_scope"] == "channel"));
}
inline bool retainMedia(const Json::Value& asset) {
    return sharedMedia(asset) && asset["character_kind"] != "npc";
}
inline bool exportMedia(const Json::Value& asset, bool shared) {
    return asset["approval_status"] == "approved" && (!shared || sharedMedia(asset));
}
inline bool publishSnapshot(const std::string& scope, const std::string& audience) {
    return audience == "gm" || scope == "pl_public";
}
inline bool readSnapshot(bool gm, bool ownsCharacter, bool storyEnded, const std::string& scope) {
    return gm || scope == "pl_public" || (scope == "character" && (ownsCharacter || storyEnded));
}
inline bool publicRaster(const std::string& source, const std::string& mime) {
    return (source == "generated" || source == "mock") && mime.rfind("image/", 0) == 0 && mime != "image/svg+xml";
}
inline bool publicObject(const std::string& source, const std::string& mime, const Json::Value& asset) {
    return !privateArt(asset) && publicRaster(source, mime);
}
}
