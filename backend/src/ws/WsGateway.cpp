#include "WsGateway.h"
#include "../app/Services.h"
#include "../auth/AuthService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../chat/ChatService.h"

namespace acerciae {

WsGateway& WsGateway::instance() { static WsGateway g; return g; }

void WsGateway::add(const drogon::WebSocketConnectionPtr& conn, std::shared_ptr<WsSession> s) {
    std::lock_guard<std::mutex> lk(mu_);
    conns_[conn] = std::move(s);
}
void WsGateway::remove(const drogon::WebSocketConnectionPtr& conn) {
    std::lock_guard<std::mutex> lk(mu_);
    conns_.erase(conn);
}
void WsGateway::subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& channelId) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = conns_.find(conn);
    if (it != conns_.end()) it->second->channels.insert(channelId);
}
void WsGateway::unsubscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& channelId) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = conns_.find(conn);
    if (it != conns_.end()) it->second->channels.erase(channelId);
}

void WsGateway::broadcast(const std::string& stream, const std::string& channelId, const Json::Value& msg, UserFilter allow) {
    std::vector<drogon::WebSocketConnectionPtr> targets;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& [conn, s] : conns_) {
            if (s->stream != stream || !s->channels.count(channelId)) continue;
            if (allow && !allow(s->userId)) continue;
            targets.push_back(conn);
        }
    }
    if (targets.empty()) return;
    auto text = json::dump(msg);
    for (auto& c : targets) if (c->connected()) c->send(text);
}

void WsGateway::sendToUser(const std::string& stream, const std::string& userId, const Json::Value& msg) {
    std::vector<drogon::WebSocketConnectionPtr> targets;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& [conn, s] : conns_) if (s->stream == stream && s->userId == userId) targets.push_back(conn);
    }
    auto text = json::dump(msg);
    for (auto& c : targets) if (c->connected()) c->send(text);
}

bool WsGateway::hasSubscribers(const std::string& stream, const std::string& channelId) const {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& [conn, s] : conns_) if (s->stream == stream && s->channels.count(channelId)) return true;
    return false;
}

std::size_t WsGateway::connectionCount() const { std::lock_guard<std::mutex> lk(mu_); return conns_.size(); }

// ---- endpoints -------------------------------------------------------------------------------

void WsEndpointBase::onConnect(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn, const std::string& stream) {
    auto token = req->getParameter("token");
    auto p = services().auth->authenticate(token);
    if (!p) {
        Json::Value err; err["type"] = "error"; err["error"] = "unauthorized";
        conn->send(json::dump(err));
        conn->shutdown(drogon::CloseCode::kViolation, "unauthorized");
        return;
    }
    auto s = std::make_shared<WsSession>();
    s->userId = p->userId; s->stream = stream;
    conn->setContext(s);
    WsGateway::instance().add(conn, s);
    Json::Value hello; hello["type"] = "hello"; hello["stream"] = stream; hello["user_id"] = p->userId;
    conn->send(json::dump(hello));
}

void WsEndpointBase::onMessage(const drogon::WebSocketConnectionPtr& conn, std::string&& message, const drogon::WebSocketMessageType& type) {
    if (type == drogon::WebSocketMessageType::Ping) { conn->send("", drogon::WebSocketMessageType::Pong); return; }
    if (type != drogon::WebSocketMessageType::Text) return;
    auto s = conn->getContext<WsSession>();
    if (!s) return;
    Json::Value msg;
    try { msg = json::parse(message); } catch (...) { return; }
    auto t = json::str(msg, "type");
    Json::Value reply;
    try {
        if (t == "subscribe") {
            auto ch = json::requireStr(msg, "channel_id");
            if (json::toBool(msg, "spectate")) {
                // Read-only Main Chat of a channel the user was not invited to (when the server allows it).
                if (!services().chat->canSpectate(s->userId, ch)) throw forbidden("spectating is not allowed here");
                WsGateway::instance().subscribe(conn, WsGateway::spectateKey(ch));
                reply["spectate"] = true;
            } else {
                services().auth->channelAccess(s->userId, ch);    // throws when not a member
                WsGateway::instance().subscribe(conn, ch);
            }
            reply["type"] = "subscribed"; reply["channel_id"] = ch;
        } else if (t == "unsubscribe") {
            auto ch = json::requireStr(msg, "channel_id");
            WsGateway::instance().unsubscribe(conn, json::toBool(msg, "spectate") ? WsGateway::spectateKey(ch) : ch);
            reply["type"] = "unsubscribed"; reply["channel_id"] = ch;
        } else if (t == "ping") {
            reply["type"] = "pong";
        } else {
            reply["type"] = "error"; reply["error"] = "unknown message type";
        }
    } catch (const ApiError& e) {
        reply["type"] = "error"; reply["error"] = e.what();
    } catch (const std::exception&) {
        reply["type"] = "error"; reply["error"] = "invalid request";
    }
    conn->send(json::dump(reply));
}

void WsEndpointBase::onClose(const drogon::WebSocketConnectionPtr& conn) {
    WsGateway::instance().remove(conn);
}

} // namespace acerciae
