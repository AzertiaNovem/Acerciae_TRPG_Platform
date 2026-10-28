#include "DiceService.h"
#include "../servers/ServerSettingsService.h"
#include "../ws/Notifier.h"
#include "../knowledge/Visibility.h"
#include "../core/Errors.h"
#include "../core/Json.h"

namespace acerciae {

DiceService::DiceService(Db& db, AuthService& auth, ServerSettingsService& settings, Notifier& notifier)
    : db_(db), auth_(auth), settings_(settings), notifier_(notifier), rng_(std::make_unique<dice::RandomRng>()) {}

static ApiError diceError(const std::string& m) { return ApiError(400, "dice_error", m); }

std::optional<dice::Command> DiceService::recognise(const ChannelAccess& a, const std::string& content) {
    auto cmd = dice::parseCommand(content);
    if (!cmd || !settings_.featureEnabled(a.serverId, "dice")) return std::nullopt;
    return cmd;
}

dice::TextSet DiceService::textsForChannel(const std::string& channelId, std::string* language) {
    return db_.tx([&](pqxx::work& w) { return textsForChannel(w, channelId, language); });
}
dice::TextSet DiceService::textsForChannel(pqxx::work& w, const std::string& channelId, std::string* language) {
    auto r = Db::queryOne(w, 
        "SELECT c.dice_text_group, coalesce(ss.language, 'en') AS language, g.base, g.texts FROM channels c "
        "LEFT JOIN server_settings ss ON ss.server_id=c.server_id "
        "LEFT JOIN dice_text_groups g ON g.id::text=c.dice_text_group AND g.server_id=c.server_id WHERE c.id=$1", {channelId});
    if (r.isNull()) return dice::TextSet();
    if (language) *language = r["language"].asString();
    if (r["base"].isString()) return dice::TextSet(r["base"].asString(), r["texts"]);
    auto sel = r["dice_text_group"].asString();
    if (sel == "builtin:zh") return dice::TextSet("zh", Json::Value());
    if (sel == "builtin:en") return dice::TextSet("en", Json::Value());
    return dice::TextSet(r["language"].asString().rfind("zh", 0) == 0 ? "zh" : "en", Json::Value());
}

std::string DiceService::displayName(const std::string& userId) {
    auto u = db_.queryOne("SELECT display_name FROM users WHERE id=$1", {userId});
    return u.isNull() ? "?" : u["display_name"].asString();
}

Json::Value DiceService::characterFor(const ChannelAccess& a, const std::string& characterId, bool forWrite) {
    if (!Visibility::isUuid(characterId)) throw notFound("character not found");
    auto c = db_.queryOne("SELECT id, user_id, name, kind, sheet FROM characters WHERE id=$1 AND channel_id=$2", {characterId, a.channelId});
    if (c.isNull()) throw notFound("character not found");
    if (a.isGm) return c;
    bool mine = c["user_id"].isString() && c["user_id"].asString() == a.userId;
    if (c["kind"].asString() == "npc" || (forWrite && !mine)) throw forbidden(forWrite ? "not your character" : "character not found");
    return c;
}

DiceService::Result DiceService::execute(pqxx::work& w, const ChannelAccess& a, const std::string& characterId, const dice::Command& cmd) {
    dice::Context ctx;
    auto texts = textsForChannel(w, a.channelId, &ctx.language);   // inside the caller's transaction: no second connection
    std::string sheetKind;
    if (!characterId.empty()) {
        auto c = Db::queryOne(w, "SELECT name, kind, sheet FROM characters WHERE id=$1 AND channel_id=$2 FOR UPDATE", {characterId, a.channelId});
        if (c.isNull()) throw badRequest("character not in this channel");
        ctx.name = c["name"].asString(); ctx.hasCharacter = true; sheetKind = c["kind"].asString();
        ctx.attrs = c["sheet"]["attrs"].isObject() ? c["sheet"]["attrs"] : Json::Value(Json::objectValue);
    } else { auto u = Db::queryOne(w, "SELECT display_name FROM users WHERE id=$1", {a.userId}); ctx.name = u.isNull() ? "?" : u["display_name"].asString(); }

    dice::Outcome o;
    try { o = dice::execute(cmd, ctx, texts, *rng_); }
    catch (const dice::DiceError& e) { throw diceError(e.what()); }

    if (o.attrsChanged)
        Db::exec(w, "UPDATE characters SET sheet = jsonb_set(sheet, '{attrs}', $3::jsonb, true) WHERE id=$1 AND channel_id=$2", {characterId, a.channelId, json::dump(o.attrs)});

    Result r;
    r.text = o.text; r.hidden = o.hidden; r.narrative = cmd.name != "st" && cmd.name != "en";
    r.dice = o.detail; r.dice["command"] = cmd.raw; r.dice["text"] = o.text; r.dice["hidden"] = o.hidden;
    if (o.attrsChanged) r.dice["attrs_changed"] = true;
    if (o.hidden) r.hiddenNotice = texts.render("roll.hidden_notice", {{"name", ctx.name}});
    return r;
}

void DiceService::afterCommit(const ChannelAccess& a, const std::string& characterId, const Result& r) {
    if (characterId.empty() || !r.dice.isMember("attrs_changed")) return;
    auto c = db_.queryOne("SELECT id, name, kind, user_id, sheet FROM characters WHERE id=$1", {characterId});
    if (!c.isNull()) notifier_.characterUpdated(a.channelId, c);
}

Json::Value DiceService::preview(const ChannelAccess& a, const std::string& windowId, const std::string& characterIdIn, const std::string& content) {
    Json::Value out; out["hint"] = Json::Value(); out["command"] = Json::Value();
    auto cmd = recognise(a, content);
    if (!cmd) return out;
    out["command"] = cmd->raw;
    std::string characterId = characterIdIn;
    if (characterId.empty() && !windowId.empty()) { auth_.requireWindowMember(a, windowId); if (auto wc = auth_.windowCharacter(a.userId, windowId)) characterId = *wc; }
    dice::Context ctx;
    if (!characterId.empty()) {
        auto c = characterFor(a, characterId, true);
        ctx.name = c["name"].asString(); ctx.hasCharacter = true;
        ctx.attrs = c["sheet"]["attrs"].isObject() ? c["sheet"]["attrs"] : Json::Value(Json::objectValue);
    } else ctx.name = displayName(a.userId);
    auto texts = textsForChannel(a.channelId, &ctx.language);
    auto hint = dice::preview(*cmd, ctx, texts);
    if (!hint.empty()) out["hint"] = hint;
    return out;
}

Json::Value DiceService::getAttributes(const ChannelAccess& a, const std::string& characterId) {
    auto c = characterFor(a, characterId, false);
    Json::Value v; v["character_id"] = c["id"]; v["name"] = c["name"]; v["kind"] = c["kind"];
    v["attrs"] = c["sheet"]["attrs"].isObject() ? c["sheet"]["attrs"] : Json::Value(Json::objectValue);
    v["editable"] = a.isGm || (c["user_id"].isString() && c["user_id"].asString() == a.userId);
    return v;
}

Json::Value DiceService::updateAttributes(const ChannelAccess& a, const std::string& characterId, const Json::Value& body) {
    characterFor(a, characterId, true);
    if (!body["set"].isNull() && !body["set"].isObject()) throw badRequest("set must be an object of name -> number");
    if (!body["remove"].isNull() && !body["remove"].isArray()) throw badRequest("remove must be an array of names");
    db_.tx([&](pqxx::work& w) {
        auto c = Db::queryOne(w, "SELECT sheet FROM characters WHERE id=$1 FOR UPDATE", {characterId});
        Json::Value attrs = c["sheet"]["attrs"].isObject() ? c["sheet"]["attrs"] : Json::Value(Json::objectValue);
        std::string lang; textsForChannel(w, a.channelId, &lang);
        for (auto& n : json::strArray(body["remove"])) { auto k = dice::storedKey(attrs, n, lang); if (!k.empty()) attrs.removeMember(k); }
        if (body["set"].isObject()) for (auto& n : body["set"].getMemberNames()) {
            const auto& v = body["set"][n];
            if (!v.isNumeric() || v.isBool()) throw badRequest("value for " + n + " must be a number");
            auto name = dice::canonicalName(n, lang);
            if (name.empty() || name.size() > 60) throw badRequest("attribute names must be 1-60 chars");
            if (v.asDouble() < -99999 || v.asDouble() > 99999) throw badRequest("value for " + n + " is out of range");
            auto k = dice::storedKey(attrs, n, lang); if (k.empty()) k = name;
            attrs[k] = v.asInt();
        }
        if (attrs.size() > 300) throw badRequest("at most 300 attributes per character");
        Db::exec(w, "UPDATE characters SET sheet = jsonb_set(sheet, '{attrs}', $2::jsonb, true) WHERE id=$1", {characterId, json::dump(attrs)});
    });
    auto c = db_.queryOne("SELECT id, name, kind, user_id, sheet FROM characters WHERE id=$1", {characterId});
    notifier_.characterUpdated(a.channelId, c);
    return getAttributes(a, characterId);
}

} // namespace acerciae
