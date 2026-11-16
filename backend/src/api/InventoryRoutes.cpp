#include "../app/Services.h"
#include "../characters/Inventory.h"
#include "../ws/Notifier.h"
#include "../chat/ChatQueries.h"
#include "RouteSupport.h"
#include "Routes.h"
using namespace drogon;
namespace acerciae::http {
void registerInventoryRoutes() {
    auto& S=services();
    route1("/api/channels/{1}/inventory",{Get},[&](auto&,auto& p,auto& a){return inventory::read(*S.db,access(p,a[0]));});
    route1("/api/channels/{1}/inventory",{Post},[&](auto& req,auto& p,auto& a){
        auto result=inventory::apply(*S.db,access(p,a[0]),body(req));
        for(const auto& c:result["characters"]) {
            auto row=S.db->queryOne("SELECT * FROM characters WHERE id=$1 AND channel_id=$2",{c["id"].asString(),a[0]});
            if(!row.isNull()) S.notifier->characterUpdated(a[0],row);
        }
        return result;
    });
    // A cancellation takes the same channel lock as postMessage. A late original request cannot publish afterwards.
    route2("/api/channels/{1}/agent-messages/{2}",{Get,Delete},[&](auto& req,auto& p,auto& a){
        const auto ac=access(p,a[0]); S.auth->requireGm(ac);
        if(a[1].empty() || a[1].size()>160) throw badRequest("Invalid story message request ID");
        return S.db->tx([&](pqxx::work& w){
            if(req->method()==Delete) {
                Db::queryOne(w,"SELECT id FROM channels WHERE id=$1 FOR NO KEY UPDATE",{a[0]});
                Db::exec(w,"INSERT INTO agent_message_receipts(channel_id,actor_id,request_id,cancelled) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING",{a[0],ac.userId,a[1]});
            }
            auto r=Db::queryOne(w,"SELECT message_id,cancelled FROM agent_message_receipts WHERE channel_id=$1 AND actor_id=$2 AND request_id=$3",{a[0],ac.userId,a[1]});
            Json::Value out; out["cancelled"]=!r.isNull() && r["cancelled"].asBool();
            out["message"]=r["message_id"].isNull()?Json::Value():Db::queryOne(w,chatQueries::MSG_SELECT+"WHERE m.id=$1",{r["message_id"].asString()});
            return out;
        });
    });
}
}
