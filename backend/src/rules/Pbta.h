#pragma once
#include "../auth/AuthService.h"
#include "../dice/Dice.h"

namespace acerciae::pbta {
Json::Value read(Db &db, const ChannelAccess &a);
Json::Value preview(const ChannelAccess &a, const Json::Value &pack);
Json::Value replace(Db &db, const ChannelAccess &a, const Json::Value &body);
Json::Value lockedPack(pqxx::work &w, const std::string &channel);
Json::Value normalizeCard(const Json::Value &card, const Json::Value &pack);
Json::Value resolve(const Json::Value &row, const Json::Value &card,
                    const std::string &args, dice::Rng &rng);
void addContext(Db &db, const ChannelAccess &a, const std::string &character,
                Json::Value &ctx);
} // namespace acerciae::pbta
