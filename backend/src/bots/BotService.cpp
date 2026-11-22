#include "BotService.h"
#include "../auth/AuthService.h"
#include "../chat/ChatService.h"
#include "../chat/ChatQueries.h"
#include "../dice/DiceService.h"
#include "../knowledge/Visibility.h"
#include "../servers/ServerSettingsService.h"
#include "../ws/Notifier.h"
#include "../core/Crypto.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include <set>

namespace acerciae {

namespace {
// A text setting: trimmed, at most `max` bytes, on one line when asked; the current value when absent.
std::string textField(const Json::Value& b, const char* key, std::size_t max, const std::string& current, bool oneLine, bool required = false) {
    if (!b.isMember(key)) { if (required) throw badRequest(std::string(key) + " is required"); return current; }
    if (!b[key].isString()) throw badRequest(std::string(key) + " must be text");
    auto v = text::trim(b[key].asString());
    if (required && v.empty()) throw badRequest(std::string(key) + " is required");
    if (v.size() > max) throw badRequest(std::string(key) + " must be at most " + std::to_string(max) + " bytes");
    if (oneLine && v.find_first_of("\r\n\t") != std::string::npos) throw badRequest(std::string(key) + " must be on one line");
    return v;
}
int intField(const Json::Value& b, const char* key, int lo, int hi, int current) {
    if (!b.isMember(key)) return current;
    if (!b[key].isIntegral()) throw badRequest(std::string(key) + " must be a whole number");
    auto v = b[key].asInt64();
    if (v < lo || v > hi) throw badRequest(std::string(key) + " must be between " + std::to_string(lo) + " and " + std::to_string(hi));
    return (int)v;
}
bool boolField(const Json::Value& b, const char* key, bool current) {
    if (!b.isMember(key)) return current;
    if (!b[key].isBool()) throw badRequest(std::string(key) + " must be true or false");
    return b[key].asBool();
}
const char* BOT_SELECT =
    "SELECT b.*, u.display_name AS name, u.username, "
    "(SELECT coalesce(json_agg(json_build_object('id', c.id, 'name', c.name) ORDER BY c.name), '[]'::json) FROM channel_members cm JOIN channels c ON c.id=cm.channel_id "
    " WHERE cm.user_id=b.user_id) AS channels "
    "FROM server_bots b JOIN users u ON u.id=b.user_id ";
}

void BotService::requireMaintainer(const Principal& p, const std::string& serverId) {
    if (!Visibility::isUuid(serverId)) throw notFound("server not found");
    auth_.requireServerAdmin(p.userId, serverId);
}

Json::Value BotService::botRow(const std::string& serverId, const std::string& botId) {
    if (!Visibility::isUuid(botId)) throw notFound("bot not found");
    auto r = db_.queryOne(std::string(BOT_SELECT) + "WHERE b.id=$1 AND b.server_id=$2 AND b.deleted_at IS NULL", {botId, serverId});
    if (r.isNull()) throw notFound("bot not found");
    return r;
}

Json::Value BotService::view(const Json::Value& r, bool full) {
    Json::Value v;
    v["id"] = r["id"]; v["user_id"] = r["user_id"]; v["name"] = r["name"]; v["enabled"] = r["enabled"];
    if (!full) return v;
    v["persona"] = r["persona"]; v["speaking_style"] = r["speaking_style"];
    v["unprompted_per_hour"] = r["unprompted_per_hour"]; v["turns_per_hour"] = r["turns_per_hour"]; v["share_tables"] = r["share_tables"];
    v["created_at"] = r["created_at"]; v["updated_at"] = r["updated_at"];
    v["channels"] = r["channels"].isArray() ? r["channels"] : Json::Value(Json::arrayValue);
    return v;
}

Json::Value BotService::list(const Principal& p, const std::string& serverId) {
    if (!Visibility::isUuid(serverId)) throw notFound("server not found");
    auth_.requireServerMember(p.userId, serverId);
    const bool full = chatQueries::serverRole(db_, serverId, p.userId) == "owner" || chatQueries::serverRole(db_, serverId, p.userId) == "admin";
    Json::Value out(Json::arrayValue);
    for (const auto& r : db_.queryJson(std::string(BOT_SELECT) + "WHERE b.server_id=$1 AND b.deleted_at IS NULL ORDER BY u.display_name, b.created_at", {serverId}))
        out.append(view(r, full));
    return out;
}

Json::Value BotService::create(const Principal& p, const std::string& serverId, const Json::Value& body) {
    requireMaintainer(p, serverId);
    settings_.requireFeature(serverId, "bots");
    if (!body.isObject()) throw badRequest("a bot needs a name");
    const auto name = textField(body, "name", 100, "", true, true);
    const auto persona = textField(body, "persona", 8000, "", false);
    const auto style = textField(body, "speaking_style", 1000, "", false);
    const bool enabled = boolField(body, "enabled", true), share = boolField(body, "share_tables", false);
    const int unprompted = intField(body, "unprompted_per_hour", 0, 60, 2), turns = intField(body, "turns_per_hour", 1, 600, 60);
    std::string id;
    db_.tx([&](pqxx::work& w) {
        if (Db::queryOne(w, "SELECT count(*) AS n FROM server_bots WHERE server_id=$1 AND deleted_at IS NULL", {serverId})["n"].asInt64() >= 50)
            throw conflict("this server already has 50 bots");
        // The bot's own account: a reserved username, no password that could ever match.
        auto user = Db::queryOne(w, "INSERT INTO users(username, display_name, password_hash, is_bot) VALUES($1,$2,'!',true) RETURNING id",
                                 {"bot-" + crypto::randomHex(6), name})["id"].asString();
        Db::exec(w, "INSERT INTO server_members(server_id, user_id, role) VALUES($1,$2,'member')", {serverId, user});
        id = Db::queryOne(w, "INSERT INTO server_bots(server_id, user_id, persona, speaking_style, enabled, unprompted_per_hour, turns_per_hour, share_tables, created_by) "
                             "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
                          {serverId, user, persona, style, enabled, (int64_t)unprompted, (int64_t)turns, share, p.userId})["id"].asString();
    });
    return view(botRow(serverId, id), true);
}

Json::Value BotService::update(const Principal& p, const std::string& serverId, const std::string& botId, const Json::Value& body) {
    requireMaintainer(p, serverId);
    settings_.requireFeature(serverId, "bots");
    auto cur = botRow(serverId, botId);
    if (!body.isObject()) throw badRequest("nothing to change");
    const auto name = textField(body, "name", 100, cur["name"].asString(), true);
    if (name.empty()) throw badRequest("name is required");
    const auto persona = textField(body, "persona", 8000, cur["persona"].asString(), false);
    const auto style = textField(body, "speaking_style", 1000, cur["speaking_style"].asString(), false);
    const bool enabled = boolField(body, "enabled", cur["enabled"].asBool()), share = boolField(body, "share_tables", cur["share_tables"].asBool());
    const int unprompted = intField(body, "unprompted_per_hour", 0, 60, cur["unprompted_per_hour"].asInt());
    const int turns = intField(body, "turns_per_hour", 1, 600, cur["turns_per_hour"].asInt());
    db_.tx([&](pqxx::work& w) {
        Db::exec(w, "UPDATE users SET display_name=$2 WHERE id=$1", {cur["user_id"].asString(), name});
        Db::exec(w, "UPDATE server_bots SET persona=$2, speaking_style=$3, enabled=$4, unprompted_per_hour=$5, turns_per_hour=$6, share_tables=$7, updated_at=now() WHERE id=$1",
                 {botId, persona, style, enabled, (int64_t)unprompted, (int64_t)turns, share});
    });
    auto fresh = botRow(serverId, botId);
    for (const auto& c : fresh["channels"]) notifier_.botsChanged(c["id"].asString());
    return view(fresh, true);
}

Json::Value BotService::remove(const Principal& p, const std::string& serverId, const std::string& botId) {
    requireMaintainer(p, serverId);
    auto cur = botRow(serverId, botId);
    const auto user = cur["user_id"].asString();
    std::vector<std::pair<std::string, std::string>> left;   // channel, window
    db_.tx([&](pqxx::work& w) {
        for (const auto& r : Db::queryJson(w, "DELETE FROM chat_window_members wm USING chat_windows cw WHERE cw.id=wm.chat_window_id AND wm.user_id=$1 RETURNING cw.id, cw.channel_id", {user}))
            left.emplace_back(r["channel_id"].asString(), r["id"].asString());
        Db::exec(w, "DELETE FROM channel_members WHERE user_id=$1", {user});
        Db::exec(w, "UPDATE server_bots SET deleted_at=now(), enabled=false, updated_at=now() WHERE id=$1", {botId});
    });
    std::set<std::string> channels;
    for (const auto& [channel, window] : left) {
        channels.insert(channel);
        auto win = db_.queryOne("SELECT * FROM chat_windows WHERE id=$1", {window});
        if (!win.isNull()) notifier_.windowChanged(channel, win);
    }
    for (const auto& c : cur["channels"]) channels.insert(c["id"].asString());
    for (const auto& c : channels) notifier_.botsChanged(c);
    Json::Value v; v["ok"] = true;
    return v;
}

Json::Value BotService::channelView(const ChannelAccess& a) {
    Json::Value v;
    const bool feature = settings_.featureEnabled(a.serverId, "bots");
    auto ch = db_.queryOne("SELECT c.bot_invites_enabled, ss.bots_per_channel FROM channels c LEFT JOIN server_settings ss ON ss.server_id=c.server_id WHERE c.id=$1", {a.channelId});
    v["feature"] = feature;
    v["invites_enabled"] = ch["bot_invites_enabled"].asBool();
    v["limit"] = ch["bots_per_channel"].isNull() ? 3 : ch["bots_per_channel"].asInt();
    v["can_invite"] = feature && (a.isGm || ch["bot_invites_enabled"].asBool());
    v["can_remove"] = a.isGm;
    v["present"] = Json::Value(Json::arrayValue);
    v["invitable"] = Json::Value(Json::arrayValue);
    for (const auto& r : db_.queryJson(
             "SELECT b.id, b.user_id, u.display_name AS name, b.enabled, cm.joined_at, iu.display_name AS invited_by_name, "
             "(SELECT coalesce(json_agg(json_build_object('id', ch.id, 'name', ch.name)), '[]'::json) FROM characters ch WHERE ch.channel_id=cm.channel_id AND ch.user_id=b.user_id) AS characters "
             "FROM channel_members cm JOIN server_bots b ON b.user_id=cm.user_id JOIN users u ON u.id=b.user_id LEFT JOIN users iu ON iu.id=cm.invited_by "
             "WHERE cm.channel_id=$1 ORDER BY cm.joined_at", {a.channelId})) {
        Json::Value p = r;
        if (!p["characters"].isArray()) p["characters"] = Json::Value(Json::arrayValue);
        v["present"].append(p);
    }
    if (!feature) return v;
    for (const auto& r : db_.queryJson(
             "SELECT b.id, b.user_id, u.display_name AS name FROM server_bots b JOIN users u ON u.id=b.user_id "
             "WHERE b.server_id=$1 AND b.deleted_at IS NULL AND b.enabled AND NOT EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id=$2 AND cm.user_id=b.user_id) "
             "ORDER BY u.display_name", {a.serverId, a.channelId}))
        v["invitable"].append(r);
    return v;
}

Json::Value BotService::invite(const ChannelAccess& a, const std::string& botId) {
    settings_.requireFeature(a.serverId, "bots");
    auto bot = botRow(a.serverId, botId);
    if (!bot["enabled"].asBool()) throw conflict("this bot is switched off");
    const auto user = bot["user_id"].asString();
    Json::Value message;
    std::string mainId;
    db_.tx([&](pqxx::work& w) {
        // One invitation at a time per channel, so the limit holds.
        auto ch = Db::queryOne(w, "SELECT c.bot_invites_enabled, coalesce(ss.bots_per_channel, 3) AS bots_per_channel FROM channels c LEFT JOIN server_settings ss ON ss.server_id=c.server_id "
                                  "WHERE c.id=$1 FOR UPDATE OF c", {a.channelId});
        if (!a.isGm && !ch["bot_invites_enabled"].asBool()) throw forbidden("the GM has turned bot invitations off in this channel");
        if (!Db::queryOne(w, "SELECT 1 AS ok FROM channel_members WHERE channel_id=$1 AND user_id=$2", {a.channelId, user}).isNull()) throw conflict("this bot is already here");
        auto present = Db::queryOne(w, "SELECT count(*) AS n FROM channel_members cm JOIN users u ON u.id=cm.user_id WHERE cm.channel_id=$1 AND u.is_bot", {a.channelId})["n"].asInt64();
        if (present >= ch["bots_per_channel"].asInt64())
            throw conflict("this channel already has " + std::to_string(present) + " bots, the most this server allows");
        if (!a.isGm && Db::queryOne(w, "SELECT count(*) AS n FROM channel_members cm JOIN users u ON u.id=cm.user_id WHERE cm.invited_by=$1 AND u.is_bot AND cm.joined_at > now() - interval '1 hour'",
                                    {a.userId})["n"].asInt64() >= kInvitesPerHour)
            throw ApiError(429, "rate_limited", "you have invited many bots in the last hour; try again later");
        mainId = chat_.joinChannel(w, a.channelId, user, "player", a.userId);
        if (mainId.empty()) return;
        auto texts = dice_.textsForChannel(w, a.channelId);
        auto inviter = Db::queryOne(w, "SELECT display_name FROM users WHERE id=$1", {a.userId})["display_name"].asString();
        // System lines are the table's own (filed under its GM), whoever brought the bot.
        auto keeper = Db::queryOne(w, "SELECT user_id FROM channel_members WHERE channel_id=$1 AND role='gm' ORDER BY joined_at LIMIT 1", {a.channelId});
        message = chat_.postSystemMessage(w, a.channelId, mainId, keeper.isNull() ? a.userId : keeper["user_id"].asString(),
                                          texts.render("bots.invited", {{"inviter", inviter}, {"bot", bot["name"].asString()}}));
    });
    if (!mainId.empty()) notifier_.windowChanged(a.channelId, db_.queryOne("SELECT * FROM chat_windows WHERE id=$1", {mainId}));
    if (!message.isNull()) notifier_.messagePosted(message);
    notifier_.botsChanged(a.channelId);
    return channelView(a);
}

Json::Value BotService::removeFromChannel(const ChannelAccess& a, const std::string& botId) {
    auth_.requireGm(a);
    auto bot = botRow(a.serverId, botId);
    chat_.removeChannelMember(a, bot["user_id"].asString());
    Json::Value message;
    db_.tx([&](pqxx::work& w) {
        auto main = Db::queryOne(w, "SELECT id FROM chat_windows WHERE channel_id=$1 AND kind='main' ORDER BY created_at LIMIT 1", {a.channelId});
        if (main.isNull()) return;
        auto texts = dice_.textsForChannel(w, a.channelId);
        message = chat_.postSystemMessage(w, a.channelId, main["id"].asString(), a.userId, texts.render("bots.removed", {{"bot", bot["name"].asString()}}));
    });
    if (!message.isNull()) notifier_.messagePosted(message);
    notifier_.botsChanged(a.channelId);
    return channelView(a);
}

} // namespace acerciae
