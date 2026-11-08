#pragma once
#include <drogon/WebSocketController.h>
#include <json/json.h>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <chrono>
#include <set>
#include <string>
#include <vector>

namespace acerciae {

// Per-connection state. Two logical streams run over separate endpoints so that chat traffic and
// document/highlight traffic never compete: /ws/chat and /ws/context.
struct WsSession {
    std::string userId;
    std::string stream;                    // "chat" | "context"
    std::string sessionHash;               // the login session behind the socket (logout closes it)
    std::set<std::string> channels;        // subscribed channel ids (spectating: spectateKey(id))
};

class WsGateway {
public:
    static WsGateway& instance();

    void add(const drogon::WebSocketConnectionPtr& conn, std::shared_ptr<WsSession> s);
    void remove(const drogon::WebSocketConnectionPtr& conn);
    void subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& channelId);
    void unsubscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& channelId);

    // Push `msg` to every connection on `stream` subscribed to `channelId` whose user is accepted by `allow`.
    using UserFilter = std::function<bool(const std::string& userId)>;
    void broadcast(const std::string& stream, const std::string& channelId, const Json::Value& msg, UserFilter allow = nullptr);
    void sendToUser(const std::string& stream, const std::string& userId, const Json::Value& msg);
    std::size_t connectionCount() const;
    bool hasSubscribers(const std::string& stream, const std::string& channelId) const;
    // Revocation. Subscriptions are checked when made; these keep them honest afterwards.
    void closeSession(const std::string& sessionHash);                              // logout
    void dropSubscription(const std::string& userId, const std::string& channelId);   // removed from a channel
    void dropChannel(const std::string& channelId);                                   // the channel was deleted: nobody follows it
    // Re-checks every socket: `sessionValid(hash)` and `mayFollow(userId, channelKey)`; closes or unsubscribes the rest.
    void revalidate(const std::function<bool(const std::string&)>& sessionValid,
                    const std::function<bool(const std::string&, const std::string&)>& mayFollow);
    // Spectators subscribe under a separate key so channel broadcasts never reach them; only public Main Chat lines do.
    static std::string spectateKey(const std::string& channelId) { return "spectate:" + channelId; }

    // Typing flags, per character (not per user): a client raises one with a `typing` pack and keeps it up with another
    // every few seconds; it falls when the client sends `active: false`, when no pack came for kTypingTtl, or when the
    // socket closes. Each change goes to `audience` (the users who may read the window) as `typing.changed`.
    static constexpr std::chrono::seconds kTypingTtl{10};
    void setTyping(const drogon::WebSocketConnectionPtr& conn, const std::string& channelId, const std::string& chatWindowId,
                   const std::string& characterId, bool active, std::set<std::string> audience);
    void sweepTyping();   // drops flags whose heartbeats stopped; run every couple of seconds on the event loop
    // The flags of a channel the user may see: [{chat_window_id, character_id}] (for the `typing.snapshot` on subscribe).
    Json::Value typingSnapshot(const std::string& channelId, const std::string& userId);

private:
    struct Typing { std::string channelId, chatWindowId, characterId, userId; drogon::WebSocketConnectionPtr conn; std::set<std::string> audience; std::chrono::steady_clock::time_point until; };
    void announceTyping(const Typing& t, bool active);
    std::vector<Typing> dropTypingLocked(const std::function<bool(const Typing&)>& gone);   // under mu_: removes and returns the flags `gone` accepts
    mutable std::mutex mu_;
    std::map<drogon::WebSocketConnectionPtr, std::shared_ptr<WsSession>> conns_;
    std::map<std::string, Typing> typing_;   // by character id
};

// Shared implementation for both endpoints.
class WsEndpointBase {
protected:
    void onConnect(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn, const std::string& stream);
    void onMessage(const drogon::WebSocketConnectionPtr& conn, std::string&& message, const drogon::WebSocketMessageType& type);
    void onClose(const drogon::WebSocketConnectionPtr& conn);
};

class ChatWs : public drogon::WebSocketController<ChatWs>, private WsEndpointBase {
public:
    void handleNewMessage(const drogon::WebSocketConnectionPtr& c, std::string&& m, const drogon::WebSocketMessageType& t) override { onMessage(c, std::move(m), t); }
    void handleNewConnection(const drogon::HttpRequestPtr& r, const drogon::WebSocketConnectionPtr& c) override { onConnect(r, c, "chat"); }
    void handleConnectionClosed(const drogon::WebSocketConnectionPtr& c) override { onClose(c); }
    WS_PATH_LIST_BEGIN
    WS_PATH_ADD("/ws/chat");
    WS_PATH_LIST_END
};

class ContextWs : public drogon::WebSocketController<ContextWs>, private WsEndpointBase {
public:
    void handleNewMessage(const drogon::WebSocketConnectionPtr& c, std::string&& m, const drogon::WebSocketMessageType& t) override { onMessage(c, std::move(m), t); }
    void handleNewConnection(const drogon::HttpRequestPtr& r, const drogon::WebSocketConnectionPtr& c) override { onConnect(r, c, "context"); }
    void handleConnectionClosed(const drogon::WebSocketConnectionPtr& c) override { onClose(c); }
    WS_PATH_LIST_BEGIN
    WS_PATH_ADD("/ws/context");
    WS_PATH_LIST_END
};

} // namespace acerciae
