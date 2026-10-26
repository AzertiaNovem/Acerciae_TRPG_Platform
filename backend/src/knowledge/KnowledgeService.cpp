#include "KnowledgeService.h"
#include "Visibility.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include <algorithm>

namespace acerciae {

bool KnowledgeScope::narrowerThan(const KnowledgeScope& o) const {
    if (scope == "gm") return true;
    if (o.scope == "gm") return false;
    if (o.scope == "public") return true;
    if (scope == "public") return false;
    for (auto& c : characterIds) if (std::find(o.characterIds.begin(), o.characterIds.end(), c) == o.characterIds.end()) return false;
    return true;
}
KnowledgeScope KnowledgeScope::intersect(const KnowledgeScope& o) const {
    if (scope == "gm" || o.scope == "gm") return KnowledgeScope{"gm", {}};
    if (scope == "public") return o;
    if (o.scope == "public") return *this;
    KnowledgeScope r; r.scope = "character";
    for (auto& c : characterIds) if (std::find(o.characterIds.begin(), o.characterIds.end(), c) != o.characterIds.end()) r.characterIds.push_back(c);
    if (r.characterIds.empty()) r.scope = "gm";
    return r;
}
Json::Value KnowledgeScope::toJson() const {
    Json::Value v; v["scope"] = scope; v["character_ids"] = json::fromStrArray(characterIds); return v;
}
KnowledgeScope KnowledgeScope::fromJson(const Json::Value& v) {
    KnowledgeScope s; s.scope = json::str(v, "scope", "gm"); s.characterIds = json::strArray(v["character_ids"]);
    if (s.scope != "gm" && s.scope != "public" && s.scope != "character") throw badRequest("invalid scope");
    if (s.scope == "character" && s.characterIds.empty()) s.scope = "gm";
    return s;
}

KnowledgeScope KnowledgeService::deriveScope(pqxx::work& w, const std::string& channelId, const std::string& knowledgeMode, const std::vector<std::string>& ids) {
    if (ids.empty()) return KnowledgeScope{"gm", {}};
    auto rows = Db::queryJson(w, "SELECT visibility, audience FROM events WHERE channel_id=$1 AND id = ANY(" + Visibility::uuidArray(ids) + ")", {channelId});
    if ((int)rows.size() != (int)ids.size()) throw badRequest("proposal cites events outside this channel");
    bool first = true; KnowledgeScope acc;
    for (auto& r : rows) {
        auto vis = r["visibility"].asString();
        KnowledgeScope s;
        if (vis == "gm_only") s.scope = "gm";
        else if (vis == "public") s.scope = "public";
        else if (vis == "whisper") { s.scope = "character"; s.characterIds = json::strArray(r["audience"]); if (s.characterIds.empty()) s.scope = "gm"; }
        else { // 'window'
            if (knowledgeMode == "public") s.scope = "public";
            else { s.scope = "character"; s.characterIds = json::strArray(r["audience"]); if (s.characterIds.empty()) s.scope = "gm"; }
        }
        acc = first ? s : acc.intersect(s); first = false;
    }
    return acc;
}

void KnowledgeService::setScope(pqxx::work& w, const std::string& factId, const KnowledgeScope& s, const std::string& source) {
    Db::exec(w, "DELETE FROM knowledge_visibility WHERE fact_id=$1", {factId});
    if (s.scope == "gm") { Db::exec(w, "INSERT INTO knowledge_visibility(fact_id, scope, source) VALUES($1,'gm',$2)", {factId, source}); return; }
    if (s.scope == "public") { Db::exec(w, "INSERT INTO knowledge_visibility(fact_id, scope, source) VALUES($1,'public',$2)", {factId, source}); return; }
    for (auto& c : s.characterIds)
        Db::exec(w, "INSERT INTO knowledge_visibility(fact_id, scope, character_id, source) VALUES($1,'character',$2,$3) ON CONFLICT DO NOTHING", {factId, c, source});
}
KnowledgeScope KnowledgeService::getScope(pqxx::work& w, const std::string& factId) {
    KnowledgeScope s; s.scope = "gm";
    for (auto& r : Db::queryJson(w, "SELECT scope, character_id FROM knowledge_visibility WHERE fact_id=$1", {factId})) {
        auto sc = r["scope"].asString();
        if (sc == "public") { s.scope = "public"; s.characterIds.clear(); return s; }
        if (sc == "character") { s.scope = "character"; s.characterIds.push_back(r["character_id"].asString()); }
    }
    return s;
}
Json::Value KnowledgeService::getScopeJson(const ChannelAccess& a, const std::string& factId) {
    return db_.tx([&](pqxx::work& w) {
        auto f = Db::queryOne(w, "SELECT id FROM knowledge_facts f WHERE id=$1 AND channel_id=$2 AND " + Visibility::factFilter(a), {factId, a.channelId});
        if (f.isNull()) throw notFound("fact not found");
        Json::Value s; s["scope"]=a.isGm?"gm":"player_group"; s["player_group_id"]=a.playerGroupId; s["character_ids"]=Json::Value(Json::arrayValue);
        s["fact_id"] = factId;
        return s;
    });
}
Json::Value KnowledgeService::gmSetScope(const ChannelAccess& a, const std::string& factId, const KnowledgeScope& s) {
    if (!a.isGm) throw forbidden("GM role required");
    throw conflict("KP memory cannot be shared directly. Reveal information in chat; each player group summarizes its own chat.");
}

std::string KnowledgeService::upsertEntity(pqxx::work& w, const std::string& channelId, const std::string& kind, const std::string& nameIn, const std::string& description, const std::string& groupId) {
    auto name = text::trim(nameIn);
    if (name.empty()) throw badRequest("entity name required");
    auto found = findEntity(w, channelId, name, groupId);
    if (!found.isNull()) {
        if (!description.empty() && found["description"].asString().empty())
            Db::exec(w, "UPDATE entities SET description=$2, updated_at=now() WHERE id=$1", {found["id"].asString(), description});
        return found["id"].asString();
    }
    static const std::set<std::string> kinds = {"pc","npc","location","item","organisation","concept"};
    auto k = kinds.count(kind) ? kind : "concept";
    auto r = Db::queryOne(w, "INSERT INTO entities(channel_id, kind, name, description, player_group_id) VALUES($1,$2,$3,$4,$5::uuid) ON CONFLICT " +
        std::string(groupId.empty() ? "(channel_id, kind, name) WHERE player_group_id IS NULL" : "(player_group_id, kind, name) WHERE player_group_id IS NOT NULL") +
        " DO UPDATE SET updated_at=now() RETURNING id",
        {channelId, k, name, description, groupId.empty() ? dbNull() : DbParam(groupId)});
    return r["id"].asString();
}
Json::Value KnowledgeService::findEntity(pqxx::work& w, const std::string& channelId, const std::string& name, const std::string& groupId) {
    return Db::queryOne(w,
        "SELECT * FROM entities WHERE channel_id=$1 AND player_group_id IS NOT DISTINCT FROM $3::uuid AND (lower(name)=lower($2) OR lower($2) = ANY(SELECT lower(x) FROM unnest(aliases) x)) ORDER BY created_at LIMIT 1",
        {channelId, name, groupId.empty() ? dbNull() : DbParam(groupId)});
}
void KnowledgeService::linkFactEntity(pqxx::work& w, const std::string& factId, const std::string& entityId, const std::string& role) {
    Db::exec(w, "INSERT INTO fact_entities(fact_id, entity_id, role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", {factId, entityId, role.empty() ? "mentioned" : role});
}
std::string KnowledgeService::addRelation(pqxx::work& w, const std::string& channelId, const std::string& from, const std::string& to, const std::string& relation, const std::string& factId) {
    auto existing = Db::queryOne(w, "SELECT id FROM entity_relations WHERE channel_id=$1 AND from_entity_id=$2 AND to_entity_id=$3 AND relation=$4 AND fact_id IS NOT DISTINCT FROM $5",
        {channelId, from, to, relation, factId.empty() ? dbNull() : DbParam(factId)});
    if (!existing.isNull()) return existing["id"].asString();
    auto r = Db::queryOne(w, "INSERT INTO entity_relations(channel_id, from_entity_id, to_entity_id, relation, fact_id) VALUES($1,$2,$3,$4,$5) RETURNING id",
        {channelId, from, to, relation, factId.empty() ? dbNull() : DbParam(factId)});
    return r["id"].asString();
}

static const std::string FACT_SELECT =
    "SELECT f.id, f.kind, f.summary, f.data, f.status, f.scene_id, f.source_event_ids, f.created_by, f.version, f.created_at, f.updated_at, "
    "CASE WHEN f.player_group_id IS NULL THEN s.title ELSE NULL END AS scene_title, "
    "(SELECT json_agg(json_build_object('id', e.id, 'name', e.name, 'kind', e.kind, 'role', fe.role)) FROM fact_entities fe JOIN entities e ON e.id=fe.entity_id WHERE fe.fact_id=f.id) AS entities, "
    "(SELECT json_agg(json_build_object('scope', kv.scope, 'character_id', kv.character_id)) FROM knowledge_visibility kv WHERE kv.fact_id=f.id) AS visibility "
    "FROM knowledge_facts f LEFT JOIN scenes s ON s.id=f.scene_id ";

Json::Value KnowledgeService::listFacts(const ChannelAccess& a, const std::string& kind, const std::string& query, const std::string& sceneId, int limit) {
    std::string sql = FACT_SELECT + "WHERE f.channel_id=$1 AND f.status <> 'retracted' AND " + Visibility::factFilter(a);
    DbParams p{a.channelId};
    if (!kind.empty()) { p.push_back(kind); sql += " AND f.kind=$" + std::to_string(p.size()); }
    if (!sceneId.empty()) { p.push_back(sceneId); sql += " AND f.scene_id=$" + std::to_string(p.size()); }
    if (!query.empty()) {
        p.push_back(query);
        auto n = std::to_string(p.size());
        sql += " AND (f.search @@ plainto_tsquery('english', $" + n + ") OR f.summary ILIKE '%' || $" + n + " || '%' OR f.data::text ILIKE '%' || $" + n + " || '%')";
        sql += " ORDER BY ts_rank(f.search, plainto_tsquery('english', $" + n + ")) DESC, f.updated_at DESC";
    } else sql += " ORDER BY f.updated_at DESC";
    sql += " LIMIT " + std::to_string(std::max(1, std::min(limit, 200)));
    return db_.queryJson(sql, p);
}
Json::Value KnowledgeService::getFact(const ChannelAccess& a, const std::string& factId) {
    auto f = db_.queryOne(FACT_SELECT + "WHERE f.id=$1 AND f.channel_id=$2 AND " + Visibility::factFilter(a), {factId, a.channelId});
    if (f.isNull()) throw notFound("fact not found");
    return f;
}
Json::Value KnowledgeService::listEntities(const ChannelAccess& a, const std::string& query) {
    std::string sql = "SELECT e.*, (SELECT count(*) FROM fact_entities fe JOIN knowledge_facts f ON f.id=fe.fact_id WHERE fe.entity_id=e.id AND " + Visibility::factFilter(a) + ") AS fact_count FROM entities e WHERE e.channel_id=$1 AND " + Visibility::partitionFilter(a,"e");
    DbParams p{a.channelId};
    if (!query.empty()) { p.push_back(query); sql += " AND (e.name ILIKE '%' || $2 || '%' OR similarity(e.name, $2) > 0.3)"; }
    if (!a.isGm) sql = "SELECT * FROM (" + sql + ") x WHERE fact_count > 0";
    sql += " ORDER BY kind, name";
    return db_.queryJson(sql, p);
}
Json::Value KnowledgeService::getEntity(const ChannelAccess& a, const std::string& entityId) {
    auto e = db_.queryOne("SELECT e.* FROM entities e WHERE e.id=$1 AND e.channel_id=$2 AND " + Visibility::partitionFilter(a,"e"), {entityId, a.channelId});
    if (e.isNull()) throw notFound("entity not found");
    e["facts"] = db_.queryJson(FACT_SELECT + "JOIN fact_entities fe ON fe.fact_id=f.id WHERE fe.entity_id=$1 AND f.status <> 'retracted' AND " + Visibility::factFilter(a) + " ORDER BY f.updated_at DESC LIMIT 50", {entityId});
    if (!a.isGm && e["facts"].empty()) throw notFound("entity not found");
    e["relations"] = relationsOf(a, entityId);
    return e;
}
Json::Value KnowledgeService::relationsOf(const ChannelAccess& a, const std::string& entityId) {
    return db_.queryJson(
        "SELECT r.id, r.relation, r.fact_id, r.created_at, ef.id AS from_id, ef.name AS from_name, ef.kind AS from_kind, et.id AS to_id, et.name AS to_name, et.kind AS to_kind, f.summary, f.status "
        "FROM entity_relations r JOIN entities ef ON ef.id=r.from_entity_id JOIN entities et ON et.id=r.to_entity_id LEFT JOIN knowledge_facts f ON f.id=r.fact_id "
        "WHERE r.channel_id=$1 AND (r.from_entity_id=$2 OR r.to_entity_id=$2) AND " + Visibility::partitionFilter(a,"ef") + " AND " + Visibility::partitionFilter(a,"et") + " AND (" + std::string(a.isGm ? "r.fact_id IS NULL OR " : "") + Visibility::factFilter(a) + ") ORDER BY r.created_at DESC",
        {a.channelId, entityId});
}
Json::Value KnowledgeService::knowledgeScope(const ChannelAccess& a, const std::string& characterId) {
    if (!a.isGm && std::find(a.characterIds.begin(), a.characterIds.end(), characterId) == a.characterIds.end()) throw forbidden("not your character");
    return listFacts(a, "", "", "", 200);
}
Json::Value KnowledgeService::channelMode(const std::string& channelId) {
    return db_.queryOne("SELECT knowledge_mode, current_scene_id, ai_enabled FROM channels WHERE id=$1", {channelId});
}

} // namespace acerciae
