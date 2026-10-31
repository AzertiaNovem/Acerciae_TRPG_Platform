#include "GrowthService.h"
#include "../chat/ChatService.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../core/Text.h"
#include "../dice/DiceService.h"
#include "../ws/Notifier.h"
#include <set>

namespace acerciae {
namespace {
// Characteristics and the two skills the rulebook keeps out of experience checks.
bool checkable(const std::string& canonical) {
    static const std::set<std::string> never = {"STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "Luck", "SAN", "HP", "MP", "MOV", "D100", "Cthulhu Mythos", "Credit Rating"};
    return !canonical.empty() && !never.count(canonical);
}
// Carries an improvement into the role card so the next save keeps it: the skill's total, and its growth points
// when the card tracks them.
void applyToCard(Json::Value& card, const std::string& canonical, int newValue, int gain) {
    if (!card.isObject()) return;
    if (!card["skills"].isObject()) card["skills"] = Json::Value(Json::objectValue);
    std::string key = canonical;
    for (auto& k : card["skills"].getMemberNames()) if (dice::canonicalName(k) == canonical) { key = k; break; }
    card["skills"][key] = newValue;
    if (card["skill_points"].isObject()) for (auto& k : card["skill_points"].getMemberNames()) if (dice::canonicalName(k) == canonical) {
        auto& e = card["skill_points"][k]; e["growth"] = (e["growth"].isNumeric() ? e["growth"].asInt() : 0) + gain; break;
    }
}
}

void GrowthService::runForClosedScene(const std::string& channelId, const std::string& sceneId, const std::string& actorUserId) {
    if (sceneId.empty() || actorUserId.empty()) return;
    try {
        Json::Value message; std::vector<Json::Value> changed;
        db_.tx([&](pqxx::work& w) {
            auto ch = Db::queryOne(w, "SELECT rule_system FROM channels WHERE id=$1", {channelId});
            if (ch.isNull() || ch["rule_system"].asString().rfind("coc7", 0) != 0) return;
            auto scene = Db::queryOne(w, "SELECT title FROM scenes WHERE id=$1 AND channel_id=$2", {sceneId, channelId});
            if (scene.isNull()) return;
            // Marked skills: successful checks by player characters in the scenario, once per character and skill.
            auto ticks = Db::queryJson(w,
                "SELECT m.character_id, m.dice->>'attr' AS attr, min(m.created_at) AS first FROM messages m JOIN characters c ON c.id=m.character_id "
                "WHERE m.channel_id=$1 AND m.scene_id=$2 AND c.kind='pc' AND m.dice->>'type'='check' "
                "AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.dice->'rolls') r WHERE (r->>'success')::boolean) "
                "GROUP BY 1, 2 ORDER BY 3", {channelId, sceneId});
            if (ticks.empty()) return;
            std::string lang; auto texts = dice_.textsForChannel(w, channelId, &lang);
            std::map<std::string, std::vector<std::string>> byCharacter; std::vector<std::string> order;
            for (auto& t : ticks) { auto id = t["character_id"].asString(); if (!byCharacter.count(id)) order.push_back(id); byCharacter[id].push_back(t["attr"].asString()); }
            std::vector<std::string> lines{texts.render("growth.header", {{"scene", scene["title"].asString()}})};
            for (auto& id : order) {
                auto c = Db::queryOne(w, "SELECT id, name, kind, user_id, sheet, role_card FROM characters WHERE id=$1 AND channel_id=$2 FOR UPDATE", {id, channelId});
                if (c.isNull()) continue;
                dice::Context ctx; ctx.name = c["name"].asString(); ctx.hasCharacter = true; ctx.language = lang;
                ctx.attrs = c["sheet"]["attrs"].isObject() ? c["sheet"]["attrs"] : Json::Value(Json::objectValue);
                Json::Value card = c["role_card"];
                std::set<std::string> done; bool any = false;
                for (auto& attr : byCharacter[id]) {
                    auto canonical = dice::canonicalName(attr, lang);
                    if (!checkable(canonical) || !done.insert(canonical).second) continue;
                    auto cmd = dice::parseCommand(".en " + attr);
                    if (!cmd) continue;
                    try {
                        auto o = dice::execute(*cmd, ctx, texts, dice_.rng());
                        lines.push_back(o.text);
                        if (o.attrsChanged) {
                            ctx.attrs = o.attrs; any = true;
                            if (o.detail["success"].asBool()) applyToCard(card, dice::canonicalName(o.detail["attr"].asString(), lang), o.detail["value"].asInt() + o.detail["gain"].asInt(), o.detail["gain"].asInt());
                        }
                    } catch (const dice::DiceError&) { /* nothing on the sheet to improve (a check against a typed value) */ }
                }
                if (any) {
                    Db::exec(w, "UPDATE characters SET sheet = jsonb_set(sheet, '{attrs}', $2::jsonb, true), role_card=$3::jsonb WHERE id=$1", {id, json::dump(ctx.attrs), json::dump(card)});
                    changed.push_back(Db::queryOne(w, "SELECT id, name, kind, user_id, sheet FROM characters WHERE id=$1", {id}));
                }
            }
            if (lines.size() < 2) return;
            auto main = Db::queryOne(w, "SELECT id FROM chat_windows WHERE channel_id=$1 AND kind='main' ORDER BY created_at LIMIT 1", {channelId});
            if (main.isNull()) return;
            message = chat_.postSystemMessage(w, channelId, main["id"].asString(), actorUserId, text::join(lines, "\n"));
        });
        if (!message.isNull()) notifier_.messagePosted(message);
        for (auto& c : changed) notifier_.characterUpdated(channelId, c);
    } catch (const std::exception& e) {
        ALOG_WARN << "growth check for scenario " << sceneId << ": " << e.what();
    }
}

} // namespace acerciae
