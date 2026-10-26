#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>

namespace acerciae::logstudio {
// Visual style profiles and character visual profiles (identity traits, default standee, expressions).
class StyleService {
public:
    explicit StyleService(Db& db) : db_(db) {}
    Json::Value listStyles(const ChannelAccess& a);
    Json::Value createStyle(const ChannelAccess& a, const Json::Value& body);
    Json::Value updateStyle(const ChannelAccess& a, const std::string& id, const Json::Value& body);
    Json::Value defaultStyle(const std::string& channelId);
    Json::Value listCharacterVisuals(const ChannelAccess& a);
    Json::Value upsertCharacterVisual(const ChannelAccess& a, const std::string& characterId, const Json::Value& body);
private:
    Db& db_;
};
}
