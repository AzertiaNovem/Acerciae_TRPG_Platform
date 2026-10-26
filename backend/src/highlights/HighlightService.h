#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <map>
#include <vector>

namespace acerciae {
class Notifier;

struct NewHighlight {
    std::string channelId, documentId, entryId, reason;
    std::string kind = "association";             // association | consistency | potential_association | correction
    std::vector<std::string> sourceEventIds;
    int priority = 1;
    std::string visibilityScope = "public";       // gm | public | character | user
    std::string characterId, userId;
    int ttlSeconds = 900;
    Json::Value textRange;                        // optional {start,end}
};

// Short-term attention. Highlights point at document entries; they expire, can be dismissed, and
// never carry knowledge of their own (reason text must not leak GM secrets to players).
class HighlightService {
public:
    HighlightService(Db& db, Notifier& n, int defaultTtl) : db_(db), notifier_(n), defaultTtl_(defaultTtl) {}
    Json::Value create(const NewHighlight& h, bool notify = true);
    Json::Value listActive(const ChannelAccess& a, const std::string& documentId);
    Json::Value dismiss(const ChannelAccess& a, const std::string& highlightId);
    // Removes expired highlights; returns channel -> ids for notification.
    std::map<std::string, std::vector<std::string>> cleanupExpired();
    int defaultTtl() const { return defaultTtl_; }
private:
    Db& db_; Notifier& notifier_; int defaultTtl_;
};
}
