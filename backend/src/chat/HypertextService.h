#pragma once
#include "../core/Db.h"
#include "../core/Config.h"
#include "../core/Throttle.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <string>

namespace acerciae {
class ChatService; class EventStore; class SceneManager; class Notifier;

// Interactive messages (messages.kind = 'hypertext', docs/HYPERTEXT.md): a channel GM posts a card through the API;
// each viewer's app renders it and, on the viewer's own gesture, may save the viewer's state, post one line as the
// viewer and ask for one of the sender's private reply templates. Every rule of the card format is in Hypertext.h;
// this is the database side: posting, the per-viewer state, the actions with their limits and replays, closing.
// - A card never changes once posted. Closing is a side status (hypertext_cards.closed_at, or closes_at passing).
// - A viewer's state (hypertext_states) is readable only by that viewer, through any route; GMs and bots never read it.
// - An action posts its lines through ChatService::postMessage with a HypertextOrigin, so the audience, character,
//   dice and events follow the normal path, inside the card's audience or a narrower one.
// - The sender's reply templates (hypertext_cards.replies) never leave the server: a client names a reply and fills
//   its declared slots, and responses carry only the lines the clicker may read, re-selected for the clicker.
// Errors carry details in the body (ApiError details): 400 invalid_hypertext {errors: [{path, message}]}, 400
// invalid_state {key}, 409 state_conflict {state, version}, 429 rate_limited {retry_after}.
class HypertextService {
public:
    static constexpr int kPostsPerMinute = 20;                          // cards per author and channel
    static constexpr int kActsPerCard = 10, kActsPerChannel = 30;       // actions per user per minute (failed ones count)
    static constexpr int kRepliesPerCard = 60;                          // replies a card may be asked for per minute
    static constexpr int kStatePerMinute = 120;                         // state saves per user
    static constexpr int kLeaseSeconds = 30;                            // how long an action holds its claim
    static constexpr int kMaxStatusIds = 100;
    static constexpr int kMinClosesIn = 60, kMaxClosesIn = 30 * 86400, kDefaultClosesIn = 7 * 86400;

    HypertextService(const Config& cfg, Db& db, AuthService& auth, ChatService& chat, EventStore& events, SceneManager& scenes, Notifier& notifier)
        : cfg_(cfg), db_(db), auth_(auth), chat_(chat), events_(events), scenes_(scenes), notifier_(notifier) {}

    bool enabled() const { return cfg_.hypertextEnabled; }
    void requireEnabled() const;   // HYPERTEXT_ENABLED=false: 403 feature_disabled (post, saveState, act and close check it first)

    // POST /windows/{w}/hypertext (a channel GM who is in the window): {content?, character_id?, visibility?,
    // whisper_to?, closes_in?, hypertext, replies?}. Posted as the GM's message of kind hypertext; `content` is the
    // given text or hypertext::fallbackText. Returns the message row.
    Json::Value post(const ChannelAccess& a, const std::string& windowId, const Json::Value& body);
    // GET /hypertext?ids= (at most 100, comma-separated): {enabled, items: [{message_id, closes_at, closed_at, state,
    // version, runs_left}]} for the readable, not recalled cards among them; state and version are the caller's own.
    Json::Value status(const ChannelAccess& a, const std::string& ids);
    // PUT /messages/{m}/hypertext/state {state, base_version}: compare-and-swap of the caller's state (base_version 0
    // creates it); pushes hypertext.state to the caller's own sockets. Returns {message_id, state, version}.
    Json::Value saveState(const ChannelAccess& a, const std::string& messageId, const Json::Value& body);
    // POST /messages/{m}/hypertext/act {interaction_id, node?, say?, reply?, state?, base_version}: at most one line as
    // the caller (say) and one of the sender's replies, in that order, then the state. The same interaction id
    // replays its result, a finished one before the card's other checks (it may have closed since). Claims, state
    // saves, endings, close and recall take the card's lock; a line is posted only while its claim is pending and the
    // card not recalled (ChatService::postMessage), and an action ends from the lines that are there (finish).
    // Returns {interaction_id, replayed, partial, results: [{type, ok, message, error?}], state}.
    Json::Value act(const ChannelAccess& a, const std::string& messageId, const Json::Value& body);
    // POST /messages/{m}/hypertext/close (any channel GM; repeating it is a no-op): pushes hypertext.closed.
    Json::Value close(const ChannelAccess& a, const std::string& messageId);

    // Maintenance, every minute: actions whose claim lapsed more than 2 minutes ago are finished without posting
    // anything more (the server never acts as the viewer on its own): `done` with the lines they already posted
    // (partial when one is missing), `failed` when they posted none. Returns how many were finished.
    int finishAbandoned(int limit = 100);
    // Maintenance, hourly: interaction rows of cards closed (or past closes_at) more than a day ago.
    int prune(int limit = 5000);

private:
    struct Act;   // a validated /act request
    Json::Value loadCard(const ChannelAccess& a, const std::string& messageId);
    void requireUsable(const ChannelAccess& a, const Json::Value& card);   // member, open window, not paused, open card, actor
    static void requireOpen(pqxx::work& w, const std::string& cardId);    // under the card's lock: not recalled (404), not closed (409)
    Json::Value replay(const ChannelAccess& a, const Json::Value& card, const Act& act, const Json::Value& row);
    Json::Value finish(pqxx::work& w, const std::string& rowId, const Json::Value& errors, const Json::Value& failure);
    void planReply(const ChannelAccess& a, const Json::Value& card, Act& act);
    Json::Value respond(const ChannelAccess& a, const Json::Value& card, const std::string& interactionId, const Json::Value& resultIds, const Json::Value& errors, bool replayed);
    std::string postedLine(const std::string& cardId, const std::string& userId, const std::string& interactionId, int effect);
    const Config& cfg_; Db& db_; AuthService& auth_; ChatService& chat_; EventStore& events_; SceneManager& scenes_; Notifier& notifier_;
    Throttle stateSaves_{kStatePerMinute, std::chrono::seconds(60)};
};

} // namespace acerciae
