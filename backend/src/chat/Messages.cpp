#include "ChatService.h"
#include "../characters/CharacterSpaceService.h"
#include "../events/EventStore.h"
#include "../scenes/SceneManager.h"
#include "../ws/Notifier.h"
#include "../documents/DocumentService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../knowledge/Visibility.h"
#include "../dice/Dice.h"
#include "../dice/DiceService.h"
#include "../core/Text.h"
#include "../core/Crypto.h"
#include "../rules/RuleSystem.h"
#include "../rules/PbtaRuling.h"
#include "../core/Log.h"
#include "Recall.h"

#include "ChatQueries.h"
namespace acerciae {
using namespace chatQueries;
Json::Value ChatService::listMessages(const ChannelAccess& a, const std::string& windowId, int limit, int64_t beforeSeq, bool includeHistory, int64_t afterSeq) {
    auto window=db_.queryOne("SELECT id FROM chat_windows WHERE id=$1 AND channel_id=$2",{windowId,a.channelId});
    if(window.isNull()) throw notFound("chat window not found");
    if(!a.isGm && db_.queryOne("SELECT 1 AS ok FROM chat_window_members wm JOIN player_group_members pm ON pm.user_id=wm.user_id WHERE wm.chat_window_id=$1 AND pm.channel_id=$2 AND pm.group_id=$3::uuid AND "+Visibility::groupGuard(a)+" LIMIT 1",{windowId,a.channelId,a.playerGroupId.empty()?dbNull():DbParam(a.playerGroupId)}).isNull()) throw forbidden("Chat window is outside this player group's views");
    // Ancestors never grant new privileges: a new participant can only scroll back into sources
    // their own player group is already allowed to read. Whispers and GM notes keep their scopes.
    std::string sql = MSG_SELECT + (includeHistory
        ? "JOIN lineage l ON l.id=m.chat_window_id WHERE (l.cutoff IS NULL OR m.seq<=l.cutoff) AND "
        : "WHERE m.chat_window_id=$1 AND ") + Visibility::messageFilter(a);
    DbParams p{windowId};
    if (beforeSeq > 0) { p.push_back(beforeSeq); sql += " AND m.seq < $" + std::to_string(p.size()); }
    if (afterSeq >= 0) { p.push_back(afterSeq); sql += " AND m.seq > $" + std::to_string(p.size()); }
    // The newest page, or (catching up) the page right after `afterSeq`.
    sql += std::string(afterSeq >= 0 ? " ORDER BY m.seq ASC" : " ORDER BY m.seq DESC") + " LIMIT " + std::to_string(std::max(1, std::min(limit, 200)));
    auto rows = db_.queryJson((includeHistory?WINDOW_HISTORY:"")+"SELECT * FROM (" + sql + ") x ORDER BY seq ASC", p);
    return rows;
}
Json::Value ChatService::markRead(const ChannelAccess& a, const std::string& windowId, int64_t seq) {
    listMessages(a, windowId, 1, 0);   // the same access check as reading the window
    auto row = db_.queryOne("INSERT INTO chat_window_reads(chat_window_id, user_id, last_read_seq) VALUES($1,$2,LEAST($3, coalesce((SELECT max(seq) FROM messages WHERE chat_window_id=$1), 0))) "
        "ON CONFLICT (chat_window_id, user_id) DO UPDATE SET last_read_seq=GREATEST(chat_window_reads.last_read_seq, EXCLUDED.last_read_seq), updated_at=now() RETURNING last_read_seq",
        {windowId, a.userId, seq});
    Json::Value v; v["last_read_seq"] = row["last_read_seq"]; return v;
}
Json::Value ChatService::getMessage(const ChannelAccess& a, const std::string& messageId) {
    auto m = db_.queryOne(MSG_SELECT + "WHERE m.id=$1 AND m.channel_id=$2 AND m.recalled_at IS NULL AND " + Visibility::messageFilter(a), {messageId, a.channelId});
    if (m.isNull()) throw notFound("message not found");
    return m;
}
Json::Value ChatService::searchMessages(const ChannelAccess& a, const std::string& query, int limit) {
    if (query.empty()) throw badRequest("query required");
    return db_.queryJson(MSG_SELECT + "WHERE m.channel_id=$1 AND m.recalled_at IS NULL AND " + Visibility::messageFilter(a) +
        " AND (m.search @@ plainto_tsquery('english', $2) OR m.content ILIKE '%' || $2 || '%') ORDER BY m.seq DESC LIMIT " + std::to_string(std::max(1, std::min(limit, 100))),
        {a.channelId, query});
}
Json::Value ChatService::postSystemMessage(pqxx::work& w, const std::string& channelId, const std::string& windowId, const std::string& authorId, const std::string& content) {
    auto sceneId = scenes_.resolveSceneForWindow(w, channelId, windowId);
    auto id = Db::queryOne(w,
        "INSERT INTO messages(channel_id, chat_window_id, scene_id, author_id, author_role, kind, content, visibility, whisper_to) VALUES($1,$2,$3,$4,'gm','system',$5,'window','{}'::uuid[]) RETURNING id",
        {channelId, windowId, sceneId, authorId, content})["id"].asString();
    NewEvent e; e.channelId = channelId; e.chatWindowId = windowId; e.sceneId = sceneId; e.messageId = id; e.actorUserId = authorId; e.actorRole = "system"; e.kind = "message.posted";
    for (auto& r : Db::queryJson(w, "SELECT character_id FROM chat_window_members WHERE chat_window_id=$1 AND character_id IS NOT NULL", {windowId})) e.audience.push_back(r["character_id"].asString());
    e.payload["content"] = content; e.payload["message_kind"] = "system";
    events_.append(w, e);
    return Db::queryOne(w, MSG_SELECT + "WHERE m.id=$1", {id});
}
Json::Value ChatService::postMessage(const ChannelAccess& a, const std::string& windowId, const Json::Value& body, const Json::Value& ruling, const std::string& mediaAssetId) {
    auth_.requireWindowMember(a, windowId);
    if (!ruling.isNull()) auth_.requireGm(a);
    auto content = json::str(body, "content");
    if (content.empty()) throw badRequest("content required");
    if (content.size() > 20000) throw badRequest("message too long");
    auto kind = json::str(body, "kind", "ic");
    if (kind != "ic" && kind != "ooc" && kind != "narration" && kind != "roll") throw badRequest("invalid message kind");
    auto visibility = json::str(body, "visibility", "window");
    if (visibility != "window" && visibility != "gm_only" && visibility != "whisper") throw badRequest("invalid visibility");
    if (visibility != "window" && !a.isGm) throw forbidden("only the GM can post gm_only or whisper messages");
    if(body.isMember("reference_ids") && !body["reference_ids"].isArray()) throw badRequest("reference_ids must be an array");
    if(body["reference_ids"].size()>5) throw badRequest("At most five chat references");
    for(const auto& ref : body["reference_ids"]) if(!ref.isString()) throw badRequest("Reference IDs must be strings");
    auto references=json::strArray(body["reference_ids"]);
    if(references.size()>5) throw badRequest("At most five chat references");
    for(const auto& id : references) { if(!Visibility::isUuid(id)) throw badRequest("Invalid reference ID"); getMessage(a,id); }
    auto whisperTo = json::strArray(body["whisper_to"]);
    if (visibility == "whisper" && whisperTo.empty()) throw badRequest("whisper_to required for whisper");

    std::string characterId = json::str(body, "character_id");
    if (characterId.empty()) { auto wc = auth_.windowCharacter(a.userId, windowId); if (wc) characterId = *wc; }
    std::string characterKind;
    if (!characterId.empty()) {
        auto c = db_.queryOne("SELECT user_id, kind FROM characters WHERE id=$1 AND channel_id=$2", {characterId, a.channelId});
        if (c.isNull()) throw badRequest("character not in this channel");
        if (!a.isGm && (c["user_id"].isNull() || c["user_id"].asString() != a.userId)) throw forbidden("not your character");
        characterKind = c["kind"].asString();
    }
    // Sealdice-style commands (.r .ra .sc .st .en ...) are evaluated by the dice service and stored as roll messages.
    auto diceCmd = dice_.recognise(a, content);
    if (!ruling.isNull() && ruling["op"]=="move" && (!diceCmd || diceCmd->name!="move")) throw badRequest("PbtA dice are disabled");
    if (diceCmd) kind = "roll";
    else if (kind == "roll") throw badRequest("roll messages come from dice commands: start the message with a dot command such as .ra or .r");

    DiceService::Result diceResult;
    Json::Value notice;
    pbta::Ruling audit;
    auto msg = db_.tx([&](pqxx::work& w) {
        Db::queryOne(w,"SELECT id FROM channels WHERE id=$1 FOR NO KEY UPDATE",{a.channelId});
        auto target=Db::queryOne(w,"SELECT archived_at FROM chat_windows WHERE id=$1 FOR SHARE",{windowId});
        if (!target["archived_at"].isNull()) throw conflict("This window is archived. Restore it or fork it to continue.");
        if (!a.isGm && !Db::queryOne(w,"SELECT 1 AS paused FROM chat_window_members WHERE chat_window_id=$1 AND user_id=$2 AND visibility_paused",{windowId,a.userId}).isNull())
            throw forbidden("Your participation in this window is paused");
        auto sceneId = scenes_.resolveSceneForWindow(w, a.channelId, windowId);
        if (!ruling.isNull() || (diceCmd && diceCmd->name=="move" && Db::queryOne(w,"SELECT rule_system FROM channels WHERE id=$1 FOR SHARE",{a.channelId})["rule_system"]=="pbta")) {
            if (characterId.empty()) throw badRequest("Choose a character for this move");
            auto args=diceCmd ? text::trim(diceCmd->args) : "";
            audit=pbta::prepareRuling(w,a,windowId,characterId,ruling,args.substr(0,args.find_first_of(" \t")),visibility,whisperTo);
            if (!audit.repeated.empty())
                return Db::queryOne(w,MSG_SELECT+"WHERE m.id=$1 AND "+Visibility::messageFilter(a),{audit.repeated});
            if (!audit.source.isNull()) {
                visibility=audit.source["visibility"].asString();
                whisperTo=json::strArray(audit.source["whisper_to"]);
                references=audit.refs;
            }
            if(!audit.text.empty()) {
                content=audit.text;
                if(audit.op!="declare") { kind="narration"; characterId.clear(); }
            }
        }
        std::string eventText = content;
        Json::Value diceJson;
        if (diceCmd) {
            diceResult = dice_.execute(w, a, windowId, characterId, *diceCmd);
            diceJson = diceResult.dice; eventText = diceResult.text;
            if (diceResult.hidden) {
                // Hidden rolls: the result reaches the roller's character and the GM; the window only sees a notice.
                if (!characterId.empty() && characterKind == "pc") { visibility = "whisper"; whisperTo = {characterId}; }
                else if (a.isGm) { visibility = "gm_only"; whisperTo.clear(); }
                else throw ApiError(400, "dice_error", "Hidden rolls need a character to speak as, so the result has someone to reach.");
            }
        }
        auto insert = [&](const std::string& vis, const std::vector<std::string>& to, const std::string& text, const Json::Value& dice) {
            return Db::queryOne(w,
                "INSERT INTO messages(channel_id, chat_window_id, scene_id, author_id, author_role, character_id, kind, content, visibility, whisper_to, dice) "
                "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid[],$11::jsonb) RETURNING id",
                {a.channelId, windowId, sceneId, a.userId, a.isGm ? "gm" : "player", characterId.empty() ? dbNull() : DbParam(characterId), kind, text, vis,
                 pgArrayLiteral(to), dice.isNull() ? dbNull() : DbParam(json::dump(dice))})["id"].asString();
        };
        auto messageId = insert(visibility, whisperTo, content, diceJson);
        audit.finish(w,messageId,characterId);
        for(const auto& id : references) if(Db::queryOne(w,MSG_SELECT+"WHERE m.id=$1 AND m.channel_id=$2 AND "+Visibility::messageFilter(a),{id,a.channelId}).isNull()) throw forbidden("Referenced chat is no longer accessible");
        Db::exec(w,"UPDATE messages SET reference_ids=$2::uuid[] WHERE id=$1",{messageId,pgArrayLiteral(references)});
        if (!mediaAssetId.empty()) Db::exec(w, "UPDATE messages SET media_asset_id=$2 WHERE id=$1", {messageId, mediaAssetId});
        if (diceCmd && diceResult.hidden) {
            Json::Value nd; nd["type"] = "hidden_notice"; nd["command"] = diceCmd->raw; nd["text"] = diceResult.hiddenNotice;
            notice = Db::queryOne(w, MSG_SELECT + "WHERE m.id=$1", {insert("window", {}, diceCmd->raw, nd)});
        }
        // Sheet maintenance (.st/.en) is bookkeeping, not something that happened in the story.
        if (!diceCmd || diceResult.narrative) {
            // Audience = characters who can read this message in-fiction.
            std::vector<std::string> audience;
            std::string evVis = "window";
            if (visibility == "window") {
                for (auto& r : Db::queryJson(w, "SELECT character_id FROM chat_window_members WHERE chat_window_id=$1 AND character_id IS NOT NULL", {windowId}))
                    audience.push_back(r["character_id"].asString());
            } else if (visibility == "whisper") { audience = whisperTo; evVis = "whisper"; }
            else evVis = "gm_only";
            NewEvent e; e.channelId = a.channelId; e.chatWindowId = windowId; e.sceneId = sceneId; e.messageId = messageId;
            e.actorUserId = a.userId; e.actorRole = a.isGm ? "gm" : "player"; e.characterId = characterId; e.kind = "message.posted";
            e.visibility = evVis; e.audience = audience;
            e.payload["content"] = eventText; e.payload["message_kind"] = kind; e.payload["reference_message_ids"]=json::fromStrArray(references);
            if (!mediaAssetId.empty()) e.payload["media_asset_id"] = mediaAssetId;
            if (diceCmd) { e.payload["command"] = content; e.payload["dice"] = diceJson; }
            events_.append(w, e);
        }
        return Db::queryOne(w, MSG_SELECT + "WHERE m.id=$1", {messageId});
    });
    if (audit.repeated.empty()) {
        if (!audit.updated.isNull()) notifier_.characterUpdated(a.channelId, audit.updated);
        notifier_.messagePosted(msg);
        if (!notice.isNull()) notifier_.messagePosted(notice);
        if (diceCmd) dice_.afterCommit(a, characterId, diceResult);
    }
    if (!audit.command.isNull()) msg["declared_move"] = audit.command;
    return msg;
}

Json::Value ChatService::recallMessage(const ChannelAccess& a, const std::string& messageId) {
    if (!Visibility::isUuid(messageId)) throw notFound("message not found");
    std::string original;
    std::vector<std::string> eventIds;
    bool repeated = false;
    auto tombstone = db_.tx([&](pqxx::work& w) {
        auto m = Db::queryOne(w, "SELECT m.author_id, m.kind, m.content, m.recalled_at, m.created_at > now() - " + RECALL_WINDOW + " AS recent, " + ON_MOVE_RECORD + " AS on_record, "
            "w.archived_at, " + Visibility::messageFilter(a) + " AS readable FROM messages m JOIN chat_windows w ON w.id=m.chat_window_id WHERE m.id=$1 AND m.channel_id=$2 FOR UPDATE OF m",
            {messageId, a.channelId});
        if (m.isNull() || !m["readable"].asBool()) throw notFound("message not found");
        if (json::str(m, "author_id") != a.userId) throw forbidden("Only the author can recall a message");
        if (!m["recalled_at"].isNull()) { repeated = true; return Db::queryOne(w, MSG_SELECT + "WHERE m.id=$1", {messageId}); }
        auto kind = json::str(m, "kind");
        if (kind == "roll") throw ApiError(409, "not_recallable", "Dice rolls cannot be recalled: their results stay on the record");
        if (kind == "system") throw ApiError(409, "not_recallable", "System lines cannot be recalled");
        if (m["on_record"].asBool()) throw ApiError(409, "not_recallable", "This line is part of a move's record and cannot be recalled");
        if (!m["recent"].asBool()) throw ApiError(409, "recall_expired", "Messages can only be recalled within " + std::to_string(kRecallSeconds / 60) + " minutes of sending");
        if (!m["archived_at"].isNull()) throw conflict("This window is archived. Restore it or fork it to continue.");
        original = json::str(m, "content");
        for (const auto& e : Db::queryJson(w, "SELECT id FROM events WHERE message_id=$1", {messageId})) eventIds.push_back(e["id"].asString());
        // The campaign log keeps its own copy of each line: that goes with it (and with it every snapshot's line).
        Db::exec(w, "DELETE FROM log_events WHERE source_message_id=$1 OR source_event_id = ANY($2::uuid[])", {messageId, pgArrayLiteral(eventIds)});
        Db::exec(w, "DELETE FROM events WHERE message_id=$1", {messageId});
        Db::exec(w, "UPDATE messages SET content='', dice=NULL, reference_ids='{}', recalled_at=now() WHERE id=$1", {messageId});
        return Db::queryOne(w, MSG_SELECT + "WHERE m.id=$1", {messageId});
    });
    if (!repeated) {
        notifier_.messageRecalled(tombstone);
        try { recall::forget(db_, docs_, notifier_, a.channelId, eventIds); }
        catch (const std::exception& e) { ALOG_WARN << "recall " << messageId << ": " << e.what(); }
    }
    Json::Value out; out["message"] = tombstone; out["content"] = original;   // empty when it was already recalled
    return out;
}


} // namespace acerciae
