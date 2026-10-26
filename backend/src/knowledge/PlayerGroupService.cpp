#include "KnowledgeService.h"
#include "../core/Errors.h"
#include "../core/Text.h"
#include "../core/Json.h"

namespace acerciae {
Json::Value KnowledgeService::playerGroups(const ChannelAccess& a) {
    std::string filter = a.isGm ? "" : " AND EXISTS(SELECT 1 FROM player_group_members pm WHERE pm.group_id=g.id AND pm.user_id=$2)";
    DbParams p{a.channelId}; if (!a.isGm) p.push_back(a.userId);
    return db_.queryJson("SELECT g.*,coalesce((SELECT json_agg(json_build_object('user_id',pm.user_id,'display_name',u.display_name)) FROM player_group_members pm JOIN users u ON u.id=pm.user_id WHERE pm.group_id=g.id),'[]'::json) AS members FROM player_groups g WHERE g.channel_id=$1"+filter+" ORDER BY g.created_at",p);
}
static std::string groupName(const std::string& name) {
    auto n=text::trim(name);
    size_t characters=0;
    for(unsigned char byte:n) if((byte & 0xc0)!=0x80) ++characters;
    if(n.empty() || characters>100) throw badRequest("Group name must contain 1–100 characters");
    return n;
}
Json::Value KnowledgeService::createPlayerGroup(const ChannelAccess& a,const std::string& name) {
    if(!a.isGm) throw forbidden("GM role required");
    auto n=groupName(name);
    return db_.tx([&](pqxx::work& w) {
        auto g=Db::queryOne(w,"INSERT INTO player_groups(channel_id,name) VALUES($1,$2) RETURNING *",{a.channelId,n});
        Db::exec(w,"SELECT reset_player_memory($1)",{g["id"].asString()}); return g;
    });
}
Json::Value KnowledgeService::renamePlayerGroup(const ChannelAccess& a,const std::string& groupId,const std::string& name) {
    if(!a.isGm) throw forbidden("GM role required");
    auto g=db_.queryOne("UPDATE player_groups SET name=$3,updated_at=now() WHERE id=$1 AND channel_id=$2 RETURNING *",{groupId,a.channelId,groupName(name)});
    if(g.isNull()) throw notFound("player group not found"); return g;
}
Json::Value KnowledgeService::movePlayer(const ChannelAccess& a,const std::string& groupId,const std::string& userId) {
    if(!a.isGm) throw forbidden("GM role required");
    db_.tx([&](pqxx::work& w) {
        Db::queryOne(w,"SELECT id FROM channels WHERE id=$1 FOR UPDATE",{a.channelId});
        auto g=Db::queryOne(w,"SELECT id FROM player_groups WHERE id=$1 AND channel_id=$2",{groupId,a.channelId});
        if(g.isNull()) throw notFound("player group not found");
        auto m=Db::queryOne(w,"SELECT role FROM channel_members WHERE channel_id=$1 AND user_id=$2",{a.channelId,userId});
        if(m.isNull() || m["role"].asString()!="player") throw badRequest("Only channel players can be grouped");
        auto old=Db::queryOne(w,"SELECT group_id FROM player_group_members WHERE channel_id=$1 AND user_id=$2",{a.channelId,userId});
        if(!old.isNull() && old["group_id"].asString()==groupId) return;
        Json::Value audit; audit["user_id"]=userId; audit["from_group_id"]=old["group_id"]; audit["to_group_id"]=groupId;
        Db::exec(w,"INSERT INTO events(channel_id,actor_user_id,actor_role,kind,payload,visibility) VALUES($1,$2,'gm','player_group.changed',$3::jsonb,'gm_only')",{a.channelId,a.userId,json::dump(audit)});
        Db::exec(w,"INSERT INTO player_group_members(group_id,channel_id,user_id) VALUES($1,$2,$3) ON CONFLICT(channel_id,user_id) DO UPDATE SET group_id=EXCLUDED.group_id",{groupId,a.channelId,userId});
    });
    return playerGroups(a);
}
}
