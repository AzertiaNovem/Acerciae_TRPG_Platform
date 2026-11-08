#pragma once
#include "../core/Db.h"
namespace acerciae::chatQueries {
extern const std::string ON_MOVE_RECORD;
extern const std::string RECALL_WINDOW;
extern const std::string RECALL_SECONDS_LEFT;
extern const std::string MSG_SELECT;
extern const std::string WINDOW_HISTORY;
std::string serverRole(Db& db, const std::string& serverId, const std::string& userId);
}
