#pragma once
#include "../auth/AuthService.h"
namespace acerciae::forge {
bool hasPlay(pqxx::work& w, const std::string& channel);
Json::Value receipt(pqxx::work& w, const ChannelAccess& a, const std::string& operation, const Json::Value& body);
void remember(pqxx::work& w, const ChannelAccess& a, const std::string& operation, const Json::Value& body, const Json::Value& result);
}
