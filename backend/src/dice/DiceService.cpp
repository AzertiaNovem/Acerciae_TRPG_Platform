#include "../rules/Pbta.h"
#include "DiceService.h"
#include "../servers/ServerSettingsService.h"
#include "../ws/Notifier.h"
#include "../knowledge/Visibility.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "Dnd.h"
#include "../rules/RuleSystem.h"

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

std::string DiceService::ruleSystem(const std::string& channelId) {
    auto r = db_.queryOne("SELECT rule_system FROM channels WHERE id=$1", {channelId});
    return r.isNull() ? "coc7e" : r["rule_system"].asString();
}

namespace {
// A window's initiative order: highest total first, then the higher DEX modifier, then by name.
Json::Value orderOf(pqxx::work& w, const std::string& windowId) {
    Json::Value out;
    auto win = Db::queryOne(w, "SELECT initiative_turn, initiative_round FROM chat_windows WHERE id=$1", {windowId});
    out["round"] = win.isNull() ? 0 : win["initiative_round"].asInt();
    out["turn"] = win.isNull() ? Json::Value() : win["initiative_turn"];
    out["entries"] = Db::queryJson(w, "SELECT id, name, total, tiebreak, character_id, created_by FROM initiative_entries WHERE chat_window_id=$1 ORDER BY total DESC, tiebreak DESC, name", {windowId});
    return out;
}
std::string orderText(const Json::Value& o, const dice::TextSet& t) {
    if (o["entries"].empty()) return t.get("dnd.init.empty");
    std::vector<std::string> items;
    for (const auto& e : o["entries"])
        items.push_back(t.render("dnd.init.item", {{"mark", e["id"] == o["turn"] ? "▶ " : ""}, {"who", e["name"].asString()}, {"total", std::to_string(e["total"].asInt())}}));
    return t.render("dnd.init.list", {{"round", std::to_string(std::max(1, o["round"].asInt()))}, {"list", text::join(items, ", ")}});
}
// Moves the turn to the next entry; past the last one a new round starts. Returns the order after the move.
Json::Value advance(pqxx::work& w, const std::string& windowId) {
    auto o = orderOf(w, windowId);
    const auto& es = o["entries"];
    if (es.empty()) return o;
    Json::ArrayIndex next = 0; int round = std::max(1, o["round"].asInt());
    if (o["turn"].isString()) {
        for (Json::ArrayIndex i = 0; i < es.size(); ++i) if (es[i]["id"] == o["turn"]) { next = i + 1; break; }
        if (next >= es.size()) { next = 0; ++round; }
    }
    Db::exec(w, "UPDATE chat_windows SET initiative_turn=$2, initiative_round=$3 WHERE id=$1", {windowId, es[next]["id"].asString(), (int64_t)round});
    return orderOf(w, windowId);
}
}

DiceService::Result DiceService::execute(pqxx::work& w, const ChannelAccess& a, const std::string& windowId, const std::string& characterId, const dice::Command& cmd) {
    dice::Context ctx;
    auto texts = textsForChannel(w, a.channelId, &ctx.language);   // inside the caller's transaction: no second connection
    auto ch = Db::queryOne(w, "SELECT rule_system FROM channels WHERE id=$1 FOR SHARE", {a.channelId});
    ctx.ruleSystem = ch.isNull() ? "coc7e" : ch["rule_system"].asString();
    if (cmd.name == "move" && ctx.ruleSystem == "pbta") {
        if (characterId.empty()) throw badRequest("Choose a character for this move");
        auto pack = pbta::lockedPack(w,a.channelId);
        auto c = Db::queryOne(w,"SELECT user_id,role_card->'pbta' AS card FROM characters WHERE channel_id=$1 AND id=$2 FOR SHARE",{a.channelId,characterId});
        if (c.isNull() || (!a.isGm && c["user_id"] != a.userId)) throw forbidden("Not your character");
        Result r;
        r.dice = pbta::resolve(pack,c["card"],cmd.args,*rng_);
        r.text = r.dice["text"].asString(); r.dice["command"]=cmd.raw; r.dice["hidden"]=false;
        return r;
    }
    // .init reads and edits the window's order (D&D); it rolls nothing.
    if (cmd.name == "init") {
        if (ctx.ruleSystem != "dnd2024") throw diceError(texts.render("error.rules_dnd", {{"command", cmd.raw}}));
        Result r; r.narrative = false; r.dice["type"] = "initiative_order"; r.dice["command"] = cmd.raw;
        auto args = text::trim(cmd.args); auto low = text::lower(args);
        auto gmOnly = [&] { if (!a.isGm) throw diceError(texts.get("dnd.init.gm_only")); };
        if (low.empty() || low == "list" || low == "show") r.text = orderText(orderOf(w, windowId), texts);
        else if (low == "clr" || low == "clear") {
            gmOnly();
            Db::exec(w, "UPDATE chat_windows SET initiative_turn=NULL, initiative_round=0 WHERE id=$1", {windowId});
            Db::exec(w, "DELETE FROM initiative_entries WHERE chat_window_id=$1", {windowId});
            r.text = texts.get("dnd.init.cleared"); r.initiativeWindow = windowId;
        } else if (low == "next" || low == "n") {
            gmOnly();
            auto o = advance(w, windowId);
            if (o["entries"].empty()) r.text = texts.get("dnd.init.empty");
            else {
                std::string who; for (const auto& e : o["entries"]) if (e["id"] == o["turn"]) who = e["name"].asString();
                r.text = texts.render("dnd.init.turn", {{"round", std::to_string(o["round"].asInt())}, {"who", who}});
            }
            r.narrative = true; r.initiativeWindow = windowId;
        } else if (low.rfind("del ", 0) == 0 || low.rfind("rm ", 0) == 0) {
            auto who = text::trim(args.substr(args.find(' ') + 1));
            auto e = Db::queryOne(w, "SELECT id, created_by FROM initiative_entries WHERE chat_window_id=$1 AND lower(name)=lower($2)", {windowId, who});
            if (e.isNull()) throw diceError(texts.render("dnd.init.missing", {{"who", who}}));
            if (!a.isGm && e["created_by"].asString() != a.userId) gmOnly();
            Db::exec(w, "DELETE FROM initiative_entries WHERE id=$1", {e["id"].asString()});
            r.text = texts.render("dnd.init.removed", {{"who", who}}); r.initiativeWindow = windowId;
        } else throw diceError(texts.render("error.usage", {{"usage", ".init | .init next | .init del <name> | .init clr"}}));
        r.dice["text"] = r.text; r.dice["hidden"] = false;
        return r;
    }
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
    if (o.detail["initiative"].isObject() && !windowId.empty()) {
        // .ri joins (or re-rolls in) this window's order; a name rolled for by someone else is the GM's to add.
        const auto& in = o.detail["initiative"];
        bool own = in["own"].asBool();
        if (!own && !a.isGm && !ctx.hasCharacter) throw diceError(texts.render("error.no_character", {{"command", cmd.raw}}));
        Db::exec(w, "INSERT INTO initiative_entries(channel_id, chat_window_id, name, total, tiebreak, character_id, created_by) VALUES($1,$2,$3,$4,$5,$6,$7) "
                    "ON CONFLICT (chat_window_id, name) DO UPDATE SET total=EXCLUDED.total, tiebreak=EXCLUDED.tiebreak, character_id=EXCLUDED.character_id, created_by=EXCLUDED.created_by",
                 {a.channelId, windowId, in["name"].asString(), (int64_t)in["total"].asInt(), (int64_t)in["tiebreak"].asInt(),
                  own && !characterId.empty() ? DbParam(characterId) : dbNull(), a.userId});
        r.initiativeWindow = windowId;
        o.detail.removeMember("initiative");
    }
    r.text = o.text; r.hidden = o.hidden; r.narrative = cmd.name != "st" && cmd.name != "en";
    r.dice = o.detail; r.dice["command"] = cmd.raw; r.dice["text"] = o.text; r.dice["hidden"] = o.hidden;
    if (o.attrsChanged) r.dice["attrs_changed"] = true;
    if (o.hidden) r.hiddenNotice = texts.render("roll.hidden_notice", {{"name", ctx.name}});
    return r;
}

void DiceService::afterCommit(const ChannelAccess& a, const std::string& characterId, const Result& r) {
    if (!r.initiativeWindow.empty()) notifier_.initiativeChanged(a.channelId, r.initiativeWindow);
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
    ctx.ruleSystem = ruleSystem(a.channelId);
    auto hint = dice::preview(*cmd, ctx, texts);
    if (!hint.empty()) out["hint"] = hint;
    return out;
}

Json::Value DiceService::getAttributes(const ChannelAccess& a, const std::string& characterId) {
    auto c = characterFor(a, characterId, false);
    Json::Value v; v["character_id"] = c["id"]; v["name"] = c["name"]; v["kind"] = c["kind"];
    if (ruleSystem(a.channelId) == "pbta") {
        v["attrs"] = Json::Value(Json::objectValue);
        v["editable"] = false;
        return v;
    }
    v["attrs"] = c["sheet"]["attrs"].isObject() ? c["sheet"]["attrs"] : Json::Value(Json::objectValue);
    v["editable"] = a.isGm || (c["user_id"].isString() && c["user_id"].asString() == a.userId);
    return v;
}

Json::Value DiceService::updateAttributes(const ChannelAccess& a, const std::string& characterId, const Json::Value& body) {
    characterFor(a, characterId, true);
    if (!body["set"].isNull() && !body["set"].isObject()) throw badRequest("set must be an object of name -> number");
    if (!body["remove"].isNull() && !body["remove"].isArray()) throw badRequest("remove must be an array of names");
    db_.tx([&](pqxx::work& w) {
        // Match the channel-then-character lock order used when switching rule systems.
        auto system = Db::queryOne(w,"SELECT rule_system FROM channels WHERE id=$1 FOR SHARE",{a.channelId})["rule_system"];
        if (system=="pbta") throw badRequest("Use the PbtA character card");
        auto c = Db::queryOne(w, "SELECT sheet FROM characters WHERE id=$1 FOR UPDATE", {characterId});
        Json::Value attrs = c["sheet"]["attrs"].isObject() ? c["sheet"]["attrs"] : Json::Value(Json::objectValue);
        std::string lang; textsForChannel(w, a.channelId, &lang);
        const bool dnd = system=="dnd2024";
        auto stored = [&](const std::string& n) { return dnd ? dice::dnd::storedKey(attrs, n) : dice::storedKey(attrs, n, lang); };
        auto canon = [&](const std::string& n) { if (!dnd) return dice::canonicalName(n, lang); auto c = dice::dnd::canonical(n); return c.empty() ? text::trim(n) : c; };
        for (auto& n : json::strArray(body["remove"])) { auto k = stored(n); if (!k.empty()) attrs.removeMember(k); }
        if (body["set"].isObject()) for (auto& n : body["set"].getMemberNames()) {
            const auto& v = body["set"][n];
            if (!v.isNumeric() || v.isBool()) throw badRequest("value for " + n + " must be a number");
            auto name = canon(n);
            if (name.empty() || name.size() > 60) throw badRequest("attribute names must be 1-60 chars");
            if (v.asDouble() < -99999 || v.asDouble() > 99999) throw badRequest("value for " + n + " is out of range");
            auto k = stored(n); if (k.empty()) k = name;
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

namespace acerciae {
Json::Value DiceService::initiative(const ChannelAccess& a, const std::string& windowId) {
    auth_.requireWindowMember(a, windowId);
    return db_.tx([&](pqxx::work& w) { return orderOf(w, windowId); });
}
Json::Value DiceService::initiativeAction(const ChannelAccess& a, const std::string& windowId, const Json::Value& body) {
    auth_.requireWindowMember(a, windowId);
    auto action = json::str(body, "action");
    auto out = db_.tx([&](pqxx::work& w) {
        if (action == "remove") {
            auto id = json::str(body, "entry_id");
            if (!Visibility::isUuid(id)) throw badRequest("entry_id required");
            auto e = Db::queryOne(w, "SELECT created_by FROM initiative_entries WHERE id=$1 AND chat_window_id=$2", {id, windowId});
            if (e.isNull()) throw notFound("not in the initiative order");
            if (!a.isGm && e["created_by"].asString() != a.userId) throw forbidden("only the GM removes other entries");
            Db::exec(w, "DELETE FROM initiative_entries WHERE id=$1", {id});
            return orderOf(w, windowId);
        }
        if (!a.isGm) throw forbidden("only the GM runs the initiative order");
        if (action == "next") return advance(w, windowId);
        if (action == "clear") {
            Db::exec(w, "UPDATE chat_windows SET initiative_turn=NULL, initiative_round=0 WHERE id=$1", {windowId});
            Db::exec(w, "DELETE FROM initiative_entries WHERE chat_window_id=$1", {windowId});
            return orderOf(w, windowId);
        }
        throw badRequest("action must be next, remove or clear");
    });
    notifier_.initiativeChanged(a.channelId, windowId);
    return out;
}
} // namespace acerciae
