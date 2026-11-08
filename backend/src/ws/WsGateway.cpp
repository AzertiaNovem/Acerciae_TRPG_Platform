#include "WsGateway.h"
#include "../app/Services.h"
#include "../auth/AuthService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../chat/ChatService.h"
#include "../knowledge/Visibility.h"
#include <optional>

namespace acerciae {

WsGateway& WsGateway::instance() { static WsGateway g; return g; }

void WsGateway::add(const drogon::WebSocketConnectionPtr& conn, std::shared_ptr<WsSession> s) {
    std::lock_guard<std::mutex> lk(mu_);
    conns_[conn] = std::move(s);
}
void WsGateway::remove(const drogon::WebSocketConnectionPtr& conn) {
    std::vector<Typing> dropped;
    {
        std::lock_guard<std::mutex> lk(mu_);
        conns_.erase(conn);
        dropped = dropTypingLocked([&](const Typing& t) { return t.conn == conn; });   // a closed socket types no more
    }
    for (const auto& t : dropped) announceTyping(t, false);
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

void WsGateway::closeSession(const std::string& sessionHash) {
    if (sessionHash.empty()) return;
    std::vector<drogon::WebSocketConnectionPtr> targets;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& [conn, s] : conns_) if (s->sessionHash == sessionHash) { s->channels.clear(); targets.push_back(conn); }
    }
    for (auto& c : targets) c->shutdown(drogon::CloseCode::kNormalClosure, "signed out");
}
void WsGateway::dropSubscription(const std::string& userId, const std::string& channelId) {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& [conn, s] : conns_) if (s->userId == userId) { s->channels.erase(channelId); s->channels.erase(spectateKey(channelId)); }
}
void WsGateway::dropChannel(const std::string& channelId) {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& [conn, s] : conns_) { s->channels.erase(channelId); s->channels.erase(spectateKey(channelId)); }
}
void WsGateway::revalidate(const std::function<bool(const std::string&)>& sessionValid,
                           const std::function<bool(const std::string&, const std::string&)>& mayFollow) {
    struct Item { drogon::WebSocketConnectionPtr conn; std::string user, hash; std::set<std::string> channels; };
    std::vector<Item> items;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& [conn, s] : conns_) items.push_back({conn, s->userId, s->sessionHash, s->channels});
    }
    // Database checks run without the lock; the results are applied afterwards.
    std::map<std::string, bool> sessions;
    for (auto& it : items) {
        if (!sessions.count(it.hash)) sessions[it.hash] = sessionValid(it.hash);
        if (!sessions[it.hash]) {
            { std::lock_guard<std::mutex> lk(mu_); if (auto f = conns_.find(it.conn); f != conns_.end()) f->second->channels.clear(); }
            it.conn->shutdown(drogon::CloseCode::kNormalClosure, "session ended");
            continue;
        }
        for (auto& ch : it.channels) if (!mayFollow(it.user, ch)) { std::lock_guard<std::mutex> lk(mu_); if (auto f = conns_.find(it.conn); f != conns_.end()) f->second->channels.erase(ch); }
    }
}
bool WsGateway::hasSubscribers(const std::string& stream, const std::string& channelId) const {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& [conn, s] : conns_) if (s->stream == stream && s->channels.count(channelId)) return true;
    return false;
}

// ---- typing flags ----------------------------------------------------------------------------

std::vector<WsGateway::Typing> WsGateway::dropTypingLocked(const std::function<bool(const Typing&)>& gone) {
    std::vector<Typing> out;
    for (auto it = typing_.begin(); it != typing_.end();) {
        if (gone(it->second)) { out.push_back(std::move(it->second)); it = typing_.erase(it); } else ++it;
    }
    return out;
}
void WsGateway::announceTyping(const Typing& t, bool active) {
    Json::Value msg; msg["type"] = "typing.changed"; msg["channel_id"] = t.channelId; msg["chat_window_id"] = t.chatWindowId;
    msg["character_id"] = t.characterId; msg["active"] = active;
    broadcast("chat", t.channelId, msg, [allowed = t.audience](const std::string& u) { return allowed.count(u) > 0; });
}
void WsGateway::setTyping(const drogon::WebSocketConnectionPtr& conn, const std::string& channelId, const std::string& chatWindowId,
                          const std::string& characterId, bool active, std::set<std::string> audience) {
    std::vector<Typing> fallen; std::optional<Typing> raised;
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto session = conns_.find(conn);
        if (session == conns_.end()) return;   // closed meanwhile: remove() lowered whatever it held
        const auto& userId = session->second->userId;
        auto it = typing_.find(characterId);
        if (!active) {
            // Only the socket that raised it (or another of the same user, after a reconnect) lowers it.
            if (it != typing_.end() && (it->second.conn == conn || it->second.userId == userId)) { fallen.push_back(std::move(it->second)); typing_.erase(it); }
        } else {
            const auto until = std::chrono::steady_clock::now() + kTypingTtl;
            if (it != typing_.end() && it->second.chatWindowId == chatWindowId) { it->second.until = until; it->second.conn = conn; it->second.audience = std::move(audience); }   // a heartbeat
            else {
                if (it != typing_.end()) { fallen.push_back(std::move(it->second)); typing_.erase(it); }   // the same character, now in another window
                Typing t{channelId, chatWindowId, characterId, userId, conn, std::move(audience), until};
                typing_[characterId] = t; raised = std::move(t);
            }
        }
    }
    for (const auto& t : fallen) announceTyping(t, false);
    if (raised) announceTyping(*raised, true);
}
void WsGateway::sweepTyping() {
    std::vector<Typing> expired;
    {
        std::lock_guard<std::mutex> lk(mu_);
        const auto now = std::chrono::steady_clock::now();
        expired = dropTypingLocked([&](const Typing& t) { return t.until <= now; });
    }
    for (const auto& t : expired) announceTyping(t, false);
}
Json::Value WsGateway::typingSnapshot(const std::string& channelId, const std::string& userId) {
    Json::Value out(Json::arrayValue);
    std::lock_guard<std::mutex> lk(mu_);
    for (const auto& [cid, t] : typing_) {
        if (t.channelId != channelId || !t.audience.count(userId)) continue;
        Json::Value x; x["chat_window_id"] = t.chatWindowId; x["character_id"] = cid; out.append(x);
    }
    return out;
}

// Who may see a character typing in a window: the GMs, the window's members whose view is not paused, and (in the Main
// Chat, or when the channel's knowledge is public) every member of the channel. An NPC's typing is the GM's secret.
static std::set<std::string> typingAudience(const std::string& channelId, const std::string& chatWindowId, bool npc) {
    auto& db = *services().db;
    std::set<std::string> out;
    for (auto& r : db.queryJson("SELECT user_id FROM channel_members WHERE channel_id=$1 AND role='gm'", {channelId})) out.insert(r["user_id"].asString());
    if (npc) return out;
    auto w = db.queryOne("SELECT w.kind, c.knowledge_mode FROM chat_windows w JOIN channels c ON c.id=w.channel_id WHERE w.id=$1 AND w.channel_id=$2", {chatWindowId, channelId});
    if (w.isNull()) return out;
    if (w["kind"].asString() == "main" || w["knowledge_mode"].asString() == "public")
        for (auto& r : db.queryJson("SELECT user_id FROM channel_members WHERE channel_id=$1", {channelId})) out.insert(r["user_id"].asString());
    else
        for (auto& r : db.queryJson("SELECT user_id FROM chat_window_members WHERE chat_window_id=$1 AND NOT visibility_paused", {chatWindowId})) out.insert(r["user_id"].asString());
    return out;
}

std::size_t WsGateway::connectionCount() const { std::lock_guard<std::mutex> lk(mu_); return conns_.size(); }

// ---- endpoints -------------------------------------------------------------------------------

void WsEndpointBase::onConnect(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn, const std::string& stream) {
    // Browsers cannot set headers on a WebSocket: the URL carries a short-lived file token (or, for other
    // clients, the session token).
    auto token = req->getParameter("token");
    auto p = token.rfind("f1.", 0) == 0 ? services().auth->authenticateFileToken(token) : services().auth->authenticate(token);
    if (!p) {
        Json::Value err; err["type"] = "error"; err["error"] = "unauthorized";
        conn->send(json::dump(err));
        conn->shutdown(drogon::CloseCode::kViolation, "unauthorized");
        return;
    }
    auto s = std::make_shared<WsSession>();
    s->userId = p->userId; s->stream = stream; s->sessionHash = services().auth->sessionHashOf(token);
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
            if (!json::toBool(msg, "spectate")) {
                // Who is typing already, so a client that (re)connects does not wait for the next change.
                Json::Value snap; snap["type"] = "typing.snapshot"; snap["channel_id"] = ch; snap["typing"] = WsGateway::instance().typingSnapshot(ch, s->userId);
                conn->send(json::dump(reply)); conn->send(json::dump(snap));
                return;
            }
        } else if (t == "unsubscribe") {
            auto ch = json::requireStr(msg, "channel_id");
            WsGateway::instance().unsubscribe(conn, json::toBool(msg, "spectate") ? WsGateway::spectateKey(ch) : ch);
            reply["type"] = "unsubscribed"; reply["channel_id"] = ch;
        } else if (t == "ping") {
            reply["type"] = "pong";
        } else if (t == "typing") {
            // {channel_id, chat_window_id, character_id, active}: the character is being written as (the sender's own, or
            // any for the GM) in a window the sender belongs to. Heartbeats get no reply.
            auto ch = json::requireStr(msg, "channel_id"), win = json::requireStr(msg, "chat_window_id"), cid = json::requireStr(msg, "character_id");
            if (!Visibility::isUuid(win) || !Visibility::isUuid(cid)) throw badRequest("invalid window or character id");
            auto a = services().auth->channelAccess(s->userId, ch);
            services().auth->requireWindowMember(a, win);
            auto c = services().db->queryOne("SELECT kind, user_id FROM characters WHERE id=$1 AND channel_id=$2", {cid, ch});
            if (c.isNull()) throw notFound("character not found");
            const bool npc = c["kind"].asString() == "npc";
            if (!a.isGm && (npc || json::str(c, "user_id") != s->userId)) throw forbidden("not your character");
            const bool active = json::toBool(msg, "active", true);
            WsGateway::instance().setTyping(conn, ch, win, cid, active, active ? typingAudience(ch, win, npc) : std::set<std::string>{});
            return;
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
