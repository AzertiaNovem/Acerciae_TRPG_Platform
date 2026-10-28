#include "Notifier.h"
#include "WsGateway.h"
#include "../core/Json.h"
#include "../knowledge/Visibility.h"
#include "../chat/ChatService.h"
#include <set>

namespace acerciae {

std::vector<std::string> Notifier::gmUsers(const std::string& channelId) {
    std::vector<std::string> out;
    for (auto& r : db_.queryJson("SELECT user_id FROM channel_members WHERE channel_id=$1 AND role='gm'", {channelId})) out.push_back(r["user_id"].asString());
    return out;
}
std::vector<std::string> Notifier::windowUsers(const std::string& chatWindowId) {
    std::vector<std::string> out;
    for (auto& r : db_.queryJson("SELECT user_id FROM chat_window_members WHERE chat_window_id=$1", {chatWindowId})) out.push_back(r["user_id"].asString());
    return out;
}
std::vector<std::string> Notifier::usersOfCharacters(const std::vector<std::string>& ids) {
    std::vector<std::string> out;
    if (ids.empty()) return out;
    for (auto& r : db_.queryJson("SELECT DISTINCT user_id FROM characters WHERE user_id IS NOT NULL AND id = ANY(" + Visibility::uuidArray(ids) + ")"))
        out.push_back(r["user_id"].asString());
    return out;
}

static WsGateway::UserFilter setFilter(std::set<std::string> allowed) {
    return [allowed = std::move(allowed)](const std::string& u) { return allowed.count(u) > 0; };
}

void Notifier::messagePosted(const Json::Value& m) {
    auto channelId = m["channel_id"].asString();
    auto windowId = m["chat_window_id"].asString();
    auto vis = m["visibility"].asString();
    std::set<std::string> allowed;
    for (auto& u : gmUsers(channelId)) allowed.insert(u);
    if (vis == "window") for (auto& u : windowUsers(windowId)) allowed.insert(u);
    else if (vis == "whisper") for (auto& u : usersOfCharacters(json::strArray(m["whisper_to"]))) allowed.insert(u);
    for(const auto& r : db_.queryJson("SELECT DISTINCT pm.user_id FROM player_group_members pm JOIN player_group_readable_messages ge ON ge.group_id=pm.group_id WHERE ge.message_id=$1",{m["id"].asString()})) allowed.insert(r["user_id"].asString());
    Json::Value msg; msg["type"] = "message.posted"; msg["channel_id"] = channelId; msg["message"] = m;
    WsGateway::instance().broadcast("chat", channelId, msg, setFilter(std::move(allowed)));
    // Spectators: public lines of the Main Chat only, to members (not guests) of a server that still allows it.
    auto key = WsGateway::spectateKey(channelId);
    if (vis == "window" && WsGateway::instance().hasSubscribers("chat", key)) {
        auto ok = db_.queryOne("SELECT c.server_id FROM chat_windows w JOIN channels c ON c.id=w.channel_id JOIN server_settings ss ON ss.server_id=c.server_id "
                               "WHERE w.id=$1 AND w.kind='main' AND ss.main_chat_spectators", {windowId});
        if (!ok.isNull()) {
            std::set<std::string> members;
            for (auto& r : db_.queryJson("SELECT user_id FROM server_members WHERE server_id=$1 AND role<>'guest'", {ok["server_id"].asString()})) members.insert(r["user_id"].asString());
            Json::Value spec; spec["type"] = "spectate.message"; spec["channel_id"] = channelId; spec["message"] = ChatService::spectatorMessage(m);
            WsGateway::instance().broadcast("chat", key, spec, setFilter(std::move(members)));
        }
    }
}
void Notifier::knowledgeChanged(const std::string& channelId) {
    Json::Value msg; msg["type"]="knowledge.reset"; msg["channel_id"]=channelId;
    WsGateway::instance().broadcast("context",channelId,msg);
}
void Notifier::windowChanged(const std::string& channelId, const Json::Value& window) {
    knowledgeChanged(channelId);
    Json::Value msg; msg["type"] = "window.changed"; msg["channel_id"] = channelId; msg["window"]["id"] = window["id"];
    WsGateway::instance().broadcast("chat", channelId, msg);
}
void Notifier::revokeChannel(const std::string& userId, const std::string& channelId) {
    WsGateway::instance().dropSubscription(userId, channelId);
}
void Notifier::revokeServer(const std::string& userId, const std::string& serverId) {
    for (auto& r : db_.queryJson("SELECT id FROM channels WHERE server_id=$1", {serverId})) WsGateway::instance().dropSubscription(userId, r["id"].asString());
}
void Notifier::channelDeleted(const std::string& serverId, const std::string& channelId, const std::vector<std::string>& members) {
    WsGateway::instance().dropChannel(channelId);
    Json::Value msg; msg["type"] = "channel.deleted"; msg["server_id"] = serverId; msg["channel_id"] = channelId;
    for (auto& u : members) WsGateway::instance().sendToUser("chat", u, msg);
}
void Notifier::serverDeleted(const std::string& serverId, const std::vector<std::string>& channels, const std::vector<std::string>& members) {
    for (auto& c : channels) WsGateway::instance().dropChannel(c);
    Json::Value msg; msg["type"] = "server.deleted"; msg["server_id"] = serverId;
    for (auto& u : members) WsGateway::instance().sendToUser("chat", u, msg);
}
void Notifier::channelUpdated(const std::string& channelId) {
    Json::Value msg; msg["type"] = "channel.updated"; msg["channel_id"] = channelId;
    WsGateway::instance().broadcast("chat", channelId, msg);
}
void Notifier::sceneChanged(const std::string& channelId, const Json::Value& scene) {
    Json::Value msg; msg["type"] = "scene.changed"; msg["channel_id"] = channelId; msg["scene"] = scene;
    std::set<std::string> allowed; for(const auto& u : gmUsers(channelId)) allowed.insert(u);
    WsGateway::instance().broadcast("chat", channelId, msg, setFilter(allowed));
    WsGateway::instance().broadcast("context", channelId, msg, setFilter(allowed));
}
void Notifier::characterUpdated(const std::string& channelId, const Json::Value& c) {
    Json::Value msg; msg["type"] = "character.updated"; msg["channel_id"] = channelId; msg["character"] = c;
    if (json::str(c, "kind") == "npc") {
        std::set<std::string> gms; for (auto& u : gmUsers(channelId)) gms.insert(u);
        WsGateway::instance().broadcast("chat", channelId, msg, setFilter(std::move(gms)));
    } else WsGateway::instance().broadcast("chat", channelId, msg);
}
void Notifier::serverSettingsChanged(const std::string& serverId, const Json::Value& settings) {
    Json::Value msg; msg["type"] = "server.settings"; msg["server_id"] = serverId; msg["settings"] = settings;
    for (auto& r : db_.queryJson("SELECT id FROM channels WHERE server_id=$1", {serverId})) {
        msg["channel_id"] = r["id"];
        WsGateway::instance().broadcast("chat", r["id"].asString(), msg);
    }
}
void Notifier::documentUpdated(const std::string& channelId, const Json::Value& payload) {
    Json::Value msg; msg["type"] = "document.updated"; msg["channel_id"] = channelId;
    for (auto it = payload.begin(); it != payload.end(); ++it) msg[it.name()] = *it;
    std::set<std::string> allowed;
    auto doc=db_.queryOne("SELECT player_group_id FROM documents WHERE id=$1 AND channel_id=$2",{json::str(payload,"document_id"),channelId});
    if(doc.isNull()) return;
    if(doc["player_group_id"].isNull()) for(const auto& u : gmUsers(channelId)) allowed.insert(u);
    else for(const auto& r : db_.queryJson("SELECT user_id FROM player_group_members WHERE group_id=$1",{doc["player_group_id"].asString()})) allowed.insert(r["user_id"].asString());
    WsGateway::instance().broadcast("context",channelId,msg,setFilter(std::move(allowed)));
}
void Notifier::highlightCreated(const std::string& channelId, const Json::Value& h) {
    Json::Value msg; msg["type"] = "highlight.created"; msg["channel_id"] = channelId; msg["highlight"] = h;
    auto doc=db_.queryOne("SELECT player_group_id FROM documents WHERE id=$1 AND channel_id=$2",{json::str(h,"document_id"),channelId});
    if(doc.isNull()) return;
    std::set<std::string> allowed;
    if(doc["player_group_id"].isNull()) for(const auto& u : gmUsers(channelId)) allowed.insert(u);
    else for(const auto& r : db_.queryJson("SELECT user_id FROM player_group_members WHERE group_id=$1",{doc["player_group_id"].asString()})) allowed.insert(r["user_id"].asString());
    if(json::str(h,"visibility_scope")=="user") {
        auto uid=json::str(h,"user_id"); bool included=allowed.count(uid); allowed.clear(); if(included) allowed.insert(uid);
    }
    WsGateway::instance().broadcast("context",channelId,msg,setFilter(std::move(allowed)));
}
void Notifier::highlightExpired(const std::string& channelId, const std::vector<std::string>& ids) {
    Json::Value msg; msg["type"] = "highlight.expired"; msg["channel_id"] = channelId; msg["highlight_ids"] = json::fromStrArray(ids);
    WsGateway::instance().broadcast("context", channelId, msg);
}
void Notifier::proposalPending(const std::string& channelId, const Json::Value& p) {
    Json::Value msg; msg["type"] = "proposal.pending"; msg["channel_id"] = channelId; msg["proposal"] = p;
    std::set<std::string> gms; for (auto& u : gmUsers(channelId)) gms.insert(u);
    WsGateway::instance().broadcast("context", channelId, msg, setFilter(std::move(gms)));
}
void Notifier::moduleUpdated(const std::string& channelId, const Json::Value& payload) {
    Json::Value msg; msg["type"] = "module.updated"; msg["channel_id"] = channelId;
    for (auto it = payload.begin(); it != payload.end(); ++it) msg[it.name()] = *it;
    std::set<std::string> gms; for (auto& u : gmUsers(channelId)) gms.insert(u);
    WsGateway::instance().broadcast("context", channelId, msg, setFilter(std::move(gms)));
}
void Notifier::reminderCreated(const std::string& channelId, const Json::Value& r) {
    Json::Value msg; msg["type"] = "reminder.created"; msg["channel_id"] = channelId; msg["reminder"] = r;
    std::set<std::string> allowed;
    if (r["player_group_id"].isString()) for (const auto& m : db_.queryJson("SELECT user_id FROM player_group_members WHERE group_id=$1", {r["player_group_id"].asString()})) allowed.insert(m["user_id"].asString());
    else for (const auto& u : gmUsers(channelId)) allowed.insert(u);
    WsGateway::instance().broadcast("context", channelId, msg, setFilter(std::move(allowed)));
}
void Notifier::kpBoardUpdated(const std::string& channelId, const Json::Value& board) {
    Json::Value msg; msg["type"] = "kp.board"; msg["channel_id"] = channelId; msg["board"] = board;
    std::set<std::string> allowed; for (const auto& u : gmUsers(channelId)) allowed.insert(u);
    WsGateway::instance().broadcast("context", channelId, msg, setFilter(std::move(allowed)));
}
void Notifier::scriptKnowledgeChanged(const std::string& channelId, const Json::Value& payload) {
    Json::Value msg; msg["type"] = "script.changed"; msg["channel_id"] = channelId; msg["payload"] = payload;
    std::set<std::string> allowed; for (const auto& u : gmUsers(channelId)) allowed.insert(u);
    WsGateway::instance().broadcast("context", channelId, msg, setFilter(std::move(allowed)));
}
void Notifier::aiJobFinished(const std::string& channelId, const Json::Value& job) {
    Json::Value msg; msg["type"] = "ai.job"; msg["channel_id"] = channelId; msg["job"] = job;
    std::set<std::string> gms; for (auto& u : gmUsers(channelId)) gms.insert(u);
    WsGateway::instance().broadcast("context", channelId, msg, setFilter(std::move(gms)));
}

} // namespace acerciae

namespace acerciae {
void Notifier::studioEvent(const std::string& channelId, const std::string& kind, const Json::Value& payload, bool gmOnly) {
    Json::Value msg; msg["type"] = "studio." + kind; msg["channel_id"] = channelId; msg["payload"] = payload;
    if (gmOnly) { std::set<std::string> gms; for (auto& u : gmUsers(channelId)) gms.insert(u); WsGateway::instance().broadcast("context", channelId, msg, setFilter(std::move(gms))); }
    else WsGateway::instance().broadcast("context", channelId, msg);
}
}
