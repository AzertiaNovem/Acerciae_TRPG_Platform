#pragma once
#include "Pbta.h"

namespace acerciae::pbta {
// Prepared and committed in the same transaction as the chat message and
// narrative event.
struct Ruling {
  std::string op, intent, roll, section, field, repeated, text;
  Json::Value card, source, updated, command;
  std::vector<std::string> refs;
  void finish(pqxx::work &w, const std::string &message,
              const std::string &actor) const;
};
Json::Value rulingHistory(Db &db, const ChannelAccess &access,
                          const std::string &window, int64_t before);
Ruling prepareRuling(pqxx::work &w, const ChannelAccess &a,
                     const std::string &window, const std::string &actor,
                     const Json::Value &request, const std::string &move,
                     const std::string &visibility,
                     const std::vector<std::string> &recipients);
} // namespace acerciae::pbta
