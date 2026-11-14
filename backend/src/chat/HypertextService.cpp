#include "HypertextService.h"
#include "Hypertext.h"
#include "ChatService.h"
#include "ChatQueries.h"
#include "../events/EventStore.h"
#include "../scenes/SceneManager.h"
#include "../ws/Notifier.h"
#include "../knowledge/Visibility.h"
#include "../core/Crypto.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../core/Log.h"
#include "../dice/Dice.h"
#include <algorithm>
#include <map>
#include <optional>
#include <set>

namespace acerciae {
using namespace chatQueries;
namespace ht = hypertext;

namespace {
// A key a client sent, as it may appear in an error message: printable ASCII, bounded.
std::string printable(const std::string& k) {
    std::string o;
    for (unsigned char c : k) { if (o.size() >= 40) { o += "..."; break; } o += c >= 0x20 && c < 0x7F ? (char)c : '?'; }
    return o;
}
ApiError invalidEffect(const std::string& m) { return ApiError(400, "invalid_effect", m); }
ApiError invalidSlot(const std::string& m) { return ApiError(400, "invalid_slot", m); }
// One error of a posted card, with its path in the body (the shape normalize reports).
ApiError invalidCard(const std::string& path, const std::string& m) {
    Json::Value d, e; e["path"] = path; e["message"] = m; d["errors"].append(e);
    return ApiError(400, "invalid_hypertext", path + ": " + m, d);
}
ApiError rateLimited(const std::string& m, int retryAfter) { Json::Value d; d["retry_after"] = std::max(1, retryAfter); return ApiError(429, "rate_limited", m, d); }
ApiError closedCard() { return ApiError(409, "hypertext_closed", "This message is closed"); }
ApiError senderUnavailable() { return ApiError(409, "sender_unavailable", "This message's sender is no longer a GM of this channel, so it cannot reply"); }
ApiError inProgress() { return ApiError(409, "interaction_in_progress", "An action on this message is still being posted; try again in a moment"); }
void onlyKeys(const Json::Value& o, std::initializer_list<const char*> keys, const std::string& what, ApiError (*err)(const std::string&)) {
    for (const auto& k : o.getMemberNames())
        if (std::none_of(keys.begin(), keys.end(), [&](const char* x) { return k == x; })) throw err(what + " has an unknown key \"" + printable(k) + "\"");
}
bool present(const Json::Value& o, const char* k) { return o.isObject() && o.isMember(k) && !o[k].isNull(); }
// {status, error, message, details?}: how a failed action is replayed.
Json::Value errorJson(const ApiError& e) {
    Json::Value v; v["status"] = e.status(); v["error"] = e.code(); v["message"] = e.what();
    if (e.details().isObject()) v["details"] = e.details();
    return v;
}
ApiError fromJson(const Json::Value& v) {
    return ApiError(v.get("status", 409).asInt(), json::str(v, "error", "conflict"), json::str(v, "message", "This action failed"), v["details"].isObject() ? v["details"] : Json::Value());
}
// The card's lock: claims, state saves, endings, closing and recall (ChatService::recallMessage) take it first.
const char* kLock = "SELECT pg_advisory_xact_lock(hashtext('acerciae.hypertext.' || $1))";
Json::Value interrupted() { Json::Value x; x["error"] = "interrupted"; x["message"] = "The action was interrupted before this line was posted"; return x; }
Json::Value interruptedAction() {
    Json::Value e; e["status"] = 409; e["error"] = "interaction_interrupted"; e["message"] = "This action was interrupted before anything was posted; try it again";
    return e;
}
} // namespace

// A validated /act request: what is posted, with which audience, and its normalized form (hashed for replays).
struct HypertextService::Act {
    std::string interactionId, node;
    bool say = false, confirmed = false; std::string sayText, sayKind = "ic", sayCharacter;
    bool reply = false; std::string replyId, replyGroup; Json::Value slots;
    ChannelAccess sender; HypertextOrigin replyOrigin; Json::Value replyBody;
    bool hasState = false; Json::Value state; int64_t baseVersion = 0;
    Json::Value request; std::string hash;
};

void HypertextService::requireEnabled() const {
    if (!enabled()) throw ApiError(403, "feature_disabled", "Interactive messages are turned off on this platform");
}

// The card as its reader may use it; 404 for a missing, recalled or unreadable one. `replies` (the private templates)
// stays on the server.
Json::Value HypertextService::loadCard(const ChannelAccess& a, const std::string& messageId) {
    if (!Visibility::isUuid(messageId)) throw notFound("message not found");
    auto c = db_.queryOne(
        "SELECT m.id, m.channel_id, m.chat_window_id, m.author_id, m.visibility, m.whisper_to, m.hypertext, w.archived_at, hc.replies, hc.closes_at, hc.closed_at, "
        "(hc.closed_at IS NOT NULL OR hc.closes_at <= now()) AS closed, " + Visibility::messageFilter(a) + " AS readable "
        "FROM messages m JOIN chat_windows w ON w.id=m.chat_window_id JOIN hypertext_cards hc ON hc.message_id=m.id "
        "WHERE m.id=$1 AND m.channel_id=$2 AND m.kind='hypertext' AND m.recalled_at IS NULL", {messageId, a.channelId});
    if (c.isNull() || !c["readable"].asBool()) throw notFound("message not found");
    return c;
}

// Using a card (saving its state or acting on it) asks what posting in its window asks, and that it is open and the
// caller one of its actors (GMs always are).
void HypertextService::requireUsable(const ChannelAccess& a, const Json::Value& card) {
    auto windowId = card["chat_window_id"].asString();
    auth_.requireWindowMember(a, windowId);
    if (!card["archived_at"].isNull()) throw conflict("This window is archived. Restore it or fork it to continue.");
    if (!a.isGm && !db_.queryOne("SELECT 1 AS paused FROM chat_window_members WHERE chat_window_id=$1 AND user_id=$2 AND visibility_paused", {windowId, a.userId}).isNull())
        throw forbidden("Your participation in this window is paused");
    if (card["closed"].asBool()) throw closedCard();
    const auto& actors = card["hypertext"]["actors"];
    if (!a.isGm && actors.isArray() && !actors.empty()) {
        auto wc = auth_.windowCharacter(a.userId, windowId);
        if (!wc || std::none_of(actors.begin(), actors.end(), [&](const Json::Value& x) { return x.asString() == text::lower(*wc); }))
            throw ApiError(403, "not_an_actor", "This message is for other characters");
    }
}

// Under the card's lock: it was not recalled (404) or closed (409) since it was read, since both take that lock too.
void HypertextService::requireOpen(pqxx::work& w, const std::string& cardId) {
    auto c = Db::queryOne(w, "SELECT m.recalled_at IS NOT NULL AS recalled, (hc.closed_at IS NOT NULL OR hc.closes_at <= now()) AS closed "
                             "FROM messages m JOIN hypertext_cards hc ON hc.message_id=m.id WHERE m.id=$1", {cardId});
    if (c.isNull() || c["recalled"].asBool()) throw notFound("message not found");
    if (c["closed"].asBool()) throw closedCard();
}

Json::Value HypertextService::post(const ChannelAccess& a, const std::string& windowId, const Json::Value& body) {
    requireEnabled();
    auth_.requireGm(a);
    if (!Visibility::isUuid(windowId)) throw notFound("chat window not found");
    auth_.requireWindowMember(a, windowId);
    {   // Unknown keys anywhere are errors, the body's own included.
        static const std::set<std::string> keys = {"content", "character_id", "visibility", "whisper_to", "closes_in", "hypertext", "replies"};
        Json::Value errors(Json::arrayValue);
        for (const auto& k : body.getMemberNames()) if (!keys.count(k) && errors.size() < 10) { Json::Value e; e["path"] = printable(k); e["message"] = "unknown key"; errors.append(e); }
        if (!errors.empty()) { Json::Value d; d["errors"] = errors; throw ApiError(400, "invalid_hypertext", errors[0]["path"].asString() + ": unknown key", d); }
    }
    auto n = ht::normalize(body["hypertext"], body["replies"]);
    if (!n.ok) { Json::Value d; d["errors"] = n.details(); throw ApiError(400, "invalid_hypertext", n.errors.front().path + ": " + n.errors.front().message, d); }

    // Characters: the actors are characters of this channel; the card and each reply speak as an NPC, as the sender's
    // own character or as one with no player, never as another player's.
    auto speaker = [&](const std::string& id, const std::string& path) {
        auto c = db_.queryOne("SELECT kind, user_id FROM characters WHERE id=$1 AND channel_id=$2", {id, a.channelId});
        if (c.isNull()) throw invalidCard(path, "is not a character of this channel");
        if (json::str(c, "kind") == "pc" && !c["user_id"].isNull() && c["user_id"].asString() != a.userId)
            throw forbidden(path + " is another player's character: a card speaks as an NPC, as your own character or as one with no player");
    };
    const Json::Value actors = n.doc.get("actors", Json::Value());   // get(): operator[] would add a null member to the document
    if (actors.isArray() && !actors.empty()) {
        std::set<std::string> known;
        for (const auto& r : db_.queryJson("SELECT id FROM characters WHERE channel_id=$1 AND id = ANY($2::uuid[])", {a.channelId, pgArrayLiteral(json::strArray(actors))})) known.insert(r["id"].asString());
        for (Json::ArrayIndex i = 0; i < actors.size(); ++i)
            if (!known.count(actors[i].asString())) throw invalidCard("hypertext.actors[" + std::to_string(i) + "]", "is not a character of this channel");
    }
    std::string characterId;
    if (present(body, "character_id")) {
        if (!body["character_id"].isString() || !Visibility::isUuid(body["character_id"].asString())) throw invalidCard("character_id", "must be a character id or null");
        characterId = text::lower(body["character_id"].asString());
        speaker(characterId, "character_id");
    }
    for (const auto& id : n.replies.getMemberNames()) {
        auto rc = json::str(n.replies[id], "character_id");
        if (!rc.empty()) speaker(rc, "replies." + id + ".character_id");
    }
    // The plain text every other reader sees (search, logs, the AI, older apps): the GM's own, or the fallback.
    std::string content;
    if (present(body, "content")) {
        if (!body["content"].isString()) throw invalidCard("content", "must be a string");
        content = body["content"].asString();
        if (!content.empty()) { auto err = ht::contentError(content); if (!err.empty()) throw invalidCard("content", err); }
    }
    if (content.empty()) content = ht::fallbackText(n.doc);
    // The audience, as a GM's line at Messages.cpp.
    auto visibility = json::str(body, "visibility", "window");
    if (visibility != "window" && visibility != "gm_only" && visibility != "whisper") throw badRequest("invalid visibility");
    std::vector<std::string> whisperTo;
    if (present(body, "whisper_to")) {
        if (!body["whisper_to"].isArray()) throw invalidCard("whisper_to", "must be a list of character ids");
        for (const auto& x : body["whisper_to"]) {
            if (!x.isString() || !Visibility::isUuid(x.asString())) throw invalidCard("whisper_to", "must be a list of character ids");
            auto id = text::lower(x.asString());
            if (std::find(whisperTo.begin(), whisperTo.end(), id) == whisperTo.end()) whisperTo.push_back(id);
        }
    }
    if (visibility == "whisper" && whisperTo.empty()) throw badRequest("whisper_to required for whisper");
    if (visibility != "whisper") whisperTo.clear();
    int64_t closesIn = kDefaultClosesIn;
    if (present(body, "closes_in")) {
        const auto& v = body["closes_in"];
        if (!v.isInt64() || v.asInt64() < kMinClosesIn || v.asInt64() > kMaxClosesIn) throw invalidCard("closes_in", "must be a whole number of seconds from 60 to 2592000 (30 days)");
        closesIn = v.asInt64();
    }

    auto row = db_.tx([&](pqxx::work& w) {
        Db::queryOne(w, "SELECT id FROM channels WHERE id=$1 FOR NO KEY UPDATE", {a.channelId});
        // Counted under the channel's lock, so two posts at once cannot both take the last place.
        auto rate = Db::queryOne(w, "SELECT count(*) AS n, ceil(extract(epoch FROM min(created_at) + interval '1 minute' - now()))::int AS wait FROM messages "
                                    "WHERE channel_id=$1 AND author_id=$2 AND kind='hypertext' AND created_at > now() - interval '1 minute'", {a.channelId, a.userId});
        if (rate["n"].asInt() >= kPostsPerMinute) throw rateLimited("at most " + std::to_string(kPostsPerMinute) + " interactive messages a minute in a channel", rate["wait"].asInt());
        auto target = Db::queryOne(w, "SELECT archived_at FROM chat_windows WHERE id=$1 FOR SHARE", {windowId});
        if (!target["archived_at"].isNull()) throw conflict("This window is archived. Restore it or fork it to continue.");
        auto sceneId = scenes_.resolveSceneForWindow(w, a.channelId, windowId);
        auto closesAt = Db::queryOne(w, "SELECT now() + $1::bigint * interval '1 second' AS closes_at", {closesIn})["closes_at"].asString();   // (not "t": the name queryJson gives its CTE)
        auto doc = ht::publicDoc(n.doc, n.replies, closesAt);
        auto id = Db::queryOne(w,
            "INSERT INTO messages(channel_id, chat_window_id, scene_id, author_id, author_role, character_id, kind, content, visibility, whisper_to, hypertext, outfit_id) "
            "VALUES($1,$2,$3,$4,'gm',$5,'hypertext',$6,$7,$8::uuid[],$9::jsonb,(SELECT outfit_id FROM characters WHERE id=$5::uuid)) RETURNING id",
            {a.channelId, windowId, sceneId.empty() ? dbNull() : DbParam(sceneId), a.userId, characterId.empty() ? dbNull() : DbParam(characterId), content, visibility,
             pgArrayLiteral(whisperTo), json::dump(doc)})["id"].asString();
        Db::exec(w, "INSERT INTO hypertext_cards(message_id, replies, closes_at) VALUES($1,$2::jsonb,$3::timestamptz)", {id, json::dump(n.replies), closesAt});
        // The story's record holds the plain text only: never the document, its script or the templates.
        NewEvent e; e.channelId = a.channelId; e.chatWindowId = windowId; e.sceneId = sceneId; e.messageId = id; e.actorUserId = a.userId; e.actorRole = "gm";
        e.characterId = characterId; e.kind = "message.posted";
        if (visibility == "window") {
            for (auto& r : Db::queryJson(w, "SELECT character_id FROM chat_window_members WHERE chat_window_id=$1 AND character_id IS NOT NULL", {windowId})) e.audience.push_back(r["character_id"].asString());
        } else if (visibility == "whisper") { e.audience = whisperTo; e.visibility = "whisper"; }
        else e.visibility = "gm_only";
        e.payload["content"] = content; e.payload["message_kind"] = "hypertext";
        auto title = n.doc.get("title", "").asString();
        if (!title.empty()) e.payload["hypertext_title"] = title;
        events_.append(w, e);
        return Db::queryOne(w, MSG_SELECT + "WHERE m.id=$1", {id});
    });
    notifier_.messagePosted(row);
    return row;
}

Json::Value HypertextService::status(const ChannelAccess& a, const std::string& idsParam) {
    Json::Value out; out["enabled"] = enabled(); out["items"] = Json::Value(Json::arrayValue);
    if (!enabled()) return out;
    std::vector<std::string> ids;
    size_t start = 0;
    while (start <= idsParam.size()) {
        auto end = idsParam.find(',', start); if (end == std::string::npos) end = idsParam.size();
        auto id = text::lower(text::trim(idsParam.substr(start, end - start)));
        start = end + 1;
        if (id.empty()) continue;
        if (!Visibility::isUuid(id)) throw badRequest("ids must be message ids, separated by commas");
        if (std::find(ids.begin(), ids.end(), id) == ids.end()) ids.push_back(id);
        if (ids.size() > (size_t)kMaxStatusIds) throw badRequest("at most " + std::to_string(kMaxStatusIds) + " ids");
    }
    if (ids.empty()) return out;
    // Only the caller's own state; runs_left counts the actions that posted (or are posting) something.
    out["items"] = db_.queryJson(
        "SELECT m.id AS message_id, hc.closes_at, hc.closed_at, (hc.closed_at IS NOT NULL OR hc.closes_at <= now()) AS closed, s.state, coalesce(s.version, 0) AS version, "
        "greatest(0, coalesce((m.hypertext->>'runs_per_viewer')::int, 1) - (SELECT count(*) FROM hypertext_interactions i WHERE i.message_id=m.id AND i.user_id=$3 AND i.status IN ('pending','done')))::int AS runs_left "
        "FROM messages m JOIN hypertext_cards hc ON hc.message_id=m.id LEFT JOIN hypertext_states s ON s.message_id=m.id AND s.user_id=$3 "
        "WHERE m.id = ANY($1::uuid[]) AND m.channel_id=$2 AND m.kind='hypertext' AND m.recalled_at IS NULL AND " + Visibility::messageFilter(a) + " ORDER BY m.seq",
        {pgArrayLiteral(ids), a.channelId, a.userId});
    return out;
}

Json::Value HypertextService::saveState(const ChannelAccess& a, const std::string& messageId, const Json::Value& body) {
    requireEnabled();
    onlyKeys(body, {"state", "base_version"}, "the request", [](const std::string& m) { return ApiError(400, "invalid_state", m); });
    auto card = loadCard(a, messageId);
    requireUsable(a, card);
    auto chk = ht::validateState(card["hypertext"], body["state"]);
    if (!chk.ok) { Json::Value d; d["key"] = chk.key; throw ApiError(400, "invalid_state", (chk.key.empty() ? std::string("state") : "state." + printable(chk.key)) + ": " + chk.message, d); }
    if (!body["base_version"].isInt64() || body["base_version"].asInt64() < 0) throw ApiError(400, "invalid_state", "base_version must be the version the state was read at (0 when there is none yet)");
    const int64_t base = body["base_version"].asInt64();
    if (int wait = stateSaves_.retryAfter(a.userId)) throw rateLimited("too many state saves; try again shortly", wait);
    stateSaves_.hit(a.userId);
    Json::Value saved, current;
    const auto cardId = card["id"].asString();
    db_.tx([&](pqxx::work& w) {
        Db::exec(w, kLock, {cardId});
        requireOpen(w, cardId);   // a recall deletes the states: none is written after it
        // Compare and swap: the state the caller read is still the stored one (0: there is none yet).
        saved = base == 0
            ? Db::queryOne(w, "INSERT INTO hypertext_states(message_id, user_id, state, version) VALUES($1,$2,$3::jsonb,1) ON CONFLICT (message_id, user_id) DO NOTHING RETURNING state, version",
                           {cardId, a.userId, json::dump(chk.state)})
            : Db::queryOne(w, "UPDATE hypertext_states SET state=$3::jsonb, version=version+1, updated_at=now() WHERE message_id=$1 AND user_id=$2 AND version=$4 RETURNING state, version",
                           {cardId, a.userId, json::dump(chk.state), base});
        if (saved.isNull()) current = Db::queryOne(w, "SELECT state, version FROM hypertext_states WHERE message_id=$1 AND user_id=$2", {cardId, a.userId});
    });
    if (saved.isNull()) {   // (get(): operator[] would turn a missing row into an object)
        Json::Value d; d["state"] = current.get("state", Json::Value()); d["version"] = current.get("version", 0);
        throw ApiError(409, "state_conflict", "This message changed on another device", d);
    }
    notifier_.hypertextState(a.channelId, a.userId, card["id"].asString(), saved["state"], saved["version"].asInt64());
    Json::Value out; out["message_id"] = card["id"]; out["state"] = saved["state"]; out["version"] = saved["version"];
    return out;
}

// Reply-as-sender: the template, text, kind, character and audience come from the stored row only; the client names
// the reply and fills its declared slots.
void HypertextService::planReply(const ChannelAccess& a, const Json::Value& card, Act& p) {
    const auto& replies = card["replies"];
    if (!replies.isObject() || !replies.isMember(p.replyId) || !replies[p.replyId].isObject()) throw invalidSlot("this message has no reply \"" + printable(p.replyId) + "\"");
    const auto& tmpl = replies[p.replyId];
    auto r = ht::renderReply(tmpl, p.slots);
    if (!r.ok) throw invalidSlot(r.message);
    // The sender is still a GM of the channel with an active account; otherwise the card stops speaking (never a 403:
    // the clicker did nothing wrong).
    auto senderId = card["author_id"].asString();
    auto u = db_.queryOne("SELECT u.suspended_at, cm.role FROM users u LEFT JOIN channel_members cm ON cm.user_id=u.id AND cm.channel_id=$2 WHERE u.id=$1", {senderId, a.channelId});
    if (u.isNull() || !u["suspended_at"].isNull() || json::str(u, "role") != "gm") throw senderUnavailable();
    try { p.sender = auth_.channelAccess(senderId, a.channelId); } catch (const ApiError&) { throw senderUnavailable(); }
    if (!p.sender.isGm) throw senderUnavailable();
    // Its character, while it still belongs to the channel and speaks for nobody else; otherwise no character.
    std::string characterId = json::str(tmpl, "character_id");
    if (!characterId.empty()) {
        auto c = db_.queryOne("SELECT kind, user_id FROM characters WHERE id=$1 AND channel_id=$2", {characterId, a.channelId});
        if (c.isNull() || (json::str(c, "kind") == "pc" && !c["user_id"].isNull() && c["user_id"].asString() != senderId)) characterId.clear();
    }
    // The audience is the card's or a narrower one.
    auto& o = p.replyOrigin;
    auto audience = json::str(tmpl, "audience", "card");
    if (audience == "card") { o.visibility = card["visibility"].asString(); o.whisperTo = json::strArray(card["whisper_to"]); }
    else if (audience == "gm" || a.isGm) o.visibility = "gm_only";
    else {
        auto wc = auth_.windowCharacter(a.userId, card["chat_window_id"].asString());
        auto to = wc ? *wc : a.primaryCharacterId;
        if (to.empty()) throw ApiError(400, "no_character", "This reply goes to your character, and you have none here");
        o.visibility = "whisper"; o.whisperTo = {to};
    }
    if (o.visibility != "whisper") o.whisperTo.clear();
    o.cardId = card["id"].asString(); o.userId = a.userId; o.effect = 1;
    o.fixedCharacter = true; o.characterId = characterId;
    o.allowDice = tmpl["allow_dice"].asBool();   // decided at post time from the template itself
    p.replyBody = Json::Value(Json::objectValue);
    p.replyBody["content"] = r.text; p.replyBody["kind"] = json::str(tmpl, "kind", "narration");
    p.replyGroup = json::str(tmpl, "group");
}

// The lines an action posted, each re-read for the clicker: a line they may not read (a GM-only reply, the result of a
// hidden roll) comes back as null, the first time and on every replay. Stored rows are never returned.
Json::Value HypertextService::respond(const ChannelAccess& a, const Json::Value& card, const std::string& interactionId, const Json::Value& resultIds, const Json::Value& errors, bool replayed) {
    Json::Value out; out["interaction_id"] = interactionId; out["replayed"] = replayed; out["results"] = Json::Value(Json::arrayValue);
    bool partial = false;
    for (const auto& r : resultIds) {
        Json::Value x; x["type"] = r["type"]; x["ok"] = r["id"].isString(); x["message"] = Json::Value();
        if (r["id"].isString())
            x["message"] = db_.queryOne(MSG_SELECT + "WHERE m.id=$1 AND m.channel_id=$2 AND " + Visibility::messageFilter(a), {r["id"].asString(), a.channelId});
        else {
            partial = true;
            const auto& e = errors[r["type"].asString()];
            Json::Value err; err["error"] = json::str(e, "error", "failed"); err["message"] = json::str(e, "message", "This line could not be posted");
            x["error"] = err;
        }
        out["results"].append(x);
    }
    out["partial"] = partial;
    auto s = db_.queryOne("SELECT state, version FROM hypertext_states WHERE message_id=$1 AND user_id=$2", {card["id"].asString(), a.userId});
    out["state"] = s.isNull() ? Json::Value() : s;
    return out;
}

std::string HypertextService::postedLine(const std::string& cardId, const std::string& userId, const std::string& interactionId, int effect) {
    auto r = db_.queryOne("SELECT id FROM messages WHERE via_hypertext_id=$1 AND via_user_id=$2 AND via_interaction_id=$3 AND via_effect=$4", {cardId, userId, interactionId, (int64_t)effect});
    return r.isNull() ? "" : r["id"].asString();
}

Json::Value HypertextService::act(const ChannelAccess& a, const std::string& messageId, const Json::Value& body) {
    requireEnabled();
    // 1. Shape: everything a client may send, nothing else (a reply's text, for one, is never the client's).
    Act p;
    onlyKeys(body, {"interaction_id", "node", "say", "reply", "state", "base_version"}, "the action", invalidEffect);
    if (!body["interaction_id"].isString() || !Visibility::isUuid(body["interaction_id"].asString()))
        throw invalidEffect("interaction_id must be a UUID the client makes for this action and reuses when it retries");
    p.interactionId = text::lower(body["interaction_id"].asString());
    if (present(body, "node")) {
        if (!body["node"].isString() || (!body["node"].asString().empty() && !ht::validId(body["node"].asString()))) throw invalidEffect("node must be the id of the control acted on");
        p.node = body["node"].asString();
    }
    if (present(body, "say")) {
        const auto& s = body["say"];
        if (!s.isObject()) throw invalidEffect("say must be an object {text, kind?, character_id?, confirmed?}");
        onlyKeys(s, {"text", "kind", "character_id", "confirmed"}, "say", invalidEffect);
        if (!s["text"].isString()) throw invalidEffect("say.text required");
        if (auto err = ht::sayError(s["text"].asString()); !err.empty()) throw invalidEffect(err);
        p.sayText = text::trim(s["text"].asString());
        if (present(s, "kind")) { p.sayKind = s["kind"].isString() ? s["kind"].asString() : ""; if (p.sayKind != "ic" && p.sayKind != "ooc") throw invalidEffect("say.kind must be ic or ooc"); }
        if (present(s, "character_id")) {
            if (!s["character_id"].isString() || !Visibility::isUuid(s["character_id"].asString())) throw invalidEffect("say.character_id must be a character id");
            p.sayCharacter = text::lower(s["character_id"].asString());
        }
        if (present(s, "confirmed")) { if (!s["confirmed"].isBool()) throw invalidEffect("say.confirmed must be true or false"); p.confirmed = s["confirmed"].asBool(); }
        p.say = true;
    }
    if (present(body, "reply")) {
        const auto& r = body["reply"];
        if (!r.isObject()) throw invalidEffect("reply must be an object {id, slots?}");
        onlyKeys(r, {"id", "slots"}, "reply", invalidEffect);
        if (!r["id"].isString() || !ht::validId(r["id"].asString())) throw invalidEffect("reply.id must name one of the message's replies");
        p.replyId = r["id"].asString(); p.slots = r.get("slots", Json::Value(Json::objectValue)); p.reply = true;
    }
    if (!p.say && !p.reply) throw invalidEffect("an action posts a say, a reply or both; save the state alone with PUT …/hypertext/state");
    p.hasState = present(body, "state");
    if (!body["base_version"].isInt64() || body["base_version"].asInt64() < 0) throw invalidEffect("base_version must be the state version the action started from (0 when there is none yet)");
    p.baseVersion = body["base_version"].asInt64();

    // 2. The card: 404 when missing, recalled or unreadable.
    auto card = loadCard(a, messageId);
    const auto cardId = card["id"].asString(), windowId = card["chat_window_id"].asString();
    // The normalized request, which a retry must send again (`confirmed` and `node` aside): the slots as declared
    // strings and integers (1.0 is 1), the state in full (checked at step 8).
    if (p.reply && p.slots.isObject()) {
        Json::Value slots(Json::objectValue);
        for (const auto& k : p.slots.getMemberNames()) slots[k] = !p.slots[k].isString() && p.slots[k].isInt64() ? Json::Value((Json::Int64)p.slots[k].asInt64()) : p.slots[k];
        p.slots = slots;
    }
    ht::StateCheck chk;
    if (p.hasState) { chk = ht::validateState(card["hypertext"], body["state"]); p.state = chk.state; }
    p.request = Json::Value(Json::objectValue);
    if (p.say) { auto& s = p.request["say"]; s["text"] = p.sayText; s["kind"] = p.sayKind; s["character_id"] = p.sayCharacter.empty() ? Json::Value() : Json::Value(p.sayCharacter); }
    else p.request["say"] = Json::Value();
    if (p.reply) { p.request["reply"]["id"] = p.replyId; p.request["reply"]["slots"] = p.slots; } else p.request["reply"] = Json::Value();
    p.request["state"] = p.hasState ? p.state : Json::Value();
    p.request["base_version"] = (Json::Int64)p.baseVersion;
    p.hash = crypto::sha256Hex(json::dump(p.request));
    // A retry of a finished action gets its result before anything that may have changed since is asked again (the card
    // closing, the window, the sender): a finished row never changes. (Its response may have been lost after a bot
    // closed the card on seeing its line.)
    if (!p.hasState || chk.ok) {
        auto row = db_.queryOne("SELECT status, request_hash, result_ids, error FROM hypertext_interactions WHERE message_id=$1 AND user_id=$2 AND interaction_id=$3 AND status<>'pending'",
                                {cardId, a.userId, p.interactionId});
        if (!row.isNull()) return replay(a, card, p, row);
    }

    // 3-5. Its window and the caller.
    requireUsable(a, card);
    // 6. A line as the clicker: a roll they could type, a sheet change they confirm, nothing else that is a command, and
    // initiative (the whole window sees the order) only from a card the whole window reads.
    if (p.say) {
        auto verdict = ht::diceVerdict(p.sayText);
        auto cmd = dice::parseCommand(p.sayText);
        if (verdict == ht::Verdict::refused || (cmd && cmd->name == "ri" && card["visibility"] != "window"))
            throw ApiError(403, "hypertext_command_not_allowed", "An interactive message cannot post this command for you");
        // With the server's dice turned off, a dot command posts as the plain text it is (ChatService::postMessage), so
        // no line that looks like a command goes out unconfirmed: a client may have taken it for a roll, which it
        // sends without asking. `sheet` tells the client whether the line changes the character sheet.
        const bool diceOff = verdict != ht::Verdict::none &&
            !db_.queryOne("SELECT 1 AS off FROM server_settings WHERE server_id=$1 AND NOT feature_dice", {a.serverId}).isNull();
        if ((verdict == ht::Verdict::confirm || diceOff) && !p.confirmed) {
            Json::Value d; d["text"] = p.sayText; d["sheet"] = !diceOff;
            throw ApiError(428, "confirmation_required", diceOff ? "Dice are turned off on this server, so this posts as plain text: confirm it, then send the action again"
                                                                 : "This changes your character's sheet: confirm it, then send the action again", d);
        }
        if (!p.sayCharacter.empty()) {   // the composer's active character: one of the caller's own (any, for a GM)
            auto c = db_.queryOne("SELECT user_id FROM characters WHERE id=$1 AND channel_id=$2", {p.sayCharacter, a.channelId});
            if (c.isNull()) throw badRequest("character not in this channel");
            if (!a.isGm && json::str(c, "user_id") != a.userId) throw forbidden("not your character");
        }
    }
    // 7. A reply as the sender.
    if (p.reply) planReply(a, card, p);
    // 8. The state the action leaves.
    if (p.hasState && !chk.ok) { Json::Value d; d["key"] = chk.key; throw ApiError(400, "invalid_state", (chk.key.empty() ? std::string("state") : "state." + printable(chk.key)) + ": " + chk.message, d); }

    // 9. The claim, under the card's lock: replays, one action in flight per viewer, the card still open, the version,
    // the runs and the limits.
    enum class Mode { fresh, resume, replay };
    Mode mode = Mode::fresh;
    Json::Value stored;
    auto rowId = db_.tx([&](pqxx::work& w) {
        Db::exec(w, kLock, {cardId});
        // FOR UPDATE: the status as it is now, also when the request that holds it is ending it (finish).
        auto row = Db::queryOne(w, "SELECT id, status, request_hash, result_ids, error, lease_until > now() AS leased FROM hypertext_interactions WHERE message_id=$1 AND user_id=$2 AND interaction_id=$3 FOR UPDATE",
                                {cardId, a.userId, p.interactionId});
        if (!row.isNull()) {
            if (row["request_hash"].asString() != p.hash) throw ApiError(409, "interaction_mismatch", "This interaction id was already used for a different action");
            if (row["status"] == "pending") {
                if (row["leased"].asBool()) throw inProgress();
                // Its claim lapsed (the request that held it died): this one finishes it. Lines already posted are
                // found by their origin, so nothing is posted twice.
                Db::exec(w, "UPDATE hypertext_interactions SET lease_until=now() + $2::int * interval '1 second', updated_at=now() WHERE id=$1 AND status='pending'", {row["id"].asString(), (int64_t)kLeaseSeconds});
                mode = Mode::resume;
            } else { mode = Mode::replay; stored = row; }
            return row["id"].asString();
        }
        requireOpen(w, cardId);   // a new action, and the card recalled or closed since it was read
        if (!Db::queryOne(w, "SELECT 1 AS busy FROM hypertext_interactions WHERE message_id=$1 AND user_id=$2 AND status='pending' AND lease_until > now() LIMIT 1", {cardId, a.userId}).isNull())
            throw inProgress();
        auto cur = Db::queryOne(w, "SELECT state, version FROM hypertext_states WHERE message_id=$1 AND user_id=$2", {cardId, a.userId});
        const int64_t version = cur.isNull() ? 0 : cur["version"].asInt64();
        if (version != p.baseVersion) {
            Json::Value d; d["state"] = cur["state"]; d["version"] = (Json::Int64)version;
            throw ApiError(409, "state_conflict", "This message changed on another device", d);
        }
        const auto runs = card["hypertext"].get("runs_per_viewer", 1).asInt64();
        if (Db::queryOne(w, "SELECT count(*) AS n FROM hypertext_interactions WHERE message_id=$1 AND user_id=$2 AND status IN ('pending','done')", {cardId, a.userId})["n"].asInt64() >= runs)
            throw ApiError(409, "runs_exhausted", "You already used this");
        // Per-minute limits; failed actions count here too.
        auto rate = Db::queryOne(w,
            "SELECT count(*) FILTER (WHERE message_id=$3) AS card, ceil(extract(epoch FROM min(created_at) FILTER (WHERE message_id=$3) + interval '1 minute' - now()))::int AS card_wait, "
            "count(*) AS channel, ceil(extract(epoch FROM min(created_at) + interval '1 minute' - now()))::int AS channel_wait "
            "FROM hypertext_interactions WHERE channel_id=$1 AND user_id=$2 AND created_at > now() - interval '1 minute'", {a.channelId, a.userId, cardId});
        if (rate["card"].asInt() >= kActsPerCard) throw rateLimited("Too many actions on this message; try again shortly", rate["card_wait"].asInt());
        if (rate["channel"].asInt() >= kActsPerChannel) throw rateLimited("Too many actions; try again shortly", rate["channel_wait"].asInt());
        if (p.reply) {
            auto replies = Db::queryOne(w, "SELECT count(*) AS n, ceil(extract(epoch FROM min(created_at) + interval '1 minute' - now()))::int AS wait FROM hypertext_interactions "
                                           "WHERE message_id=$1 AND reply_id IS NOT NULL AND created_at > now() - interval '1 minute'", {cardId});
            if (replies["n"].asInt() >= kRepliesPerCard) throw rateLimited("This message is answering too often; try again shortly", replies["wait"].asInt());
            // The reply's own limits, over the replies that were (or are being) posted.
            const auto& tmpl = card["replies"][p.replyId];
            auto used = Db::queryOne(w,
                "SELECT count(*) FILTER (WHERE user_id=$2 AND reply_id=$3) AS mine, count(*) FILTER (WHERE reply_id=$3) AS total, "
                "count(*) FILTER (WHERE user_id=$2 AND reply_group=$4) AS grouped "
                "FROM hypertext_interactions WHERE message_id=$1 AND reply_id IS NOT NULL AND reply_ok IS NOT FALSE AND status<>'failed'",
                {cardId, a.userId, p.replyId, p.replyGroup});
            if (used["mine"].asInt64() >= tmpl.get("per_viewer", 1).asInt64()) throw ApiError(409, "reply_exhausted", "You already used this");
            if (tmpl["total"].isIntegral() && used["total"].asInt64() >= tmpl["total"].asInt64()) throw ApiError(409, "reply_exhausted", "Someone already took this");
            // A group: at most one of its replies per viewer (mutually exclusive answers).
            if (!p.replyGroup.empty() && used["grouped"].asInt64() > 0) throw ApiError(409, "reply_exhausted", "You already chose an answer here");
        }
        return Db::queryOne(w,
            "INSERT INTO hypertext_interactions(message_id, channel_id, user_id, interaction_id, node_id, request, request_hash, reply_id, reply_group, status, lease_until) "
            "VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'pending',now() + $10::int * interval '1 second') RETURNING id",
            {cardId, a.channelId, a.userId, p.interactionId, p.node, json::dump(p.request), p.hash, p.reply ? DbParam(p.replyId) : dbNull(),
             p.replyGroup.empty() ? dbNull() : DbParam(p.replyGroup), (int64_t)kLeaseSeconds})["id"].asString();
    });
    if (mode == Mode::replay) return replay(a, card, p, stored);

    // 10. The effects in order, each through the normal posting path in its own transaction (which checks the card
    // was not recalled and this claim still holds). The first failing posts nothing more.
    struct Effect { const char* type; int index; const ChannelAccess* access; Json::Value body; HypertextOrigin origin; };
    std::vector<Effect> effects;
    if (p.say) {
        HypertextOrigin o; o.cardId = cardId; o.userId = a.userId; o.effect = 0;
        o.visibility = card["visibility"].asString(); o.whisperTo = o.visibility == "whisper" ? json::strArray(card["whisper_to"]) : std::vector<std::string>{};
        o.sayCharacterId = p.sayCharacter;
        Json::Value b; b["content"] = p.sayText; b["kind"] = p.sayKind;
        effects.push_back({"say", 0, &a, b, o});
    }
    if (p.reply) effects.push_back({"reply", 1, &p.sender, p.replyBody, p.replyOrigin});
    Json::Value errors(Json::objectValue);
    std::optional<ApiError> failure;
    bool repeated = false;
    for (size_t i = 0; i < effects.size(); ++i) {
        auto& e = effects[i];
        e.origin.interactionId = p.interactionId;
        try {
            repeated = chat_.postMessage(*e.access, windowId, e.body, Json::Value(), "", &e.origin)["repeated"].asBool() || repeated;
        } catch (const ApiError& err) {
            // The line may be there although something after it failed: it counts as posted (finish finds it).
            if (!postedLine(cardId, a.userId, p.interactionId, e.index).empty()) continue;
            if (i == 0) { failure = err; break; }   // nothing was posted: the action failed
            Json::Value x; x["error"] = err.code(); x["message"] = err.what(); errors[e.type] = x;
        } catch (const std::exception& ex) {
            if (!postedLine(cardId, a.userId, p.interactionId, e.index).empty()) continue;
            if (i == 0) {
                // Not the action's fault (the database, say): the claim lapses at once, so a retry may finish it.
                db_.exec("UPDATE hypertext_interactions SET lease_until=now(), updated_at=now() WHERE id=$1 AND status='pending'", {rowId});
                throw;
            }
            ALOG_WARN << "hypertext " << cardId << " effect " << e.type << ": " << ex.what();
            Json::Value x; x["error"] = "internal"; x["message"] = "This line could not be posted"; errors[e.type] = x;
        }
    }

    // 11. The end, from the lines that are there: done with their ids (never the rows) and, when anything was posted,
    // the state; failed with the first effect's error when nothing was. It frees its run and reply but still counts
    // for the rates.
    Json::Value saved;
    bool elsewhere = false;
    auto ended = db_.tx([&](pqxx::work& w) {
        Db::exec(w, kLock, {cardId});
        auto row = finish(w, rowId, errors, failure ? errorJson(*failure) : Json::Value());
        if (row.isNull()) {   // ended elsewhere (a retry that took the claim over, the sweep): as it ended there
            elsewhere = true;
            return Db::queryOne(w, "SELECT status, result_ids, error FROM hypertext_interactions WHERE id=$1", {rowId});
        }
        // The action's state supersedes whatever was saved meanwhile; a recalled card keeps none.
        if (row["status"] == "done" && p.hasState)
            saved = Db::queryOne(w, "INSERT INTO hypertext_states(message_id, user_id, state, version) SELECT $1::uuid, $2::uuid, $3::jsonb, 1 WHERE EXISTS (SELECT 1 FROM messages WHERE id=$1 AND recalled_at IS NULL) "
                                    "ON CONFLICT (message_id, user_id) DO UPDATE SET state=EXCLUDED.state, version=hypertext_states.version+1, updated_at=now() RETURNING state, version",
                                 {cardId, a.userId, json::dump(p.state)});
        return row;
    });
    if (!saved.isNull()) notifier_.hypertextState(a.channelId, a.userId, cardId, saved["state"], saved["version"].asInt64());
    if (ended["status"] == "failed") throw fromJson(ended["error"]);
    return respond(a, card, p.interactionId, ended["result_ids"], ended["error"], mode == Mode::resume || repeated || elsewhere);
}

// A finished action again: the same request replays its stored result, a failed one its error.
Json::Value HypertextService::replay(const ChannelAccess& a, const Json::Value& card, const Act& p, const Json::Value& row) {
    if (row["request_hash"].asString() != p.hash) throw ApiError(409, "interaction_mismatch", "This interaction id was already used for a different action");
    if (row["status"] == "failed") throw fromJson(row["error"]);
    return respond(a, card, p.interactionId, row["result_ids"], row["error"], true);
}

// Ends a pending action under its row's lock, from the lines its origin holds rather than from what one request saw:
// done with those lines (`errors` says why one asked for is missing; "interrupted" when it does not), failed with
// `failure` (or interaction_interrupted) when there is none. A line being posted holds the row shared to its commit
// (ChatService::postMessage), so none lands after this. Returns the ended row {status, result_ids, error}; null when it
// was no longer pending. The caller holds the card's lock.
Json::Value HypertextService::finish(pqxx::work& w, const std::string& rowId, const Json::Value& errorsIn, const Json::Value& failure) {
    auto row = Db::queryOne(w, "SELECT message_id, user_id, interaction_id, request FROM hypertext_interactions WHERE id=$1 AND status='pending' FOR UPDATE", {rowId});
    if (row.isNull()) return row;
    std::map<int, std::string> lines;
    for (const auto& m : Db::queryJson(w, "SELECT id, via_effect FROM messages WHERE via_hypertext_id=$1 AND via_user_id=$2 AND via_interaction_id=$3",
                                        {row["message_id"].asString(), row["user_id"].asString(), row["interaction_id"].asString()}))
        lines[m["via_effect"].asInt()] = m["id"].asString();
    const Json::Value& request = row["request"];
    Json::Value out, ids(Json::arrayValue), errors(Json::objectValue);
    for (auto [type, effect] : {std::pair<const char*, int>{"say", 0}, {"reply", 1}}) {
        if (request.get(type, Json::Value()).isNull()) continue;
        Json::Value entry; entry["type"] = type; entry["id"] = lines.count(effect) ? Json::Value(lines[effect]) : Json::Value();
        if (!lines.count(effect)) errors[type] = errorsIn.isObject() && errorsIn.isMember(type) ? errorsIn[type] : interrupted();
        ids.append(entry);
    }
    if (lines.empty()) {
        out["status"] = "failed"; out["error"] = failure.isObject() ? failure : interruptedAction();
        Db::exec(w, "UPDATE hypertext_interactions SET status='failed', error=$2::jsonb, reply_ok=CASE WHEN reply_id IS NULL THEN NULL ELSE false END, lease_until=NULL, updated_at=now() WHERE id=$1",
                 {rowId, json::dump(out["error"])});
    } else {
        out["status"] = "done"; out["result_ids"] = ids; out["error"] = errors.empty() ? Json::Value() : errors;
        Db::exec(w, "UPDATE hypertext_interactions SET status='done', result_ids=$2::jsonb, error=$3::jsonb, reply_ok=$4, lease_until=NULL, updated_at=now() WHERE id=$1",
                 {rowId, json::dump(ids), errors.empty() ? dbNull() : DbParam(json::dump(errors)), request.get("reply", Json::Value()).isNull() ? dbNull() : DbParam((bool)lines.count(1))});
    }
    return out;
}

Json::Value HypertextService::close(const ChannelAccess& a, const std::string& messageId) {
    requireEnabled();
    auth_.requireGm(a);
    auto card = loadCard(a, messageId);
    const auto cardId = card["id"].asString();
    // Under the card's lock: no action is claimed after it (one already claimed still finishes).
    auto closed = db_.tx([&](pqxx::work& w) {
        Db::exec(w, kLock, {cardId});
        return Db::queryOne(w, "UPDATE hypertext_cards SET closed_at=now(), closed_by=$2 WHERE message_id=$1 AND closed_at IS NULL RETURNING closed_at", {cardId, a.userId});
    });
    if (!closed.isNull()) notifier_.hypertextClosed(card, closed["closed_at"].asString());
    auto out = db_.queryOne("SELECT message_id, closes_at, closed_at, closed_by FROM hypertext_cards WHERE message_id=$1", {cardId});
    out["closed"] = true;
    return out;
}

int HypertextService::finishAbandoned(int limit) {
    int finished = 0;
    for (const auto& r : db_.queryJson("SELECT id, message_id FROM hypertext_interactions WHERE status='pending' AND lease_until < now() - interval '2 minutes' ORDER BY lease_until LIMIT " + std::to_string(std::max(1, limit)))) {
        try {
            bool done = db_.tx([&](pqxx::work& w) {
                Db::exec(w, kLock, {r["message_id"].asString()});
                // Still abandoned: a retry may have taken it over meanwhile.
                if (Db::queryOne(w, "SELECT id FROM hypertext_interactions WHERE id=$1 AND status='pending' AND lease_until < now() - interval '2 minutes' FOR UPDATE", {r["id"].asString()}).isNull()) return false;
                return !finish(w, r["id"].asString(), Json::Value(), Json::Value()).isNull();
            });
            if (done) ++finished;
        } catch (const std::exception& e) { ALOG_WARN << "hypertext interaction " << r["id"].asString() << ": " << e.what(); }
    }
    return finished;
}

int HypertextService::prune(int limit) {
    auto r = db_.exec("DELETE FROM hypertext_interactions WHERE id IN (SELECT i.id FROM hypertext_interactions i JOIN hypertext_cards hc ON hc.message_id=i.message_id "
                      "WHERE coalesce(hc.closed_at, hc.closes_at) < now() - interval '1 day' LIMIT " + std::to_string(std::max(1, limit)) + ")");
    return (int)r.affected_rows();
}

} // namespace acerciae
