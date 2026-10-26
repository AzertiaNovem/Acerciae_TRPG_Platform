#include "ContextRetrievalService.h"
#include "../knowledge/KnowledgeService.h"
#include "../knowledge/Visibility.h"
#include "../events/EventStore.h"
#include "../llm/LlmGateway.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../core/Log.h"
#include <map>
#include <algorithm>

namespace acerciae {

static const std::string FACT_COLS =
    "f.id AS fact_id, f.kind, f.summary, f.status, f.data, f.scene_id, f.source_event_ids, f.updated_at, s.title AS scene_title, "
    "de.id AS entry_id, d.doc_type AS document_type ";
static const std::string FACT_FROM =
    "FROM knowledge_facts f LEFT JOIN scenes s ON s.id=f.scene_id LEFT JOIN document_entries de ON de.fact_id=f.id AND NOT de.removed LEFT JOIN documents d ON d.id=de.document_id ";

Json::Value ContextRetrievalService::getCurrentScene(const ChannelAccess& a, const std::string& chatWindowId, int logLimit) {
    std::string sceneId;
    if (!chatWindowId.empty()) { auto w = db_.queryOne("SELECT active_scene_id FROM chat_windows WHERE id=$1 AND channel_id=$2", {chatWindowId, a.channelId}); if (!w.isNull() && !w["active_scene_id"].isNull()) sceneId = w["active_scene_id"].asString(); }
    if (sceneId.empty()) { auto c = db_.queryOne("SELECT current_scene_id FROM channels WHERE id=$1", {a.channelId}); if (!c.isNull() && !c["current_scene_id"].isNull()) sceneId = c["current_scene_id"].asString(); }
    if (sceneId.empty()) { Json::Value v; v["error"] = "no active scene"; return v; }
    return getSceneById(a, sceneId, logLimit);
}
Json::Value ContextRetrievalService::getSceneById(const ChannelAccess& a, const std::string& sceneId, int logLimit) {
    auto s = db_.queryOne("SELECT id, title, location, narrative_time, status, summary, off_module, sequence FROM scenes WHERE id=$1 AND channel_id=$2", {sceneId, a.channelId});
    if (s.isNull()) throw notFound("scene not found");
    s["participants"] = db_.queryJson(
        "SELECT DISTINCT c.id AS character_id, c.name, c.kind FROM chat_window_scenes ws JOIN chat_window_members wm ON wm.chat_window_id=ws.chat_window_id JOIN characters c ON c.id=wm.character_id WHERE ws.scene_id=$1", {sceneId});
    s["log"] = db_.queryJson(
        "SELECT * FROM (SELECT e.id AS event_id, e.seq, e.actor_role, e.character_id, c.name AS character_name, e.kind, e.payload->>'content' AS content, e.created_at FROM events e LEFT JOIN characters c ON c.id=e.character_id "
        "WHERE e.channel_id=$1 AND e.scene_id=$2 AND " + Visibility::eventFilter(a) + " ORDER BY e.seq DESC LIMIT $3) x ORDER BY seq ASC", {a.channelId, sceneId, (int64_t)std::max(1, logLimit)});
    s["facts"] = db_.queryJson("SELECT " + FACT_COLS + FACT_FROM + "WHERE f.channel_id=$1 AND f.scene_id=$2 AND f.status <> 'retracted' AND " + Visibility::factFilter(a) + (a.isGm ? "" : " AND coalesce(d.gm_only,false)=false") + " ORDER BY f.updated_at DESC LIMIT 60", {a.channelId, sceneId});
    return s;
}
Json::Value ContextRetrievalService::searchSceneHistory(const ChannelAccess& a, const std::string& query, const std::string& sceneId, const std::string& excludeSceneId, int limit) {
    Json::Value out; out["query"] = query;
    if (text::trim(query).empty()) { out["facts"] = Json::Value(Json::arrayValue); out["events"] = Json::Value(Json::arrayValue); return out; }
    std::string sql = "SELECT " + FACT_COLS + ", ts_rank(f.search, plainto_tsquery('english', $2)) AS rank " + FACT_FROM +
        "WHERE f.channel_id=$1 AND f.status <> 'retracted' AND " + Visibility::factFilter(a) + (a.isGm ? "" : " AND coalesce(d.gm_only,false)=false") +
        " AND (f.search @@ plainto_tsquery('english', $2) OR f.summary ILIKE '%' || $2 || '%' OR f.data::text ILIKE '%' || $2 || '%')";
    DbParams p{a.channelId, query};
    if (!sceneId.empty()) { p.push_back(sceneId); sql += " AND f.scene_id=$" + std::to_string(p.size()); }
    if (!excludeSceneId.empty()) { p.push_back(excludeSceneId); sql += " AND (f.scene_id IS NULL OR f.scene_id <> $" + std::to_string(p.size()) + ")"; }
    sql += " ORDER BY rank DESC, f.updated_at DESC LIMIT " + std::to_string(std::max(1, std::min(limit, 50)));
    out["facts"] = db_.queryJson(sql, p);
    out["events"] = events_.search(a, query, sceneId, std::min(limit, 20));
    if (out["facts"].empty() && embeddingsEnabled()) out["semantic"] = semanticSearch(a, query, 10);
    return out;
}
Json::Value ContextRetrievalService::searchEvents(const ChannelAccess& a, const std::string& query, const std::string& sceneId, int limit) {
    Json::Value out; out["query"] = query; out["events"] = events_.search(a, query, sceneId, std::max(1, std::min(limit, 50))); return out;
}
Json::Value ContextRetrievalService::getEntity(const ChannelAccess& a, const std::string& idOrName) {
    if (Visibility::isUuid(idOrName)) return knowledge_.getEntity(a, idOrName);
    auto e = db_.tx([&](pqxx::work& w) { return knowledge_.findEntity(w, a.channelId, idOrName); });
    if (e.isNull()) { auto list = knowledge_.listEntities(a, idOrName); if (list.empty()) { Json::Value v; v["error"] = "entity not found"; v["candidates"] = Json::Value(Json::arrayValue); return v; } e = list[0]; }
    return knowledge_.getEntity(a, e["id"].asString());
}
Json::Value ContextRetrievalService::getRelationships(const ChannelAccess& a, const std::string& idOrName) {
    auto e = getEntity(a, idOrName);
    Json::Value out; out["entity"] = e.isMember("name") ? e["name"] : Json::Value(idOrName); out["relations"] = e.isMember("relations") ? e["relations"] : Json::Value(Json::arrayValue); return out;
}
Json::Value ContextRetrievalService::getClue(const ChannelAccess& a, const std::string& idOrQuery) {
    if (Visibility::isUuid(idOrQuery)) { Json::Value o; o["clue"] = knowledge_.getFact(a, idOrQuery); return o; }
    Json::Value o; o["clues"] = knowledge_.listFacts(a, "clue", idOrQuery, "", 20); return o;
}
Json::Value ContextRetrievalService::getOpenThreads(const ChannelAccess& a) {
    Json::Value o; o["threads"] = db_.queryJson("SELECT " + FACT_COLS + FACT_FROM + "WHERE f.channel_id=$1 AND f.kind='thread' AND f.status NOT IN ('resolved','retracted') AND " + Visibility::factFilter(a) + " ORDER BY f.updated_at DESC LIMIT 40", {a.channelId}); return o;
}
Json::Value ContextRetrievalService::getModuleExcerpt(const ChannelAccess& a, const std::string& query, const std::string& nodeId) {
    if (!a.isGm) throw forbidden("module content is GM-only");
    Json::Value o;
    if (!nodeId.empty()) {
        o["node"] = db_.queryOne("SELECT n.*, (SELECT json_agg(json_build_object('relation', e.relation, 'to', t.name, 'to_id', t.id)) FROM module_edges e JOIN module_nodes t ON t.id=e.to_node_id WHERE e.from_node_id=n.id) AS out_edges FROM module_nodes n WHERE n.id=$1 AND n.channel_id=$2", {nodeId, a.channelId});
        return o;
    }
    o["nodes"] = db_.queryJson("SELECT id, node_type, name, description, citations, progress FROM module_nodes WHERE channel_id=$1 AND (search @@ plainto_tsquery('english', $2) OR name ILIKE '%' || $2 || '%') ORDER BY ts_rank(search, plainto_tsquery('english', $2)) DESC LIMIT 15", {a.channelId, query});
    o["pages"] = db_.queryJson("SELECT p.module_id, p.page_number, ts_headline('english', p.text, plainto_tsquery('english', $2), 'MaxWords=60, MinWords=20') AS excerpt FROM module_pages p JOIN modules m ON m.id=p.module_id WHERE m.channel_id=$1 AND p.search @@ plainto_tsquery('english', $2) LIMIT 5", {a.channelId, query});
    return o;
}
Json::Value ContextRetrievalService::getKnowledgeScope(const ChannelAccess& a, const std::string& characterId) {
    Json::Value o; o["character_id"] = characterId; o["facts"] = knowledge_.knowledgeScope(a, characterId); return o;
}
Json::Value ContextRetrievalService::getShard(const ChannelAccess& a, const std::string& shardId) {
    auto p = shardId.find('/');
    if (p == std::string::npos) throw badRequest("shard id must be <kind>/<id>");
    auto kind = shardId.substr(0, p), id = shardId.substr(p + 1);
    if (kind == "scene") return getSceneById(a, id, 100);
    if (kind == "entity") return getEntity(a, id);
    if (kind == "module") return getModuleExcerpt(a, "", id);
    if (kind == "knowledge") return getKnowledgeScope(a, id);
    if (kind == "relationship" || kind == "clue" || kind == "thread" || kind == "timeline") return knowledge_.getFact(a, id);
    throw badRequest("unknown shard kind: " + kind);
}
bool ContextRetrievalService::embeddingsEnabled() {
    if (vectorState_ < 0) {
        auto r = db_.queryOne("SELECT 1 AS ok FROM information_schema.tables WHERE table_name='fact_embeddings'");
        vectorState_ = (!r.isNull() && llm_.status()["embeddings"].asBool()) ? 1 : 0;
    }
    return vectorState_ == 1;
}
static std::string vecLiteral(const std::vector<float>& v) { std::string s = "["; for (size_t i = 0; i < v.size(); ++i) { if (i) s += ","; s += std::to_string(v[i]); } return s + "]"; }
void ContextRetrievalService::indexEmbedding(const std::string& factId, const std::string& textual) {
    if (!embeddingsEnabled()) return;
    auto v = llm_.embed(textual);
    if (v.size() != 1536) return;
    try { db_.exec("INSERT INTO fact_embeddings(fact_id, model, embedding) VALUES($1,$2,$3::vector) ON CONFLICT (fact_id) DO UPDATE SET embedding=EXCLUDED.embedding, model=EXCLUDED.model", {factId, llm_.modelName(), vecLiteral(v)}); }
    catch (const std::exception& e) { ALOG_WARN << "embedding index failed: " << e.what(); }
}
Json::Value ContextRetrievalService::semanticSearch(const ChannelAccess& a, const std::string& query, int limit) {
    if (!embeddingsEnabled()) return Json::Value(Json::arrayValue);
    auto v = llm_.embed(query);
    if (v.size() != 1536) return Json::Value(Json::arrayValue);
    return db_.queryJson("SELECT " + FACT_COLS + ", (fe.embedding <=> $2::vector) AS distance " + FACT_FROM + "JOIN fact_embeddings fe ON fe.fact_id=f.id WHERE f.channel_id=$1 AND f.status <> 'retracted' AND " + Visibility::factFilter(a) + " ORDER BY fe.embedding <=> $2::vector LIMIT " + std::to_string(std::max(1, std::min(limit, 30))), {a.channelId, vecLiteral(v)});
}

Json::Value ContextRetrievalService::relatedHistory(const ChannelAccess& a, const std::vector<std::string>& terms, const std::string& excludeSceneId, int limit) {
    // Every term pulls a few candidates; facts matched by several terms rank first.
    std::map<std::string, Json::Value> byId; std::vector<std::string> order;
    for (auto& t : terms) {
        if (t.size() < 4) continue;
        auto res = searchSceneHistory(a, t, "", excludeSceneId, 4);
        for (auto& f : res["facts"]) {
            // Module-progress and scene-state facts are derivative; real history lives in clues, relationships, threads, timeline.
            auto kind = json::str(f, "kind");
            if (kind == "module_progress" || kind == "scene_state") continue;
            auto id = f["fact_id"].asString();
            if (!byId.count(id)) { Json::Value h = f; h["matched_terms"] = Json::Value(Json::arrayValue); byId[id] = h; order.push_back(id); }
            byId[id]["matched_terms"].append(t);
        }
    }
    std::stable_sort(order.begin(), order.end(), [&](const std::string& x, const std::string& y) { return byId[x]["matched_terms"].size() > byId[y]["matched_terms"].size(); });
    Json::Value out(Json::arrayValue);
    for (auto& id : order) { out.append(byId[id]); if ((int)out.size() >= limit) break; }
    return out;
}
Json::Value ContextRetrievalService::documentSnapshot(const ChannelAccess& a, const std::string& docType, const std::string& sceneId, int limit) {
    Json::Value out;
    auto d = db_.queryOne("SELECT id, version, gm_only FROM documents WHERE channel_id=$1 AND doc_type=$2", {a.channelId, docType});
    if (d.isNull()) { out["version"] = 0; out["entries"] = Json::Value(Json::arrayValue); return out; }
    if (d["gm_only"].asBool() && !a.isGm) { out["version"] = d["version"]; out["entries"] = Json::Value(Json::arrayValue); return out; }
    std::string sql = "SELECT f.id AS fact_id, de.id AS entry_id, f.summary, f.status, f.data, f.scene_id, f.source_event_ids, s.title AS scene_title FROM document_entries de JOIN knowledge_facts f ON f.id=de.fact_id LEFT JOIN scenes s ON s.id=f.scene_id WHERE de.document_id=$1 AND NOT de.removed AND " + Visibility::factFilter(a);
    DbParams p{d["id"].asString()};
    if (!sceneId.empty() && docType == "current_scene") { p.push_back(sceneId); sql += " AND f.scene_id=$2"; }
    sql += " ORDER BY de.updated_version DESC, de.position DESC LIMIT " + std::to_string(std::max(1, limit));
    out["document_id"] = d["id"]; out["version"] = d["version"]; out["entries"] = db_.queryJson(sql, p);
    return out;
}

Json::Value ContextRetrievalService::executeTool(const ChannelAccess& a, const std::string& name, const Json::Value& args) {
    int limit = json::toInt(args, "limit", 10);
    if (name == "get_current_scene") return getCurrentScene(a, json::str(args, "chat_window_id"), json::toInt(args, "log_limit", 40));
    if (name == "get_scene_by_id") return getSceneById(a, json::requireStr(args, "scene_id"), json::toInt(args, "log_limit", 80));
    if (name == "search_scene_history") return searchSceneHistory(a, json::str(args, "query"), json::str(args, "scene_id"), json::str(args, "exclude_scene_id"), limit);
    if (name == "search_events") return searchEvents(a, json::requireStr(args, "query"), json::str(args, "scene_id"), limit);
    if (name == "get_entity") return getEntity(a, json::requireStr(args, "entity"));
    if (name == "get_relationships") return getRelationships(a, json::requireStr(args, "entity"));
    if (name == "get_clue") return getClue(a, json::requireStr(args, "clue"));
    if (name == "get_open_threads") return getOpenThreads(a);
    if (name == "get_module_excerpt") return getModuleExcerpt(a, json::str(args, "query"), json::str(args, "node_id"));
    if (name == "get_knowledge_scope") return getKnowledgeScope(a, json::requireStr(args, "character_id"));
    if (name == "get_shard") return getShard(a, json::requireStr(args, "shard_id"));
    Json::Value err; err["error"] = "unknown tool: " + name; return err;
}

static LlmToolSpec tool(const std::string& name, const std::string& desc, std::initializer_list<std::pair<const char*, const char*>> params, std::initializer_list<const char*> required = {}) {
    LlmToolSpec t; t.name = name; t.description = desc; t.parameters["type"] = "object"; t.parameters["properties"] = Json::Value(Json::objectValue);
    for (auto& [k, d] : params) { Json::Value p; p["type"] = std::string(k) == "limit" || std::string(k) == "log_limit" ? "integer" : "string"; p["description"] = d; t.parameters["properties"][k] = p; }
    t.parameters["required"] = Json::Value(Json::arrayValue); for (auto r : required) t.parameters["required"].append(r);
    return t;
}
std::vector<LlmToolSpec> ContextRetrievalService::toolSpecs(bool gm) {
    std::vector<LlmToolSpec> v = {
        tool("get_current_scene", "Full accessible log and facts of the current scene.", {{"chat_window_id", "optional window id"}, {"log_limit", "max events"}}),
        tool("get_scene_by_id", "Log and facts of a specific past scene.", {{"scene_id", "scene id"}, {"log_limit", "max events"}}, {"scene_id"}),
        tool("search_scene_history", "Full-text search over recorded facts (clues, relationships, threads, timeline) across scenes. Use to check whether something was mentioned before.", {{"query", "keywords"}, {"scene_id", "restrict to scene"}, {"exclude_scene_id", "exclude a scene"}, {"limit", "max results"}}, {"query"}),
        tool("search_events", "Full-text search over raw chat events.", {{"query", "keywords"}, {"scene_id", "restrict to scene"}, {"limit", "max results"}}, {"query"}),
        tool("get_entity", "Details, facts and relations of an NPC, location, item or organisation by name or id.", {{"entity", "name or id"}}, {"entity"}),
        tool("get_relationships", "Relations of an entity.", {{"entity", "name or id"}}, {"entity"}),
        tool("get_clue", "A clue by id, or search clues by keywords.", {{"clue", "id or query"}}, {"clue"}),
        tool("get_open_threads", "Unresolved threads, questions, promises and deadlines.", {}),
        tool("get_knowledge_scope", "Facts a specific character knows.", {{"character_id", "character id"}}, {"character_id"}),
        tool("get_shard", "Fetch a memory shard by id (scene/<id>, entity/<id>, clue/<id>, relationship/<id>, thread/<id>, timeline/<id>, module/<id>, knowledge/<character id>).", {{"shard_id", "shard id"}}, {"shard_id"}),
    };
    if (gm) v.push_back(tool("get_module_excerpt", "GM-only: search the imported module's nodes and pages.", {{"query", "keywords"}, {"node_id", "module node id"}}));
    return v;
}

} // namespace acerciae
