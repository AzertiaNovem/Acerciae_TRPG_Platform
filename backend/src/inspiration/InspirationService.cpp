#include "InspirationService.h"
#include "../retrieval/ContextRetrievalService.h"
#include "../llm/LlmGateway.h"
#include "../knowledge/Visibility.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"

namespace acerciae {

Json::Value InspirationService::schema() {
    static Json::Value s = json::parse(R"({"type":"object","required":["draft"],"properties":{"draft":{"type":"string","minLength":1},"used_fact_ids":{"type":"array","items":{"type":"string"}},"notes":{"type":"string"}}})");
    return s;
}

Json::Value InspirationService::draft(const ChannelAccess& a, const std::string& chatWindowId, const std::string& characterIdIn, const std::string& hint, int variant) {
    std::string characterId = characterIdIn.empty() ? a.primaryCharacterId : characterIdIn;
    if (!a.isGm && !characterId.empty() && std::find(a.characterIds.begin(), a.characterIds.end(), characterId) == a.characterIds.end()) throw forbidden("not your character");
    ChannelAccess view = a; if (!a.isGm && !characterId.empty()) view.characterIds = {characterId};
    Json::Value ctx;
    ctx["character"] = characterId.empty() ? Json::Value(Json::objectValue) : db_.queryOne("SELECT id, name, speaking_style, sheet FROM characters WHERE id=$1 AND channel_id=$2", {characterId, a.channelId});
    ctx["characters"] = db_.queryJson("SELECT id, name, kind FROM characters WHERE channel_id=$1 AND kind='pc'", {a.channelId});
    auto scene = retrieval_.getCurrentScene(view, chatWindowId, 16);
    ctx["recent_messages"] = scene.isMember("log") ? scene["log"] : Json::Value(Json::arrayValue);
    scene.removeMember("log"); scene.removeMember("facts");
    ctx["scene"] = scene;
    // Facts the character knows, most recently updated first, bounded.
    std::string sql = "SELECT f.id AS fact_id, f.kind, f.summary, f.status, f.data, s.title AS scene_title FROM knowledge_facts f LEFT JOIN scenes s ON s.id=f.scene_id LEFT JOIN document_entries de ON de.fact_id=f.id AND NOT de.removed LEFT JOIN documents d ON d.id=de.document_id WHERE f.channel_id=$1 AND f.status <> 'retracted' AND " + Visibility::factFilter(view) + (a.isGm ? "" : " AND coalesce(d.gm_only,false)=false") + " ORDER BY f.updated_at DESC LIMIT 30";
    ctx["known_facts"] = db_.queryJson(sql, {a.channelId});
    ctx["hint"] = hint; ctx["variant"] = variant;

    LlmRequest req; req.task = "inspiration"; req.responseSchema = schema(); req.temperature = 0.8;
    req.system = R"(You draft ONE possible in-character response for a player who is unsure what to say next in a Call of Cthulhu / BRP game. Use only the information in known_facts, recent_messages and scene — the character's actual knowledge. Hard rules: do not invent world facts or NPC answers; do not decide whether actions succeed; do not fabricate character backstory; never use module secrets; you may propose an action, a question or a line of dialogue in the character's speaking_style. 2-4 sentences, first person, editable. Output JSON {"draft":"...","used_fact_ids":["..."],"notes":"..."})";
    req.tools = ContextRetrievalService::toolSpecs(false);
    LlmMessage u; u.role = "user"; u.content = json::dump(ctx); req.messages.push_back(u);
    auto outcome = llm_.runStructured(req, [&](const std::string& n, const Json::Value& args) { return retrieval_.executeTool(view, n, args); }, 3);
    if (!outcome.ok) throw ApiError(502, "llm_error", "inspiration failed: " + outcome.error);
    Json::Value out = outcome.data;
    std::vector<std::string> used;
    std::set<std::string> allowed; for (auto& f : ctx["known_facts"]) allowed.insert(f["fact_id"].asString());
    for (auto& id : out["used_fact_ids"]) if (id.isString() && allowed.count(id.asString())) used.push_back(id.asString());
    out["used_fact_ids"] = json::fromStrArray(used);
    auto row = db_.queryOne("INSERT INTO inspiration_drafts(channel_id, chat_window_id, user_id, character_id, hint, draft, used_fact_ids, llm_mode) VALUES($1,$2,$3,$4,$5,$6,$7::uuid[],$8) RETURNING id, created_at",
        {a.channelId, chatWindowId.empty() ? dbNull() : DbParam(chatWindowId), a.userId, characterId.empty() ? dbNull() : DbParam(characterId), hint, json::str(out, "draft"), pgArrayLiteral(used), llm_.mode()});
    out["id"] = row["id"]; out["created_at"] = row["created_at"]; out["llm_mode"] = llm_.mode(); out["character_id"] = characterId; out["editable"] = true; out["auto_sent"] = false;
    return out;
}

} // namespace acerciae
