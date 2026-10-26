#include "Notifier.h"
#include "WsGateway.h"
#include "../core/Json.h"
#include "../knowledge/Visibility.h"
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
    Json::Value msg; msg["type"] = "message.posted"; msg["channel_id"] = channelId; msg["message"] = m;
    WsGateway::instance().broadcast("chat", channelId, msg, setFilter(std::move(allowed)));
}
void Notifier::windowChanged(const std::string& channelId, const Json::Value& window) {
    Json::Value msg; msg["type"] = "window.changed"; msg["channel_id"] = channelId; msg["window"] = window;
    WsGateway::instance().broadcast("chat", channelId, msg);
}
void Notifier::sceneChanged(const std::string& channelId, const Json::Value& scene) {
    Json::Value msg; msg["type"] = "scene.changed"; msg["channel_id"] = channelId; msg["scene"] = scene;
    WsGateway::instance().broadcast("chat", channelId, msg);
    WsGateway::instance().broadcast("context", channelId, msg);
}
void Notifier::documentUpdated(const std::string& channelId, const Json::Value& payload) {
    Json::Value msg; msg["type"] = "document.updated"; msg["channel_id"] = channelId;
    for (auto it = payload.begin(); it != payload.end(); ++it) msg[it.name()] = *it;
    if (json::toBool(payload, "gm_only")) {
        std::set<std::string> gms; for (auto& u : gmUsers(channelId)) gms.insert(u);
        WsGateway::instance().broadcast("context", channelId, msg, setFilter(std::move(gms)));
    } else {
        // Entry-level visibility is enforced when the client refetches the document.
        WsGateway::instance().broadcast("context", channelId, msg);
    }
}
void Notifier::highlightCreated(const std::string& channelId, const Json::Value& h) {
    Json::Value msg; msg["type"] = "highlight.created"; msg["channel_id"] = channelId; msg["highlight"] = h;
    auto scope = json::str(h, "visibility_scope");
    if (scope == "public") { WsGateway::instance().broadcast("context", channelId, msg); return; }
    std::set<std::string> allowed;
    if (scope == "gm") for (auto& u : gmUsers(channelId)) allowed.insert(u);
    else if (scope == "character") { for (auto& u : usersOfCharacters({json::str(h, "character_id")})) allowed.insert(u); for (auto& u : gmUsers(channelId)) allowed.insert(u); }
    else if (scope == "user") allowed.insert(json::str(h, "user_id"));
    WsGateway::instance().broadcast("context", channelId, msg, setFilter(std::move(allowed)));
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
