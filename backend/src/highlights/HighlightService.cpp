#include "HighlightService.h"
#include "../ws/Notifier.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../knowledge/Visibility.h"

namespace acerciae {

Json::Value HighlightService::create(const NewHighlight& h, bool notify) {
    // Suppress duplicates: same entry + reason still active.
    auto existing = db_.queryOne("SELECT * FROM highlights WHERE target_entry_id=$1 AND reason=$2 AND NOT dismissed AND expires_at > now() AND visibility_scope=$3 AND character_id IS NOT DISTINCT FROM $4 AND user_id IS NOT DISTINCT FROM $5",
        {h.entryId, h.reason, h.visibilityScope, h.characterId.empty() ? dbNull() : DbParam(h.characterId), h.userId.empty() ? dbNull() : DbParam(h.userId)});
    if (!existing.isNull()) {
        db_.exec("UPDATE highlights SET expires_at = now() + ($2 || ' seconds')::interval WHERE id=$1", {existing["id"].asString(), std::to_string(h.ttlSeconds > 0 ? h.ttlSeconds : defaultTtl_)});
        return existing;
    }
    auto row = db_.queryOne(
        "INSERT INTO highlights(channel_id, document_id, target_entry_id, text_range, reason, kind, source_event_ids, priority, visibility_scope, character_id, user_id, expires_at) "
        "VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::uuid[],$8,$9,$10,$11, now() + ($12 || ' seconds')::interval) RETURNING *",
        {h.channelId, h.documentId, h.entryId.empty() ? dbNull() : DbParam(h.entryId), h.textRange.isNull() ? dbNull() : DbParam(json::dump(h.textRange)), h.reason, h.kind,
         pgArrayLiteral(h.sourceEventIds), (int64_t)h.priority, h.visibilityScope, h.characterId.empty() ? dbNull() : DbParam(h.characterId), h.userId.empty() ? dbNull() : DbParam(h.userId),
         std::to_string(h.ttlSeconds > 0 ? h.ttlSeconds : defaultTtl_)});
    if (notify) notifier_.highlightCreated(h.channelId, row);
    return row;
}

Json::Value HighlightService::listActive(const ChannelAccess& a, const std::string& documentId) {
    std::string sql = "SELECT h.*, d.doc_type FROM highlights h JOIN documents d ON d.id=h.document_id WHERE h.channel_id=$1 AND NOT h.dismissed AND h.expires_at > now() AND " + Visibility::highlightFilter(a);
    DbParams p{a.channelId};
    if (!documentId.empty()) { sql += " AND h.document_id=$2"; p.push_back(documentId); }
    if (!a.isGm) sql += " AND NOT d.gm_only";
    sql += " ORDER BY h.priority DESC, h.created_at DESC LIMIT 200";
    return db_.queryJson(sql, p);
}

Json::Value HighlightService::dismiss(const ChannelAccess& a, const std::string& id) {
    auto h = db_.queryOne("SELECT * FROM highlights h WHERE id=$1 AND channel_id=$2 AND " + Visibility::highlightFilter(a), {id, a.channelId});
    if (h.isNull()) throw notFound("highlight not found");
    auto out = db_.queryOne("UPDATE highlights SET dismissed=true WHERE id=$1 RETURNING *", {id});
    notifier_.highlightExpired(a.channelId, {id});
    return out;
}

std::map<std::string, std::vector<std::string>> HighlightService::cleanupExpired() {
    std::map<std::string, std::vector<std::string>> out;
    auto rows = db_.queryJson("DELETE FROM highlights WHERE expires_at <= now() OR (dismissed AND created_at < now() - interval '1 day') RETURNING id, channel_id, dismissed");
    for (auto& r : rows) if (!r["dismissed"].asBool()) out[r["channel_id"].asString()].push_back(r["id"].asString());
    return out;
}

} // namespace acerciae
