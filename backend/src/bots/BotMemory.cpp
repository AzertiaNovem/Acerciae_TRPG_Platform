#include "BotMemory.h"
#include "BotRuntime.h"
#include "../llm/LlmGateway.h"
#include "../rules/RuleSystem.h"
#include "../core/Crypto.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../core/Text.h"
#include <algorithm>
#include <set>
#include <stdexcept>

namespace acerciae {

namespace {
// The gateway names the game and the GM ({GAME}, {GM}) and adds the output language.
const char* kTable = R"(You are {BOT}, a member of an online tabletop roleplaying community. You keep a diary of the tables you play at, so you can talk about them with your friends later.

Below: what you remembered so far of the table "{CHANNEL}" (a game of {GAME}) and the lines you have since witnessed in its chat window "{WINDOW}". Rewrite your memory of this table in the first person, as you would tell a friend: what happened, whom you played with, how it felt, what you are curious about. Keep what still matters from before; at most 250 words.

Choose the moment that struck you most so far (from before or new) as "highlight": one or two sentences.

For the people listed below who appear in the new lines, note what they are like as players and as people (tastes, humour, how they play, how they treated you), merged with your earlier note on them; one or two sentences each, not the story's secrets.

Reply with only one JSON object: {"summary": "...", "highlight": "...", "people": [{"id": "<the person's id>", "note": "..."}]})";

const char* kPrivate = R"(You are {BOT}, a member of an online tabletop roleplaying community, playing at the table "{CHANNEL}" (a game of {GAME}). Some things there were whispered to your character alone. Below: what you remembered of those whispers so far, your memory of the table, and the new whispers. Rewrite what you remember of the whispers in the first person: what you were told, by whom, and what you made of it; at most 150 words. Reply with only one JSON object: {"summary": "..."})";

std::string replaceAll(std::string s, const std::string& from, const std::string& to) {
    for (std::size_t at = s.find(from); at != std::string::npos; at = s.find(from, at + to.size())) s.replace(at, from.size(), to);
    return s;
}
std::string clip(const Json::Value& v, std::size_t max) { return v.isString() ? text::utf8Prefix(text::trim(v.asString()), max) : std::string(); }
}  // namespace

Json::Value BotMemory::schema() {
    static const Json::Value s = json::parse(R"({"type":"object","required":["summary"],"properties":{
        "summary":{"type":"string"},"highlight":{"type":"string"},
        "people":{"type":"array","items":{"type":"object","required":["id","note"],"properties":{"id":{"type":"string"},"note":{"type":"string"}}}}}})");
    return s;
}

void BotMemory::flushChannel(const std::string& channelId) {
    db_.exec("UPDATE bot_window_state SET memory_flush=true WHERE channel_id=$1 AND cursor_seq > memory_seq", {channelId});
}

std::vector<BotMemory::Claim> BotMemory::due(int limit) {
    std::vector<Claim> claims;
    // Due: the bot left the window; or a scenario closed (or the story ended) and the window is quiet a moment; or many
    // new lines and a longer quiet spell.
    auto rows = db_.queryJson(
        "SELECT s.bot_id, s.chat_window_id, s.channel_id FROM bot_window_state s JOIN server_bots b ON b.id=s.bot_id AND b.deleted_at IS NULL "
        "JOIN servers sv ON sv.id=b.server_id AND sv.suspended_at IS NULL JOIN server_settings ss ON ss.server_id=b.server_id AND ss.feature_bots "
        "JOIN channels c ON c.id=s.channel_id AND c.ai_enabled "
        "LEFT JOIN chat_window_members wm ON wm.chat_window_id=s.chat_window_id AND wm.user_id=b.user_id "
        "WHERE s.cursor_seq > s.memory_seq AND (s.memory_lease_until IS NULL OR s.memory_lease_until < now()) "
        "AND (s.memory_retry_after IS NULL OR s.memory_retry_after < now()) "
        "AND (wm.user_id IS NULL "
        "  OR ((s.memory_flush OR c.story_status='ended') AND coalesce(s.last_line_at, 'epoch') < now() - make_interval(secs => $1::float8)) "
        "  OR (s.cursor_seq - s.memory_seq >= $2 AND coalesce(s.last_line_at, 'epoch') < now() - make_interval(secs => $3::float8))) "
        "ORDER BY s.memory_flush DESC LIMIT 20",
        {cfg_.botSettleMs / 1000.0, (int64_t)kLines, cfg_.botMemoryQuietMs / 1000.0});
    for (const auto& r : rows) {
        if ((int)claims.size() >= limit) break;
        const auto token = crypto::randomHex(12);
        const bool got = db_.tx([&](pqxx::work& w) {
            // One memory refresh per bot and channel at a time: they rewrite the same account.
            Db::queryOne(w, "SELECT id FROM server_bots WHERE id=$1 FOR UPDATE", {r["bot_id"].asString()});
            if (!Db::queryOne(w, "SELECT 1 AS busy FROM bot_window_state WHERE bot_id=$1 AND channel_id=$2 AND memory_lease_until > now() LIMIT 1",
                              {r["bot_id"].asString(), r["channel_id"].asString()}).isNull()) return false;
            return !Db::queryOne(w, "UPDATE bot_window_state SET memory_lease_until=now() + interval '5 minutes', memory_lease_token=$3 "
                                    "WHERE bot_id=$1 AND chat_window_id=$2 AND cursor_seq > memory_seq RETURNING bot_id",
                                 {r["bot_id"].asString(), r["chat_window_id"].asString(), token}).isNull();
        });
        if (got) claims.push_back({r["bot_id"].asString(), r["chat_window_id"].asString(), token});
    }
    return claims;
}

void BotMemory::refresh(const Claim& c) {
    auto st = db_.queryOne(
        "SELECT s.channel_id, s.memory_seq, s.cursor_seq, b.user_id, u.display_name AS name, c.name AS channel_name, c.rule_system, cw.name AS window_name "
        "FROM bot_window_state s JOIN server_bots b ON b.id=s.bot_id JOIN users u ON u.id=b.user_id JOIN channels c ON c.id=s.channel_id "
        "JOIN chat_windows cw ON cw.id=s.chat_window_id WHERE s.bot_id=$1 AND s.chat_window_id=$2 AND s.memory_lease_token=$3", {c.botId, c.windowId, c.token});
    if (st.isNull()) return;
    const auto channelId = st["channel_id"].asString(), user = st["user_id"].asString(), name = st["name"].asString();
    const auto rs = rules::canonical(json::str(st, "rule_system")).empty() ? std::string("coc7e") : rules::canonical(json::str(st, "rule_system"));
    const auto& profile = rules::profile(rs);
    long long through = st["cursor_seq"].asInt64();
    try {
        std::vector<std::string> mine, mineNames;
        for (const auto& r : db_.queryJson("SELECT id, name FROM characters WHERE channel_id=$1 AND user_id=$2", {channelId, user})) { mine.push_back(r["id"].asString()); mineNames.push_back(r["name"].asString()); }
        auto lines = db_.queryJson(
            "SELECT m.seq, m.kind, m.content, m.visibility, m.author_id, m.author_role, m.dice, u.display_name AS author_name, coalesce(u.is_bot, false) AS is_bot, ch.name AS character_name "
            "FROM messages m LEFT JOIN users u ON u.id=m.author_id LEFT JOIN characters ch ON ch.id=m.character_id "
            "WHERE m.chat_window_id=$1 AND m.seq > $2 AND m.seq <= $3 AND m.recalled_at IS NULL "
            "AND (m.visibility='window' OR (m.visibility='whisper' AND m.whisper_to && $4::uuid[])) ORDER BY m.seq LIMIT $5",
            {c.windowId, (int64_t)st["memory_seq"].asInt64(), (int64_t)through, pgArrayLiteral(mine), (int64_t)kBatch});
        if ((int)lines.size() >= kBatch) through = lines[lines.size() - 1]["seq"].asInt64();
        std::vector<std::string> open, whispered;
        std::map<std::string, std::string> people;   // the humans who spoke in the window's own lines: id → name
        Json::Value mockLines(Json::arrayValue), mockWhispers(Json::arrayValue);
        for (const auto& m : lines) {
            const auto line = BotRuntime::renderLine(m, profile.gm, user);
            if (json::str(m, "visibility") == "whisper") { whispered.push_back(line); mockWhispers.append(m["content"]); continue; }
            open.push_back(line); mockLines.append(m["content"]);
            const auto author = json::str(m, "author_id");
            if (!author.empty() && author != user && !m["is_bot"].asBool() && json::str(m, "kind") != "system") people[author] = json::str(m, "author_name");
        }
        const auto system = [&](const char* tpl) {
            return replaceAll(replaceAll(replaceAll(tpl, "{BOT}", name), "{CHANNEL}", json::str(st, "channel_name")), "{WINDOW}", json::str(st, "window_name"));
        };
        auto ask = [&](const std::string& sys, const std::string& content, const Json::Value& mock) {
            LlmRequest req;
            req.channelId = channelId; req.task = "bot_memory"; req.system = sys; req.responseSchema = schema(); req.temperature = 0.4; req.maxTokens = 1500;
            LlmMessage m; m.role = "user"; m.content = content; req.messages.push_back(m);
            req.mockContext = mock;
            auto out = llm_.runStructured(req);
            if (!out.ok) throw std::runtime_error(out.error.empty() ? "the model gave no answer" : out.error);
            return out.data;
        };
        auto prior = db_.queryOne("SELECT text, highlight FROM bot_memories WHERE bot_id=$1 AND kind='table' AND channel_id=$2", {c.botId, channelId});
        std::string account = prior.isNull() ? "" : json::str(prior, "text");
        if (!open.empty()) {
            std::vector<std::string> parts;
            parts.push_back("WHAT YOU REMEMBERED OF THIS TABLE:\n" + (account.empty() ? std::string("(nothing yet: you are new here)") : account) +
                            (prior.isNull() || json::str(prior, "highlight").empty() ? "" : "\nMost striking so far: " + json::str(prior, "highlight")));
            if (!mineNames.empty()) parts.push_back("YOUR CHARACTERS HERE: " + text::join(mineNames, ", "));
            Json::Value ids(Json::arrayValue);
            if (!people.empty()) {
                std::vector<std::string> who;
                for (const auto& [id, person] : people) {
                    auto note = db_.queryOne("SELECT text FROM bot_memories WHERE bot_id=$1 AND kind='person' AND subject_user_id=$2", {c.botId, id});
                    who.push_back("- " + id + ": " + person + (note.isNull() ? std::string() : " (you noted: " + json::str(note, "text") + ")"));
                    ids.append(id);
                }
                parts.push_back("PEOPLE:\n" + text::join(who, "\n"));
            }
            parts.push_back("NEW LINES (oldest first):\n" + text::join(open, "\n"));
            Json::Value mock; mock["name"] = name; mock["channel"] = st["channel_name"]; mock["lines"] = mockLines; mock["people"] = ids; mock["before"] = account;
            auto out = ask(system(kTable), text::join(parts, "\n\n"), mock);
            account = clip(out["summary"], 4000);
            auto highlight = clip(out["highlight"], 600);
            if (highlight.empty() && !prior.isNull()) highlight = json::str(prior, "highlight");
            db_.tx([&](pqxx::work& w) {
                Db::exec(w, "INSERT INTO bot_memories(bot_id, kind, channel_id, text, highlight) VALUES($1,'table',$2,$3,$4) "
                            "ON CONFLICT (bot_id, kind, channel_id) WHERE channel_id IS NOT NULL DO UPDATE SET text=EXCLUDED.text, highlight=EXCLUDED.highlight, source='auto', updated_at=now()",
                         {c.botId, channelId, account, highlight});
                for (const auto& p : out["people"]) {
                    const auto id = json::str(p, "id"); const auto note = clip(p["note"], 800);
                    if (!people.count(id) || note.empty()) continue;   // only people who spoke here
                    Db::exec(w, "INSERT INTO bot_memories(bot_id, kind, subject_user_id, text) VALUES($1,'person',$2,$3) "
                                "ON CONFLICT (bot_id, subject_user_id) WHERE kind='person' DO UPDATE SET text=EXCLUDED.text, source='auto', updated_at=now()",
                             {c.botId, id, note});
                }
            });
        }
        if (!whispered.empty()) {
            auto before = db_.queryOne("SELECT text FROM bot_memories WHERE bot_id=$1 AND kind='table_private' AND channel_id=$2", {c.botId, channelId});
            std::vector<std::string> parts;
            parts.push_back("WHAT YOU REMEMBERED OF THE WHISPERS:\n" + (before.isNull() ? std::string("(nothing yet)") : json::str(before, "text")));
            if (!account.empty()) parts.push_back("YOUR MEMORY OF THE TABLE:\n" + account);
            parts.push_back("NEW WHISPERS (oldest first):\n" + text::join(whispered, "\n"));
            Json::Value mock; mock["name"] = name; mock["channel"] = st["channel_name"]; mock["lines"] = mockWhispers; mock["private"] = true;
            auto out = ask(system(kPrivate), text::join(parts, "\n\n"), mock);
            db_.exec("INSERT INTO bot_memories(bot_id, kind, channel_id, text) VALUES($1,'table_private',$2,$3) "
                     "ON CONFLICT (bot_id, kind, channel_id) WHERE channel_id IS NOT NULL DO UPDATE SET text=EXCLUDED.text, source='auto', updated_at=now()",
                     {c.botId, channelId, clip(out["summary"], 4000)});
        }
        db_.exec("UPDATE bot_window_state SET memory_seq=$4, memory_flush=memory_flush AND $4 < cursor_seq, memory_lease_until=NULL, memory_lease_token=NULL, "
                 "memory_failures=0, memory_retry_after=NULL WHERE bot_id=$1 AND chat_window_id=$2 AND memory_lease_token=$3", {c.botId, c.windowId, c.token, (int64_t)through});
    } catch (const std::exception& e) {
        ALOG_WARN << "bots: " << name << " could not remember " << json::str(st, "channel_name") << ": " << e.what();
        // Tried three times: those lines are let go rather than tried for ever.
        db_.exec("UPDATE bot_window_state SET memory_seq=CASE WHEN memory_failures+1 >= 3 THEN $4 ELSE memory_seq END, "
                 "memory_failures=CASE WHEN memory_failures+1 >= 3 THEN 0 ELSE memory_failures+1 END, "
                 "memory_retry_after=now() + make_interval(secs => 60 * power(2, memory_failures)), memory_lease_until=NULL, memory_lease_token=NULL "
                 "WHERE bot_id=$1 AND chat_window_id=$2 AND memory_lease_token=$3", {c.botId, c.windowId, c.token, (int64_t)through});
    }
}

std::string BotMemory::recall(const std::string& botId, const std::string& channelId, const std::string& windowId, bool table) {
    auto bot = db_.queryOne("SELECT share_tables FROM server_bots WHERE id=$1", {botId});
    if (bot.isNull()) return "";
    std::vector<std::string> parts;
    std::size_t used = 0;
    auto add = [&](const std::string& s) { if (s.empty() || used + s.size() > kRecallBytes) return; parts.push_back(s); used += s.size(); };
    std::vector<std::string> notes;
    for (const auto& r : db_.queryJson("SELECT text FROM bot_memories WHERE bot_id=$1 AND kind='note' AND text<>'' ORDER BY updated_at DESC LIMIT 12", {botId})) notes.push_back("- " + json::str(r, "text"));
    if (!notes.empty()) add("THINGS YOU KEEP IN MIND:\n" + text::join(notes, "\n"));
    std::vector<std::string> people;
    for (const auto& r : db_.queryJson("SELECT u.display_name AS name, m.text FROM bot_memories m JOIN users u ON u.id=m.subject_user_id "
                                       "JOIN chat_window_members wm ON wm.user_id=m.subject_user_id AND wm.chat_window_id=$2 WHERE m.bot_id=$1 AND m.kind='person' AND m.text<>'' "
                                       "ORDER BY m.updated_at DESC LIMIT 12", {botId, windowId}))
        people.push_back("- " + json::str(r, "name") + ": " + json::str(r, "text"));
    if (!people.empty()) add("THE PEOPLE HERE, AS YOU KNOW THEM:\n" + text::join(people, "\n"));
    auto striking = [](const Json::Value& r) { return json::str(r, "highlight").empty() ? std::string() : "\nMost striking: " + json::str(r, "highlight"); };
    if (table) {
        for (const auto& r : db_.queryJson("SELECT kind, text, highlight FROM bot_memories WHERE bot_id=$1 AND channel_id=$2 AND text<>'' "
                                           "ORDER BY array_position(ARRAY['table','table_private','briefing'], kind)", {botId, channelId})) {
            const auto kind = json::str(r, "kind");
            if (kind == "table") add("THIS TABLE SO FAR, AS YOU REMEMBER IT:\n" + json::str(r, "text") + striking(r));
            else if (kind == "table_private") add("WHAT WAS WHISPERED TO YOU HERE (only you know it):\n" + json::str(r, "text"));
            else add("WHAT THE GM TOLD YOU PRIVATELY FOR THIS TABLE:\n" + json::str(r, "text"));
        }
        return text::join(parts, "\n\n");
    }
    // As itself: the tables everyone here played at too (every table, when it may share), this one first; never the
    // private parts or briefings.
    std::vector<std::string> tables;
    for (const auto& r : db_.queryJson(
             "SELECT c.name, m.text, m.highlight, m.channel_id=$3 AS here FROM bot_memories m JOIN channels c ON c.id=m.channel_id "
             "WHERE m.bot_id=$1 AND m.kind='table' AND m.text<>'' AND ($4 OR NOT EXISTS (SELECT 1 FROM chat_window_members wm JOIN users u ON u.id=wm.user_id AND NOT u.is_bot "
             "  WHERE wm.chat_window_id=$2 AND NOT EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id=m.channel_id AND cm.user_id=wm.user_id))) "
             "ORDER BY (m.channel_id=$3) DESC, m.updated_at DESC LIMIT 6", {botId, windowId, channelId, bot["share_tables"].asBool()}))
        tables.push_back((r["here"].asBool() ? "- Here (" : "- At \"") + json::str(r, "name") + (r["here"].asBool() ? "): " : "\": ") + json::str(r, "text") + striking(r));
    if (!tables.empty()) add("TABLES YOU PLAYED AT:\n" + text::join(tables, "\n"));
    return text::join(parts, "\n\n");
}

} // namespace acerciae
