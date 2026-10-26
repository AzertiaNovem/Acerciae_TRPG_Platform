#include "Visibility.h"
#include "../core/Errors.h"
#include <regex>

namespace acerciae {

bool Visibility::isUuid(const std::string& s) {
    static const std::regex re("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    return std::regex_match(s, re);
}

std::string Visibility::uuidArray(const std::vector<std::string>& ids) {
    std::string out = "'{";
    bool first = true;
    for (auto& id : ids) {
        if (!isUuid(id)) throw badRequest("invalid uuid: " + id);
        if (!first) out += ",";
        out += id; first = false;
    }
    out += "}'::uuid[]";
    return out;
}

std::string Visibility::factFilter(const ChannelAccess& a, const std::string& f) {
    if (a.isGm) return "TRUE";
    return "EXISTS (SELECT 1 FROM knowledge_visibility kv WHERE kv.fact_id = " + f + ".id AND (kv.scope='public' OR (kv.scope='character' AND kv.character_id = ANY(" + uuidArray(a.characterIds) + "))))";
}

std::string Visibility::messageFilter(const ChannelAccess& a, const std::string& m) {
    if (a.isGm) return "TRUE";
    if (!isUuid(a.userId)) throw badRequest("invalid user id");
    return "(EXISTS (SELECT 1 FROM chat_window_members wm WHERE wm.chat_window_id = " + m + ".chat_window_id AND wm.user_id = '" + a.userId + "'::uuid) "
           "AND (" + m + ".visibility = 'window' OR (" + m + ".visibility = 'whisper' AND " + m + ".whisper_to && " + uuidArray(a.characterIds) + ")))";
}

std::string Visibility::eventFilter(const ChannelAccess& a, const std::string& e) {
    if (a.isGm) return "TRUE";
    return "(" + e + ".visibility = 'public' OR (" + e + ".visibility <> 'gm_only' AND " + e + ".audience && " + uuidArray(a.characterIds) + "))";
}

std::string Visibility::highlightFilter(const ChannelAccess& a, const std::string& h) {
    if (!isUuid(a.userId)) throw badRequest("invalid user id");
    std::string own = "(" + h + ".visibility_scope='user' AND " + h + ".user_id='" + a.userId + "'::uuid)";
    if (a.isGm) return "(" + h + ".visibility_scope IN ('gm','public','character') OR " + own + ")";
    return "(" + h + ".visibility_scope='public' OR (" + h + ".visibility_scope='character' AND " + h + ".character_id = ANY(" + uuidArray(a.characterIds) + ")) OR " + own + ")";
}

} // namespace acerciae
