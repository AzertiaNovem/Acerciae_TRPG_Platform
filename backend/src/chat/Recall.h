#pragma once
#include "../core/Db.h"
#include <string>
#include <vector>

namespace acerciae {
class DocumentService; class Notifier;

// What was made of recalled chat lines after they were said. `eventIds` are the events of recalled messages, already
// deleted: highlights and reminders that cite one are dismissed, and Keeper journal entries whose every source is
// gone are retracted (a revision records it). Player memory needs nothing: a player group only ever sees facts whose
// every source is still a readable chat line.
namespace recall {
void forget(Db& db, DocumentService& docs, Notifier& notifier, const std::string& channelId, const std::vector<std::string>& eventIds);
// The ids of `eventIds` that no longer exist: lines recalled while an observer batch that held them was running.
std::vector<std::string> gone(Db& db, const std::string& channelId, const std::vector<std::string>& eventIds);
}
}
