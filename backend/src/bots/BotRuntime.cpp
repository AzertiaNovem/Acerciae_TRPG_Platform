#include "BotRuntime.h"
#include "BotPacing.h"
#include "BotCards.h"
#include "BotMemory.h"
#include "../auth/AuthService.h"
#include "../chat/ChatService.h"
#include "../inspiration/InspirationService.h"
#include "../llm/LlmGateway.h"
#include "../rules/RuleSystem.h"
#include "../servers/ServerSettingsService.h"
#include "../core/Crypto.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../core/Text.h"
#include "../core/WorkPool.h"
#include "../ws/WsGateway.h"
#include <algorithm>
#include <map>
#include <cctype>
#include <set>
#include <stdexcept>

namespace acerciae {

namespace {
// The gateway names the game and the GM ({GAME}, {GM}) for the channel's rules and adds the output language.
const char* kAtTable = R"(At this table you play one character, {PC}, alongside the human players; the {GM} runs the world. You are a fellow player with a stake in the story: share the spotlight and step into it when your character has a reason to act.

How to play:
- Stay in character, true to your character's card and to who you are. Know only what your character saw or heard in the chat log below.
- Play your own agenda. When you have a stake in the scene, take a concrete action that could change it: challenge a premise, make an offer you might regret, admit something awkward, go after a lead, or take a risk your character would take. Supporting the other players includes disagreeing in character and leaving them a real choice. Do not monopolize the scene or solve the mystery alone.
- Never narrate outcomes, the world or other characters' actions, thoughts or words; that is the {GM}'s job.
- If the {GM} asked you to roll, or an uncertain action needs a check, roll it yourself: put the exact command in "command" ({DICE}); the platform rolls it against your sheet. Never roll for anyone else and never state a result.
- Pass when you have nothing meaningful to add. Listen when someone else has the floor, but do not wait to be addressed to act on something that matters to you.
- "kind": "ic" for what your character says and does (first person, one or two short paragraphs, at most two messages); "ooc" only for a short remark to the table out of character.)";

const char* kOutside = R"(Here you have no character: you talk as yourself, out of character, with the people at this online table of {GAME}. Be the person described below: friendly, brief and natural, like a regular at the table. Answer what was said to you; do not run the game, narrate the story or speak for anyone's character. "kind" is always "ooc"; one or two short messages.)";
const char* kMayMake = R"(You have no character at this table yet. If someone asks you to make (create, roll up) your character, answer with "action": "make_character", a one-line "concept" of whom you would like to play (your taste, in keeping with who you are) and, if you like, a short message. If the {GM} offers to make your character for you, accept gladly and wait for it instead.)";

const char* kReply = R"(Reply with only one JSON object: {"action": "speak" | "roll" | "pass", "kind": "ic" | "ooc", "messages": ["..."], "command": ""}. "speak": the messages, in order. "roll": the dice command in "command", with what your character does in "messages" (may be empty). "pass": nothing to add now.)";

std::string flat(const std::string& s) {
    std::string out; bool space = false;
    for (unsigned char c : s) { if (c == ' ' || c == '\n' || c == '\t' || c == '\r') { if (!space) out += ' '; space = true; } else { out += (char)c; space = false; } }
    return text::trim(out);
}
void replaceAll(std::string& s, const std::string& from, const std::string& to) {
    for (std::size_t at = s.find(from); at != std::string::npos; at = s.find(from, at + to.size())) s.replace(at, from.size(), to);
}
std::string commandWord(const std::string& command) {
    std::string w;
    for (std::size_t i = 1; i < command.size() && std::isalpha((unsigned char)command[i]); ++i) w += (char)std::tolower((unsigned char)command[i]);
    return w;
}
}  // namespace

// One chat line as the bot reads it: who (a character's name in play, a person's name otherwise), how, and what.
std::string BotRuntime::renderLine(const Json::Value& m, const std::string& gm, const std::string& me) {
    const auto kind = json::str(m, "kind");
    std::string who = !json::str(m, "character_name").empty() && kind != "ooc" ? json::str(m, "character_name") : json::str(m, "author_name");
    if (who.empty()) who = "someone";
    if (json::str(m, "author_id") == me) who += " (you)";
    else if (json::str(m, "author_role") == "gm" && json::str(m, "character_name").empty()) who += " (" + gm + ")";
    else if (m["is_bot"].asBool()) who += " (bot)";
    std::string tag = kind == "ooc" ? " (out of character)" : kind == "narration" ? " (narration)" : kind == "roll" ? " (roll)" : kind == "system" ? " (system)" : "";
    if (json::str(m, "visibility") == "whisper") tag += " (whispered to you)";
    std::string content = flat(json::str(m, "content"));
    if (kind == "roll" && m["dice"].isObject() && !json::str(m["dice"], "text").empty()) content = flat(json::str(m["dice"], "text"));
    return "#" + std::to_string(json::toInt(m, "seq", 0)) + " " + who + tag + ": " + content;
}

BotRuntime::BotRuntime(const Config& cfg, Db& db, AuthService& auth, ChatService& chat, LlmGateway& llm, ServerSettingsService& settings, CharacterSpaceService& space, DiceService& dice)
    : cfg_(cfg), db_(db), auth_(auth), chat_(chat), llm_(llm), settings_(settings), memory_(std::make_unique<BotMemory>(cfg, db, llm)),
      cards_(std::make_unique<BotCards>(db, auth, chat, space, llm, dice, *memory_)) {}
BotRuntime::~BotRuntime() { stop(); }

void BotRuntime::start() {
    if (!cfg_.botsEnabled || running_.exchange(true)) return;
    pool_ = std::make_unique<WorkPool>("bots", 2, 64);
    thread_ = std::thread([this] { loop(); });
}
void BotRuntime::stop() {
    if (!running_.exchange(false)) return;
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
    if (pool_) pool_->stop();
}
void BotRuntime::loop() {
    while (running_) {
        try { tick(false); } catch (const std::exception& e) { ALOG_ERROR << "bots: " << e.what(); }
        try { memoryTick(false); } catch (const std::exception& e) { ALOG_ERROR << "bots: memory: " << e.what(); }
        std::unique_lock<std::mutex> lk(mu_);
        cv_.wait_for(lk, std::chrono::milliseconds(cfg_.botTickMs), [&] { return !running_.load(); });
    }
}

Json::Value BotRuntime::schema() {
    static const Json::Value s = json::parse(R"({"type":"object","required":["action"],"properties":{
        "action":{"type":"string","enum":["speak","roll","pass","make_character"]},"kind":{"type":"string"},
        "messages":{"type":"array","items":{"type":"string"}},"command":{"type":"string"},"concept":{"type":"string"}}})");
    return s;
}

Json::Value BotRuntime::checkTurn(const Json::Value& out, bool table, const std::string& ruleSystem, bool canMake) {
    if (!out.isObject()) throw std::runtime_error("the answer is not an object");
    const auto action = json::str(out, "action");
    if (action != "speak" && action != "roll" && action != "pass" && action != "make_character") throw std::runtime_error("unknown action \"" + action + "\"");
    if (action == "make_character" && (table || !canMake)) throw std::runtime_error("it already has a character here");
    Json::Value move; move["action"] = action;
    move["kind"] = table && json::str(out, "kind") != "ooc" ? "ic" : "ooc";
    move["messages"] = Json::Value(Json::arrayValue);
    move["command"] = "";
    if (action == "pass") return move;
    move["concept"] = text::utf8Prefix(text::trim(json::str(out, "concept")), 400);
    if (out["messages"].isArray())
        for (const auto& m : out["messages"]) {
            if (!m.isString()) continue;
            auto t = text::trim(m.asString());
            if (t.empty()) continue;
            if (move["messages"].size() == 2) { move["messages"][1] = move["messages"][1].asString() + "\n\n" + t; continue; }   // at most two lines
            move["messages"].append(text::utf8Prefix(t, 4000));
        }
    if (action == "roll") {
        if (!table) throw std::runtime_error("a bot rolls only for its own character at the table");
        auto command = text::trim(json::str(out, "command"));
        if (command.rfind("。", 0) == 0) command = "." + command.substr(std::string("。").size());
        if (command.size() < 2 || command[0] != '.') throw std::runtime_error("a roll needs a dot command");
        const auto word = commandWord(command);
        static const std::set<std::string> allowed = {"r", "ra", "rc", "sc"};
        // Its own dice only: never set or develop a sheet (.st .en), never a hidden roll; PbtA moves go through the GM.
        if (ruleSystem == "pbta" || !allowed.count(word)) throw std::runtime_error("the command ." + word + " is not one a bot may send");
        move["command"] = text::utf8Prefix(command, 200);
        return move;
    }
    if (action == "make_character") return move;
    if (move["messages"].empty()) throw std::runtime_error("nothing to say");
    for (const auto& m : move["messages"])
        if (m.asString()[0] == '.' || m.asString().rfind("。", 0) == 0) throw std::runtime_error("a dice command belongs in \"command\"");
    return move;
}

std::vector<BotRuntime::Claim> BotRuntime::scan() {
    std::vector<Claim> claims;
    // A turn left running by a process that stopped is given up: never posted twice.
    db_.exec("UPDATE bot_turns SET status='failed', error='interrupted', finished_at=now() WHERE status='running' AND started_at < now() - interval '10 minutes'");
    // A bot that left a window, once it has written down what it saw there, forgets its place: invited back, it starts
    // again from the window's end.
    db_.exec("DELETE FROM bot_window_state s USING server_bots b WHERE b.id=s.bot_id AND s.memory_seq >= s.cursor_seq AND (s.lease_until IS NULL OR s.lease_until < now()) "
             "AND NOT EXISTS (SELECT 1 FROM chat_window_members wm WHERE wm.chat_window_id=s.chat_window_id AND wm.user_id=b.user_id)");
    // Every bot starts reading a window it is in from that window's current end.
    db_.exec("INSERT INTO bot_window_state(bot_id, chat_window_id, channel_id, cursor_seq, memory_seq) "
             "SELECT b.id, wm.chat_window_id, cw.channel_id, coalesce((SELECT max(m.seq) FROM messages m WHERE m.chat_window_id=wm.chat_window_id), 0), "
             "coalesce((SELECT max(m.seq) FROM messages m WHERE m.chat_window_id=wm.chat_window_id), 0) "
             "FROM server_bots b JOIN chat_window_members wm ON wm.user_id=b.user_id JOIN chat_windows cw ON cw.id=wm.chat_window_id "
             "WHERE b.deleted_at IS NULL AND cw.archived_at IS NULL ON CONFLICT DO NOTHING");
    auto rows = db_.queryJson(
        "SELECT s.bot_id, s.chat_window_id FROM bot_window_state s JOIN server_bots b ON b.id=s.bot_id JOIN servers sv ON sv.id=b.server_id "
        "JOIN server_settings ss ON ss.server_id=b.server_id AND ss.feature_bots JOIN channels c ON c.id=s.channel_id AND c.ai_enabled "
        "JOIN chat_window_members wm ON wm.chat_window_id=s.chat_window_id AND wm.user_id=b.user_id JOIN chat_windows cw ON cw.id=s.chat_window_id AND cw.archived_at IS NULL "
        "WHERE b.deleted_at IS NULL AND b.enabled AND sv.suspended_at IS NULL AND (s.lease_until IS NULL OR s.lease_until < now()) "
        "AND (s.retry_after IS NULL OR s.retry_after < now()) "
        "AND (s.owed IS NOT NULL OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_window_id=s.chat_window_id AND m.seq > s.cursor_seq)) LIMIT 200");
    const bots::Timing timing{cfg_.botSettleMs / 1000.0, cfg_.botGmWaitMs / 1000.0};
    for (const auto& r : rows) {
        const auto botId = r["bot_id"].asString(), windowId = r["chat_window_id"].asString();
        db_.tx([&](pqxx::work& w) {
            auto st = Db::queryOne(w,
                "SELECT s.*, coalesce(extract(epoch FROM s.owed_at), 0) AS owed_at_s, coalesce(extract(epoch FROM s.last_line_at), 0) AS last_line_s, extract(epoch FROM now()) AS now_s, "
                "extract(epoch FROM s.last_eval_at) AS last_eval_s, b.user_id, b.turns_per_hour, b.unprompted_per_hour, c.bot_chatter_enabled, "
                "u.display_name AS name, coalesce(c.bot_pacing_until > now(), false) AS agent_pacing, cw.purpose, c.story_status "
                "FROM bot_window_state s JOIN server_bots b ON b.id=s.bot_id JOIN users u ON u.id=b.user_id JOIN channels c ON c.id=s.channel_id "
                "JOIN chat_windows cw ON cw.id=s.chat_window_id WHERE s.bot_id=$1 AND s.chat_window_id=$2 AND (s.lease_until IS NULL OR s.lease_until < now()) "
                "FOR UPDATE OF s SKIP LOCKED", {botId, windowId});
            if (st.isNull()) return;   // another instance has it
            const auto user = st["user_id"].asString();
            bots::Self me; me.userId = user; me.names = {st["name"].asString()};
            me.agentPacing = st["agent_pacing"].asBool();
            std::vector<std::string> mine;
            for (const auto& c : Db::queryJson(w, "SELECT id, name FROM characters WHERE channel_id=$1 AND user_id=$2 AND kind='pc'", {st["channel_id"].asString(), user})) {
                mine.push_back(c["id"].asString()); me.names.push_back(c["name"].asString());
            }
            auto bound = Db::queryOne(w, "SELECT character_id FROM chat_window_members WHERE chat_window_id=$1 AND user_id=$2", {windowId, user});
            me.table = st["purpose"] == "story" && st["story_status"] != "ended" && !bound.isNull() && !bound["character_id"].isNull();
            bots::State s;
            s.owed = json::str(st, "owed"); s.owedSeq = st["owed_seq"].asInt64(); s.owedAt = st["owed_at_s"].asDouble();
            s.gmSeen = st["gm_seen"].asBool(); s.lastLineAt = st["last_line_s"].asDouble(); s.chain = st["chain"].asInt(); s.heard = st["heard"].asInt();
            long long cursor = st["cursor_seq"].asInt64();
            for (const auto& l : Db::queryJson(w,
                     "SELECT m.seq, extract(epoch FROM m.created_at) AS at, m.author_id, m.author_role, coalesce(u.is_bot, false) AS is_bot, m.kind, m.content, m.visibility, "
                     "(m.whisper_to && $3::uuid[]) AS to_me, m.recalled_at IS NOT NULL AS recalled FROM messages m LEFT JOIN users u ON u.id=m.author_id "
                     "WHERE m.chat_window_id=$1 AND m.seq > $2 ORDER BY m.seq LIMIT 500", {windowId, (int64_t)cursor, pgArrayLiteral(mine)})) {
                cursor = std::max(cursor, (long long)l["seq"].asInt64());
                // What the bot witnessed: its window's lines and whispers to its characters; never GM-only lines.
                const auto vis = json::str(l, "visibility");
                if (l["recalled"].asBool() || vis == "gm_only" || (vis == "whisper" && !l["to_me"].asBool())) continue;
                bots::Line line; line.seq = l["seq"].asInt64(); line.at = l["at"].asDouble(); line.authorId = json::str(l, "author_id");
                line.authorIsBot = l["is_bot"].asBool(); line.authorIsGm = json::str(l, "author_role") == "gm"; line.kind = json::str(l, "kind");
                line.content = json::str(l, "content"); line.whisperedToMe = vis == "whisper";
                bots::ingest(s, me, line);
            }
            bool claim = bots::due(s, st["now_s"].asDouble(), timing);
            // Outside the table, people talked a while without naming it: it may join in on its own, within its hourly
            // allowance and while the GM lets bots chatter here. Asking itself counts, whatever it answers.
            bool evaluated = false;
            const bots::Chatter chatter{bots::kChatterHeard, cfg_.botChatterGapMs / 1000.0, cfg_.botChatterQuietMs / 1000.0};
            if (!claim && !me.table && !me.agentPacing && st["bot_chatter_enabled"].asBool() && st["unprompted_per_hour"].asInt() > 0 &&
                bots::chatter(s, st["now_s"].asDouble(), st["last_eval_s"].asDouble(), chatter)) {
                evaluated = true; s.heard = 0;
                if (Db::queryOne(w, "SELECT count(*) AS n FROM bot_turns WHERE bot_id=$1 AND trigger='unprompted' AND status='posted' AND started_at > now() - interval '1 hour'",
                                 {botId})["n"].asInt64() < st["unprompted_per_hour"].asInt64()) {
                    s.owed = "unprompted"; s.owedSeq = cursor; s.owedAt = st["now_s"].asDouble(); s.gmSeen = true; claim = true;
                }
            }
            // Someone is writing: let them finish (but not for ever).
            if (claim && st["now_s"].asDouble() - s.owedAt < 45 && WsGateway::instance().someoneTyping(windowId, user)) claim = false;
            if (claim && Db::queryOne(w, "SELECT count(*) AS n FROM bot_turns WHERE bot_id=$1 AND started_at > now() - interval '1 hour'", {botId})["n"].asInt64() >= st["turns_per_hour"].asInt64()) {
                ALOG_INFO << "bots: " << st["name"].asString() << " reached its turns for this hour; a turn is skipped";
                s.owed.clear(); claim = false;
            }
            const std::string token = claim ? crypto::randomHex(12) : "";
            Db::exec(w,
                "UPDATE bot_window_state SET cursor_seq=$3, owed=$4, owed_seq=$5, owed_at=CASE WHEN $6::float8 > 0 THEN to_timestamp($6::float8) END, gm_seen=$7, "
                "last_line_at=CASE WHEN $8::float8 > 0 THEN to_timestamp($8::float8) END, chain=$9, heard=$11, last_eval_at=CASE WHEN $12 THEN now() ELSE last_eval_at END, "
                "lease_until=CASE WHEN $10='' THEN lease_until ELSE now() + interval '3 minutes' END, lease_token=CASE WHEN $10='' THEN lease_token ELSE $10 END "
                "WHERE bot_id=$1 AND chat_window_id=$2",
                {botId, windowId, (int64_t)cursor, s.owed.empty() ? dbNull() : DbParam(s.owed), (int64_t)s.owedSeq, s.owedAt, s.gmSeen, s.lastLineAt, (int64_t)s.chain, token,
                 (int64_t)s.heard, evaluated});
            if (claim) claims.push_back({botId, windowId, token});
        });
    }
    return claims;
}

int BotRuntime::memoryTick(bool inlineRuns) {
    auto claims = memory_->due();
    for (const auto& c : claims) {
        if (inlineRuns || !pool_) { memory_->refresh(c); continue; }
        if (!pool_->submit([this, c] { memory_->refresh(c); }))
            db_.exec("UPDATE bot_window_state SET memory_lease_until=NULL, memory_lease_token=NULL WHERE bot_id=$1 AND chat_window_id=$2 AND memory_lease_token=$3", {c.botId, c.windowId, c.token});
    }
    return (int)claims.size();
}

int BotRuntime::tick(bool inlineTurns) {
    auto claims = scan();
    for (const auto& c : claims) {
        if (inlineTurns || !pool_) { runTurn(c); continue; }
        if (!pool_->submit([this, c] { runTurn(c); }))
            db_.exec("UPDATE bot_window_state SET lease_until=NULL, lease_token=NULL WHERE bot_id=$1 AND chat_window_id=$2 AND lease_token=$3", {c.botId, c.windowId, c.token});
    }
    return (int)claims.size();
}

void BotRuntime::runTurn(const Claim& c) {
    auto st = db_.queryOne(
        "SELECT s.*, b.user_id, b.persona, b.speaking_style, u.display_name AS name, c.rule_system, c.description, c.bot_brief, c.story_status, cw.purpose "
        "FROM bot_window_state s JOIN server_bots b ON b.id=s.bot_id JOIN users u ON u.id=b.user_id JOIN channels c ON c.id=s.channel_id "
        "JOIN chat_windows cw ON cw.id=s.chat_window_id WHERE s.bot_id=$1 AND s.chat_window_id=$2 AND s.lease_token=$3", {c.botId, c.windowId, c.token});
    if (st.isNull()) return;   // the lease was lost
    const auto release = [&](const char* set) {
        db_.exec(std::string("UPDATE bot_window_state SET ") + set + ", lease_until=NULL, lease_token=NULL WHERE bot_id=$1 AND chat_window_id=$2 AND lease_token=$3", {c.botId, c.windowId, c.token});
    };
    const auto trigger = json::str(st, "owed");
    if (trigger.empty()) { release("owed=owed"); return; }
    const auto channelId = st["channel_id"].asString(), user = st["user_id"].asString(), name = st["name"].asString();
    const auto rs = rules::canonical(json::str(st, "rule_system")).empty() ? std::string("coc7e") : rules::canonical(json::str(st, "rule_system"));
    auto pc = db_.queryOne("SELECT c.id, c.name, c.bio, c.speaking_style, c.role_card, c.sheet FROM chat_window_members wm JOIN characters c ON c.id=wm.character_id "
                           "WHERE wm.chat_window_id=$1 AND wm.user_id=$2 AND c.user_id=$2", {c.windowId, user});
    const bool table = !pc.isNull() && st["purpose"] == "story" && st["story_status"] != "ended";
    // Once per trigger, ever: a turn interrupted midway is not taken again.
    auto turn = db_.queryOne("INSERT INTO bot_turns(bot_id, channel_id, chat_window_id, trigger, trigger_seq, mode) VALUES($1,$2,$3,$4,$5,$6) "
                             "ON CONFLICT DO NOTHING RETURNING id", {c.botId, channelId, c.windowId, trigger, st["owed_seq"].asInt64(), table ? "table" : "self"});
    if (turn.isNull()) { release("owed=NULL"); return; }
    const auto turnId = turn["id"].asString();
    std::vector<std::string> posted;
    // At the table its character shows as writing while it composes.
    struct Typing { std::string ch, win, pc, user; ~Typing() { if (!pc.empty()) try { WsGateway::instance().setServerTyping(ch, win, pc, user, false); } catch (...) {} } } typing;
    if (table) { typing.ch = channelId; typing.win = c.windowId; typing.pc = pc["id"].asString(); typing.user = user; try { WsGateway::instance().setServerTyping(channelId, c.windowId, typing.pc, user, true); } catch (...) {} }
    try {
        std::vector<std::string> mine;
        for (const auto& r : db_.queryJson("SELECT id FROM characters WHERE channel_id=$1 AND user_id=$2", {channelId, user})) mine.push_back(r["id"].asString());
        const bool canMake = mine.empty();   // no character in this channel yet: it may make one when asked
        auto log = db_.queryJson(
            "SELECT m.seq, m.kind, m.content, m.visibility, m.author_id, m.author_role, m.dice, u.display_name AS author_name, coalesce(u.is_bot, false) AS is_bot, ch.name AS character_name "
            "FROM messages m LEFT JOIN users u ON u.id=m.author_id LEFT JOIN characters ch ON ch.id=m.character_id WHERE m.chat_window_id=$1 AND m.recalled_at IS NULL "
            "AND (m.visibility='window' OR (m.visibility='whisper' AND m.whisper_to && $2::uuid[])) ORDER BY m.seq DESC LIMIT 40", {c.windowId, pgArrayLiteral(mine)});
        std::reverse(log.begin(), log.end());
        const auto& profile = rules::profile(rs);
        std::string system = "You are " + name + ", a member of an online tabletop roleplaying community.\n\nWHO YOU ARE:\n" +
            (json::str(st, "persona").empty() ? "(no description: a friendly, curious regular)" : json::str(st, "persona")) +
            (json::str(st, "speaking_style").empty() ? "" : "\n\nHOW YOU WRITE:\n" + json::str(st, "speaking_style")) + "\n\n" + (table ? kAtTable : kOutside) + (canMake && !table ? std::string("\n\n") + kMayMake : std::string()) + "\n\n" + kReply;
        replaceAll(system, "{PC}", table ? pc["name"].asString() : "");
        replaceAll(system, "{DICE}", InspirationService::diceShape(rs));
        std::vector<std::string> parts;
        if (!json::str(st, "description").empty()) parts.push_back("THE CAMPAIGN:\n" + json::str(st, "description"));
        if (!json::str(st, "bot_brief").empty()) parts.push_back("WHAT THE " + profile.gm + " TELLS THE BOTS AT THIS TABLE:\n" + json::str(st, "bot_brief"));
        const auto remembered = memory_->recall(c.botId, channelId, c.windowId, table);
        if (!remembered.empty()) parts.push_back(remembered);
        if (table) {
            Json::Value attrs = pc["sheet"].isObject() ? pc["sheet"]["attrs"] : Json::Value(Json::objectValue);
            parts.push_back("YOUR CHARACTER: " + pc["name"].asString() + (json::str(pc, "speaking_style").empty() ? "" : " (speaks: " + json::str(pc, "speaking_style") + ")") +
                            (json::str(pc, "bio").empty() ? "" : "\n" + json::str(pc, "bio")) + "\n" + InspirationService::cardSummary(pc["role_card"], attrs, rs));
        }
        std::vector<std::string> lines; for (const auto& m : log) lines.push_back(renderLine(m, profile.gm, user));
        parts.push_back("CHAT LOG (newest last):\n" + (lines.empty() ? std::string("(nothing yet)") : text::join(lines, "\n")));
        const std::map<std::string, std::string> why = {
            {"player", "A player has just spoken; it may be your moment to act, or not."}, {"addressed", "Someone at the table spoke to you or your character."},
            {"mention", "Someone mentioned you."}, {"called", "The " + profile.gm + " asks the bots to take their turn now."},
            {"adopt", "You were given a character to play here."}, {"unprompted", "Nobody asked you anything; speak only if you have something worth saying."}};
        parts.push_back("NOW: " + (why.count(trigger) ? why.at(trigger) : std::string("Your turn.")) + " Your move?");
        LlmRequest req;
        req.channelId = channelId; req.task = "bot_turn"; req.system = system; req.responseSchema = schema(); req.temperature = 0.8; req.maxTokens = 1200;
        LlmMessage ask; ask.role = "user"; ask.content = text::join(parts, "\n\n"); req.messages.push_back(ask);
        Json::Value mock; mock["mode"] = table ? "table" : "self"; mock["trigger"] = trigger; mock["name"] = name; mock["pc"] = table ? pc["name"] : Json::Value(""); mock["can_make"] = canMake && !table;
        mock["newest"] = log.empty() ? Json::Value(Json::objectValue) : log[log.size() - 1];
        mock["memory"] = remembered;
        req.mockContext = mock;
        auto out = llm_.runStructured(req);
        if (!out.ok) throw std::runtime_error(out.error.empty() ? "the model gave no answer" : out.error);
        auto move = checkTurn(out.data, table, rs, canMake);
        // A person spoke while the bot was composing: its draft answers an older moment. The debt stays.
        if (!db_.queryOne("SELECT 1 AS ok FROM messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.chat_window_id=$1 AND m.seq > $2 AND m.author_role='player' "
                          "AND NOT coalesce(u.is_bot, false) AND m.recalled_at IS NULL AND m.visibility='window' LIMIT 1", {c.windowId, st["cursor_seq"].asInt64()}).isNull()) {
            db_.exec("UPDATE bot_turns SET status='discarded', action=$2, finished_at=now() WHERE id=$1", {turnId, move["action"].asString()});
            release("owed=owed");
            return;
        }
        if (move["action"] == "pass") {
            db_.exec("UPDATE bot_turns SET status='passed', action='pass', finished_at=now() WHERE id=$1", {turnId});
            release("owed=NULL, last_turn_at=now(), failures=0, last_error=''");
            return;
        }
        auto access = auth_.channelAccess(user, channelId);
        if (move["action"] == "make_character") {
            for (const auto& m : move["messages"]) {
                Json::Value body; body["content"] = m.asString(); body["kind"] = "ooc"; body["visibility"] = "window";
                posted.push_back(chat_.postMessage(access, c.windowId, body)["id"].asString());
            }
            const auto made = cards_->make(c.botId, channelId, c.windowId, move["concept"].asString());
            db_.exec("UPDATE bot_turns SET status='posted', action='make_character', message_ids=$2::uuid[], error=$3, finished_at=now() WHERE id=$1",
                     {turnId, pgArrayLiteral(posted), made.empty() ? std::string("no character was made") : std::string()});
            release("owed=NULL, chain=chain+1, last_turn_at=now(), failures=0, last_error=''");
            return;
        }
        auto say = [&](const std::string& content, const std::string& kind) {
            Json::Value body; body["content"] = content; body["kind"] = kind; body["visibility"] = "window";
            if (table) body["character_id"] = pc["id"];
            posted.push_back(chat_.postMessage(access, c.windowId, body)["id"].asString());
        };
        for (const auto& m : move["messages"]) say(m.asString(), move["kind"].asString());
        if (move["action"] == "roll") say(move["command"].asString(), "ic");
        db_.exec("UPDATE bot_turns SET status='posted', action=$2, message_ids=$3::uuid[], finished_at=now() WHERE id=$1", {turnId, move["action"].asString(), pgArrayLiteral(posted)});
        release("owed=NULL, chain=chain+1, last_turn_at=now(), failures=0, last_error=''");
    } catch (const std::exception& e) {
        ALOG_WARN << "bots: " << name << "'s turn failed: " << e.what();
        if (!posted.empty()) {   // part of it reached the table: done, never again
            db_.exec("UPDATE bot_turns SET status='posted', message_ids=$2::uuid[], error=$3, finished_at=now() WHERE id=$1", {turnId, pgArrayLiteral(posted), std::string(e.what()).substr(0, 500)});
            release("owed=NULL, chain=chain+1, last_turn_at=now()");
            return;
        }
        // Nothing posted: the same trigger may be tried again later, three times at most, further apart each time.
        db_.exec("DELETE FROM bot_turns WHERE id=$1", {turnId});
        db_.exec("UPDATE bot_window_state SET failures=CASE WHEN failures+1 >= 3 THEN 0 ELSE failures+1 END, last_error=$4, "
                 "retry_after=now() + make_interval(secs => 30 * power(2, failures)), owed=CASE WHEN failures+1 >= 3 THEN NULL ELSE owed END, "
                 "lease_until=NULL, lease_token=NULL WHERE bot_id=$1 AND chat_window_id=$2 AND lease_token=$3",
                 {c.botId, c.windowId, c.token, std::string(e.what()).substr(0, 500)});
    }
}

} // namespace acerciae
