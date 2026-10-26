#pragma once
#include "../auth/AuthService.h"
#include <string>
#include <vector>

namespace acerciae {

// Builds SQL fragments that restrict rows to what a viewer may know.
// Memory: KP records and each player group's records are independent partitions.
// Player facts additionally require readable chat provenance and a current group generation.
struct Visibility {
    static std::string partitionFilter(const ChannelAccess& a, const std::string& alias);
    static std::string groupGuard(const ChannelAccess& a);
    static std::string factFilter(const ChannelAccess& a, const std::string& factAlias = "f");
    // Messages: GM sees all; players share the union of their group's authorized chat perspectives.
    static std::string messageFilter(const ChannelAccess& a, const std::string& msgAlias = "m");
    // Events: GM sees all; players see only events backed by readable chat.
    static std::string eventFilter(const ChannelAccess& a, const std::string& evAlias = "e");
    // Highlights follow the document partition and any narrower user target.
    static std::string highlightFilter(const ChannelAccess& a, const std::string& alias = "h");
    static std::string uuidArray(const std::vector<std::string>& ids);   // validated '{...}'::uuid[]
    static bool isUuid(const std::string& s);
};

} // namespace acerciae
