#include "Inventory.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Crypto.h"
#include "../knowledge/Visibility.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <set>

namespace acerciae::inventory {
namespace {
void gm(const ChannelAccess& a) { if (!a.isGm) throw forbidden("Only the GM may manage story inventory"); }
Json::Value itemsOf(const Json::Value& c) { return c["role_card"]["items"].isArray() ? c["role_card"]["items"] : Json::Value(Json::arrayValue); }
void validate(const Json::Value& items) {
    if (!items.isArray() || items.size()>60) throw badRequest("Inventory must contain at most 60 items");
    for (const auto& i : items) {
        if (!i.isObject() || !i["name"].isString() || i["name"].asString().empty() || i["name"].asString().size()>320 ||
            !i["note"].isString() || i["note"].asString().size()>1200 || !i["qty"].isNumeric() ||
            !std::isfinite(i["qty"].asDouble()) || i["qty"].asDouble()<0 || i["qty"].asDouble()>9999)
            throw badRequest("Invalid inventory item");
        for (const auto& k : i.getMemberNames()) if (k!="name" && k!="note" && k!="qty") throw badRequest("Unknown inventory item field");
    }
}
Json::Value view(const Json::Value& c) {
    Json::Value v; v["id"]=c["id"]; v["name"]=c["name"]; v["items"]=itemsOf(c);
    v["version"]=c["inventory_version"]; return v;
}
}
Json::Value read(Db& db, const ChannelAccess& a) {
    gm(a); Json::Value out; out["supported"]=true; out["characters"]=Json::Value(Json::arrayValue);
    for (const auto& c : db.queryJson("SELECT id,name,role_card,inventory_version FROM characters WHERE channel_id=$1 ORDER BY id",{a.channelId})) out["characters"].append(view(c));
    return out;
}
void checkCard(const Json::Value& current, const Json::Value& body, const Json::Value& items) {
    if (body.isMember("expected_inventory_version") && (!body["expected_inventory_version"].isInt64() || body["expected_inventory_version"].asInt64()<0)) throw badRequest("Invalid inventory version");
    if (body.isMember("expected_inventory_version") && body["expected_inventory_version"]!=current["inventory_version"])
        throw conflict("Inventory changed. Reload the character before saving; your draft can be kept.");
    if (current["inventory_guarded"].asBool() && itemsOf(current)!=items && !body.isMember("expected_inventory_version"))
        throw conflict("This inventory is managed during play. Reload it with an updated client before saving.");
}
Json::Value apply(Db& db, const ChannelAccess& a, const Json::Value& body) {
    gm(a);
    const auto key=json::str(body,"request_id"), reason=json::str(body,"reason");
    if(key.empty() || key.size()>160 || reason.empty() || reason.size()>3200) throw badRequest("request_id and reason required");
    if(!body["issued_at"].isInt64()) throw badRequest("issued_at must be epoch milliseconds");
    const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    // Old requests cannot execute again after receipts have been pruned.
    const auto issued=body["issued_at"].asInt64();
    const auto& changes=body["changes"];
    if(!changes.isArray() || changes.empty() || changes.size()>8) throw badRequest("1–8 inventory changes required");
    std::set<std::string> ids;
    for(const auto& c:changes) {
        const auto cid=json::str(c,"character_id");
        if(!Visibility::isUuid(cid) || !ids.insert(cid).second || !c["expected_version"].isInt64() || c["expected_version"].asInt64()<0) throw badRequest("Invalid or duplicate character/version");
        validate(c["items"]);
    }
    return db.tx([&](pqxx::work& w) {
        Db::queryOne(w,"SELECT pg_advisory_xact_lock(hashtext($1))",{a.channelId+":"+a.userId+":inventory:"+key});
        const auto fp=crypto::sha256Hex(json::dump(body));
        const auto receipt=Db::queryOne(w,"SELECT fingerprint,result FROM inventory_operations WHERE channel_id=$1 AND actor_id=$2 AND request_id=$3",{a.channelId,a.userId,key});
        if(!receipt.isNull()) {
            if(receipt["fingerprint"]!=fp) throw conflict("Inventory request ID reused with different content");
            return receipt["result"];
        }
        if(issued>now+300000 || issued<now-7LL*86400000) throw ApiError(409,"inventory_request_expired","Inventory request expired; reconcile its saved result before continuing");
        Json::Value out; out["request_id"]=key; out["characters"]=Json::Value(Json::arrayValue);
        // Lock in stable order, including both sides of a transfer.
        for(const auto& cid:ids) {
            const auto cur=Db::queryOne(w,"SELECT id,name,role_card,inventory_version FROM characters WHERE id=$1 AND channel_id=$2 FOR UPDATE",{cid,a.channelId});
            if(cur.isNull()) throw notFound("Inventory character not in this channel");
            const Json::Value* change=nullptr;
            for(const auto& c:changes) if(c["character_id"]==cid) change=&c;
            if(cur["inventory_version"]!=(*change)["expected_version"]) throw conflict("Inventory changed; read the latest inventory and revise the operation");
            auto row=Db::queryOne(w,"UPDATE characters SET role_card=jsonb_set(coalesce(role_card,'{}'::jsonb),'{items}',$3::jsonb),inventory_version=inventory_version+1,inventory_guarded=true,updated_at=now() WHERE id=$1 AND channel_id=$2 RETURNING id,name,role_card,inventory_version",{cid,a.channelId,json::dump((*change)["items"])});
            auto v=view(row); v["before_items"]=itemsOf(cur); out["characters"].append(v);
        }
        Db::exec(w,"INSERT INTO inventory_operations(channel_id,actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5::jsonb)",{a.channelId,a.userId,key,fp,json::dump(out)});
        Db::exec(w,"DELETE FROM inventory_operations WHERE channel_id=$1 AND created_at<now()-interval '30 days'",{a.channelId});
        return out;
    });
}
}
