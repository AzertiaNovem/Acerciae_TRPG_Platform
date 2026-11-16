#pragma once
#include "../auth/AuthService.h"
namespace acerciae::inventory {
Json::Value read(Db& db, const ChannelAccess& a);
Json::Value apply(Db& db, const ChannelAccess& a, const Json::Value& body);
// Check a full-card save against a guarded inventory while the character row is locked.
void checkCard(const Json::Value& current, const Json::Value& body, const Json::Value& items);
}
