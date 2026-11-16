#include "Forge.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Crypto.h"
namespace acerciae::forge {
bool hasPlay(pqxx::work& w, const std::string& channel) {
    return !Db::queryOne(w,"SELECT 1 AS played FROM messages m JOIN chat_windows cw ON cw.id=m.chat_window_id WHERE m.channel_id=$1 AND cw.purpose='story' AND m.kind IN ('ic','narration','roll') LIMIT 1",{channel}).isNull();
}
Json::Value receipt(pqxx::work& w, const ChannelAccess& a, const std::string& op, const Json::Value& body) {
    auto key=json::str(body,"request_id");
    if(key.empty()) return Json::Value();
    if(key.size()>160) throw badRequest("request_id must be at most 160 bytes");
    Db::queryOne(w,"SELECT pg_advisory_xact_lock(hashtext($1))",{a.channelId+":"+a.userId+":"+op+":"+key});
    auto r=Db::queryOne(w,"SELECT fingerprint,result FROM agent_receipts WHERE channel_id=$1 AND actor_id=$2 AND operation=$3 AND request_id=$4",{a.channelId,a.userId,op,key});
    if(r.isNull()) return r;
    if(r["fingerprint"]!=crypto::sha256Hex(json::dump(body))) throw conflict("request_id was already used with different content");
    return r["result"];
}
void remember(pqxx::work& w, const ChannelAccess& a, const std::string& op, const Json::Value& body, const Json::Value& result) {
    auto key=json::str(body,"request_id"); if(key.empty()) return;
    Db::exec(w,"INSERT INTO agent_receipts(channel_id,actor_id,operation,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)",{a.channelId,a.userId,op,key,crypto::sha256Hex(json::dump(body)),json::dump(result)});
}
}
