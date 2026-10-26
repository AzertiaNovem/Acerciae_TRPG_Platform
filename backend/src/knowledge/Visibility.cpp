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

std::string Visibility::groupGuard(const ChannelAccess& a) {
    if (!isUuid(a.playerGroupId)) return "FALSE";
    return "EXISTS(SELECT 1 FROM player_groups pg WHERE pg.id='"+a.playerGroupId+"'::uuid AND pg.version="+std::to_string(a.playerGroupVersion)+")";
}
std::string Visibility::partitionFilter(const ChannelAccess& a, const std::string& f) {
    if (a.isGm) return f+".player_group_id IS NULL";
    if (!isUuid(a.playerGroupId)) return "FALSE";
    return "("+f+".player_group_id='"+a.playerGroupId+"'::uuid AND "+groupGuard(a)+")";
}
std::string Visibility::factFilter(const ChannelAccess& a, const std::string& f) {
    auto partition=partitionFilter(a,f);
    if (a.isGm || !isUuid(a.playerGroupId)) return partition;
    return "("+partition+" AND cardinality("+f+".source_event_ids)>0 AND NOT EXISTS(SELECT 1 FROM unnest("+f+".source_event_ids) sid WHERE NOT EXISTS(SELECT 1 FROM player_group_chat_events ge WHERE ge.group_id='"+a.playerGroupId+"'::uuid AND ge.event_id=sid)))";
}

std::string Visibility::messageFilter(const ChannelAccess& a, const std::string& m) {
    if (a.isGm) return "TRUE";
    if (!isUuid(a.playerGroupId)) return "FALSE";
    return "("+groupGuard(a)+" AND EXISTS(SELECT 1 FROM player_group_readable_messages ge WHERE ge.group_id='"+a.playerGroupId+"'::uuid AND ge.message_id="+m+".id))";
}

std::string Visibility::eventFilter(const ChannelAccess& a, const std::string& e) {
    if (a.isGm) return "TRUE";
    if (!isUuid(a.playerGroupId)) return "FALSE";
    return "("+groupGuard(a)+" AND EXISTS(SELECT 1 FROM player_group_chat_events ge WHERE ge.group_id='"+a.playerGroupId+"'::uuid AND ge.event_id="+e+".id))";
}

std::string Visibility::highlightFilter(const ChannelAccess& a, const std::string& h) {
    if (!isUuid(a.userId)) throw badRequest("invalid user id");
    std::string own = "(" + h + ".visibility_scope='user' AND " + h + ".user_id='" + a.userId + "'::uuid)";
    std::string partition = "EXISTS(SELECT 1 FROM documents hd WHERE hd.id="+h+".document_id AND "+partitionFilter(a,"hd")+") AND ";
    if (a.isGm) return partition + "(" + h + ".visibility_scope IN ('gm','public','character') OR " + own + ")";
    return partition + "(" + h + ".visibility_scope='public' OR (" + h + ".visibility_scope='character' AND " + h + ".character_id = ANY(" + uuidArray(a.characterIds) + ")) OR " + own + ")";
}

} // namespace acerciae
