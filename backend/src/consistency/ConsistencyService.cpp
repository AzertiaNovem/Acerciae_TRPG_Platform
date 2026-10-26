#include "ConsistencyService.h"
#include "../retrieval/ContextRetrievalService.h"
#include "../llm/LlmGateway.h"
#include "../highlights/HighlightService.h"
#include "../knowledge/KnowledgeService.h"
#include "../knowledge/Visibility.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include <set>

namespace acerciae {

Json::Value ConsistencyService::schema() {
    static Json::Value s = json::parse(R"({"type":"object","required":["insufficient_evidence","rationale","conflicts"],"properties":{
        "score":{"type":["integer","null"],"minimum":0,"maximum":100},"insufficient_evidence":{"type":"boolean"},"rationale":{"type":"string"},
        "conflicts":{"type":"array","items":{"type":"object","required":["description"],"properties":{"description":{"type":"string"},"severity":{"type":"string"},"evidence_fact_ids":{"type":"array","items":{"type":"string"}},"quote":{"type":"string"}}}},
        "supporting_fact_ids":{"type":"array","items":{"type":"string"}},"recommended_fact_ids":{"type":"array","items":{"type":"string"}}}})");
    return s;
}

// Rule layer: facts the viewer may know that share keywords with the draft (FTS + trigram), plus the
// character's full knowledge for items/relationships so the possession rules have what they need.
Json::Value ConsistencyService::gatherEvidence(Db& db, const ChannelAccess& a, const std::string& characterId, const std::string& draft, int limit) {
    ChannelAccess view = a;
    if (!a.isGm) { view.characterIds = {characterId}; view.primaryCharacterId = characterId; }
    std::string terms; for (auto& k : text::keywords(draft, 4)) { if (!terms.empty()) terms += " "; terms += k; }
    std::string sql = "SELECT f.id AS fact_id, f.kind, f.summary, f.status, f.data, f.scene_id, f.source_event_ids, s.title AS scene_title, de.id AS entry_id, d.doc_type AS document_type, d.id AS document_id, "
        "ts_rank(f.search, plainto_tsquery('english', $2)) AS rank FROM knowledge_facts f LEFT JOIN scenes s ON s.id=f.scene_id LEFT JOIN document_entries de ON de.fact_id=f.id AND NOT de.removed LEFT JOIN documents d ON d.id=de.document_id "
        "WHERE f.channel_id=$1 AND f.status <> 'retracted' AND " + Visibility::factFilter(view, "f") + (a.isGm ? "" : " AND coalesce(d.gm_only,false)=false") +
        " AND (f.search @@ to_tsquery('english', $3) OR f.summary % $2 OR f.kind IN ('clue','relationship')) ORDER BY rank DESC, f.updated_at DESC LIMIT " + std::to_string(limit);
    std::string orQuery; for (auto& k : text::keywords(draft, 4)) { if (!orQuery.empty()) orQuery += " | "; orQuery += k; }
    if (orQuery.empty()) orQuery = "zzzzzz";
    // to_tsquery can reject odd tokens; fall back to plain search on failure.
    try { return db.queryJson(sql, {a.channelId, terms.empty() ? draft : terms, orQuery}); }
    catch (...) { return db.queryJson(sql, {a.channelId, terms.empty() ? draft : terms, std::string("zzzzzz")}); }
}

Json::Value ConsistencyService::check(const ChannelAccess& a, const std::string& chatWindowId, const std::string& characterIdIn, const std::string& draftIn) {
    auto draft = text::trim(draftIn);
    if (draft.empty()) throw badRequest("draft text required");
    if (draft.size() > 4000) throw badRequest("draft too long");
    std::string characterId = characterIdIn;
    if (characterId.empty()) characterId = a.primaryCharacterId;
    if (!a.isGm && !characterId.empty() && std::find(a.characterIds.begin(), a.characterIds.end(), characterId) == a.characterIds.end()) throw forbidden("not your character");
    ChannelAccess view = a; if (!a.isGm && !characterId.empty()) view.characterIds = {characterId};

    Json::Value ctx; ctx["draft"] = draft;
    ctx["character"] = characterId.empty() ? Json::Value(Json::objectValue) : db_.queryOne("SELECT id, name, speaking_style FROM characters WHERE id=$1 AND channel_id=$2", {characterId, a.channelId});
    auto ch = db_.queryOne("SELECT rule_system, knowledge_mode FROM channels WHERE id=$1", {a.channelId});
    ctx["rule_system"] = ch["rule_system"];
    Json::Value scene = retrieval_.getCurrentScene(view, chatWindowId, 20);
    ctx["recent_messages"] = scene.isMember("log") ? scene["log"] : Json::Value(Json::arrayValue);
    scene.removeMember("log"); scene.removeMember("facts");
    ctx["scene"] = scene;
    ctx["known_facts"] = gatherEvidence(db_, a, characterId, draft, 40);
    ctx["rule_hints"] = "BRP/CoC: players declare intent; the Keeper adjudicates success. Characters only know what they witnessed or were told.";

    LlmRequest req; req.channelId = a.channelId; req.task = "consistency"; req.responseSchema = schema(); req.temperature = 0.1;
    req.system = R"(You check a player's DRAFT message against ONLY the records their character may access (known_facts, recent_messages, scene). Judge: established facts, what the character actually knows, current time/place, relationships and promises, actions already taken, GM-stated world rules, BRP/CoC conventions, and references to things the character could not know. Never reveal or hint at information outside known_facts. Cite fact_ids as evidence. The score is a heuristic 0-100 consistency estimate, not a probability. If nothing in the records relates to the draft, set insufficient_evidence=true and score=null instead of guessing. Do not rewrite the draft. Output JSON: {"score":int|null,"insufficient_evidence":bool,"rationale":"...","conflicts":[{"description":"...","severity":"low|medium|high","evidence_fact_ids":["..."],"quote":"..."}],"supporting_fact_ids":[...],"recommended_fact_ids":[...]})";
    req.tools = ContextRetrievalService::toolSpecs(false);
    LlmMessage u; u.role = "user"; u.content = json::dump(ctx); req.messages.push_back(u);
    auto outcome = llm_.runStructured(req, [&](const std::string& n, const Json::Value& args) { return retrieval_.executeTool(view, n, args); }, 3);
    Json::Value result;
    if (!outcome.ok) { result["insufficient_evidence"] = true; result["score"] = Json::Value(); result["rationale"] = "The consistency model did not return a usable answer (" + outcome.error + "). Evidence listed below is from rule-based retrieval only."; result["conflicts"] = Json::Value(Json::arrayValue); }
    else result = outcome.data;

    // Post-validate: only cite facts the viewer may actually see (defence against leaks), attach evidence locations.
    std::set<std::string> allowed; std::map<std::string, Json::Value> byId;
    for (auto& f : ctx["known_facts"]) { allowed.insert(f["fact_id"].asString()); byId[f["fact_id"].asString()] = f; }
    auto filterIds = [&](Json::Value& arr) { Json::Value out(Json::arrayValue); if (arr.isArray()) for (auto& x : arr) if (x.isString() && allowed.count(x.asString())) out.append(x); arr = out; };
    for (auto& c : result["conflicts"]) filterIds(c["evidence_fact_ids"]);
    filterIds(result["supporting_fact_ids"]); filterIds(result["recommended_fact_ids"]);
    Json::Value evidence(Json::arrayValue); std::vector<std::string> recEntries; std::set<std::string> seen;
    auto addEvidence = [&](const std::string& id, const std::string& role) {
        if (!seen.insert(id).second) return; auto f = byId[id];
        Json::Value e; e["fact_id"] = id; e["entry_id"] = f["entry_id"]; e["document_id"] = f["document_id"]; e["document_type"] = f["document_type"]; e["summary"] = f["summary"]; e["status"] = f["status"]; e["scene_title"] = f["scene_title"]; e["source_event_ids"] = f["source_event_ids"]; e["role"] = role;
        evidence.append(e); if (f["entry_id"].isString()) recEntries.push_back(f["entry_id"].asString());
    };
    for (auto& c : result["conflicts"]) for (auto& id : c["evidence_fact_ids"]) addEvidence(id.asString(), "conflict");
    for (auto& id : result["supporting_fact_ids"]) addEvidence(id.asString(), "support");
    for (auto& id : result["recommended_fact_ids"]) addEvidence(id.asString(), "recommended");
    result["evidence"] = evidence;
    bool insufficient = json::toBool(result, "insufficient_evidence");
    if (insufficient) result["score"] = Json::Value();
    result["score_label"] = insufficient ? "Insufficient Evidence" : (std::to_string(result["score"].asInt()) + "%");
    result["llm_mode"] = llm_.mode(a.channelId);
    result["character_id"] = characterId;
    // Persist and create user-scoped temporary highlights on the cited entries.
    auto row = db_.queryOne(
        "INSERT INTO consistency_checks(channel_id, chat_window_id, user_id, character_id, draft, score, insufficient_evidence, rationale, conflicts, evidence, recommended_entry_ids, llm_mode) "
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::uuid[],$12) RETURNING id, created_at",
        {a.channelId, chatWindowId.empty() ? dbNull() : DbParam(chatWindowId), a.userId, characterId.empty() ? dbNull() : DbParam(characterId), draft,
         result["score"].isNull() ? dbNull() : DbParam((int64_t)result["score"].asInt()), insufficient, json::str(result, "rationale"), json::dump(result["conflicts"]), json::dump(evidence), pgArrayLiteral(recEntries), llm_.mode(a.channelId)});
    result["id"] = row["id"]; result["created_at"] = row["created_at"];
    Json::Value hls(Json::arrayValue);
    for (auto& e : evidence) {
        if (!e["entry_id"].isString()) continue;
        NewHighlight h; h.channelId = a.channelId; h.documentId = e["document_id"].asString(); h.entryId = e["entry_id"].asString();
        h.kind = "consistency"; h.visibilityScope = "user"; h.userId = a.userId; h.ttlSeconds = 300; h.priority = e["role"].asString() == "conflict" ? 3 : 1;
        h.reason = (e["role"].asString() == "conflict" ? "Consistency check: possible contradiction with this record." : "Consistency check: supporting evidence.");
        h.sourceEventIds = json::strArray(e["source_event_ids"]);
        hls.append(highlights_.create(h));
    }
    result["highlights"] = hls;
    return result;
}

Json::Value ConsistencyService::history(const ChannelAccess& a, int limit) {
    return db_.queryJson("SELECT id, chat_window_id, character_id, draft, score, insufficient_evidence, rationale, conflicts, evidence, llm_mode, created_at FROM consistency_checks WHERE channel_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3", {a.channelId, a.userId, (int64_t)std::max(1, std::min(limit, 50))});
}

} // namespace acerciae
