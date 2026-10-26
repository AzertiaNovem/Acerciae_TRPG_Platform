#pragma once
#include "../auth/AuthService.h"
#include <string>
#include <vector>

namespace acerciae {

// Builds SQL fragments that restrict rows to what a viewer may know.
// Facts: a GM sees everything. A player sees facts with a 'public' visibility row or a 'character'
// row for one of their characters. The fact alias must expose an `id` column.
struct Visibility {
    static std::string factFilter(const ChannelAccess& a, const std::string& factAlias = "f");
    // Messages: GM sees all; player sees 'window' messages of windows they belong to and whispers addressed to them.
    static std::string messageFilter(const ChannelAccess& a, const std::string& msgAlias = "m");
    // Events: GM sees all; player sees events whose audience includes one of their characters or that are public.
    static std::string eventFilter(const ChannelAccess& a, const std::string& evAlias = "e");
    // Highlights: GM sees gm+public; player sees public, their characters', and their own user-scoped ones.
    static std::string highlightFilter(const ChannelAccess& a, const std::string& alias = "h");
    static std::string uuidArray(const std::vector<std::string>& ids);   // validated '{...}'::uuid[]
    static bool isUuid(const std::string& s);
};

} // namespace acerciae
