#include "Recall.h"
#include "../documents/DocumentService.h"
#include "../ws/Notifier.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include <map>
#include <set>

namespace acerciae::recall {

std::vector<std::string> gone(Db& db, const std::string& channelId, const std::vector<std::string>& eventIds) {
    std::vector<std::string> out;
    if (eventIds.empty()) return out;
    for (const auto& r : db.queryJson("SELECT s::text AS id FROM unnest($2::uuid[]) s WHERE NOT EXISTS(SELECT 1 FROM events e WHERE e.id=s AND e.channel_id=$1)",
                                      {channelId, pgArrayLiteral(eventIds)}))
        out.push_back(r["id"].asString());
    return out;
}

void forget(Db& db, DocumentService& docs, Notifier& notifier, const std::string& channelId, const std::vector<std::string>& eventIds) {
    if (eventIds.empty()) return;
    const auto ids = pgArrayLiteral(eventIds);
    std::vector<std::string> highlights;
    std::set<std::string> reminderGroups;   // "" = the Keeper's
    db.tx([&](pqxx::work& w) {
        for (const auto& h : Db::queryJson(w, "UPDATE highlights SET dismissed=true WHERE channel_id=$1 AND NOT dismissed AND source_event_ids && $2::uuid[] RETURNING id", {channelId, ids}))
            highlights.push_back(h["id"].asString());
        // A reminder quotes chat verbatim: one that cites a recalled line would keep repeating it.
        auto cites = Db::queryJson(w,
            "SELECT * FROM reminders r WHERE r.channel_id=$1 AND r.status IN ('active','deferred') AND (r.source_event_ids && $2::uuid[] "
            "OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.citations || r.review_citations) c WHERE c->>'event_id' = ANY($2::text[]))) FOR UPDATE", {channelId, ids});
        for (const auto& before : cites) {
            auto after = Db::queryOne(w, "UPDATE reminders SET status='dismissed', status_reason='A chat line it cites was recalled.', version=version+1, updated_at=now() WHERE id=$1 RETURNING *", {before["id"].asString()});
            Db::exec(w, "INSERT INTO reminder_revisions(reminder_id,version,action,before_state,after_state,citations) VALUES($1,$2,'dismissed',$3::jsonb,$4::jsonb,'[]'::jsonb)",
                {after["id"].asString(), (int64_t)after["version"].asInt(), json::dump(before), json::dump(after)});
            reminderGroups.insert(json::str(after, "player_group_id"));
        }
    });
    if (!highlights.empty()) notifier.highlightExpired(channelId, highlights);
    for (const auto& g : reminderGroups) notifier.remindersChanged(channelId, g);

    // Keeper journal entries that rest only on lines that are gone (these, or others recalled before) are retracted
    // through the documents' own revision path, one commit per document.
    std::map<std::string, Json::Value> byDocument;
    for (const auto& r : db.queryJson(
             "SELECT de.document_id, de.fact_id FROM document_entries de JOIN documents d ON d.id=de.document_id JOIN knowledge_facts f ON f.id=de.fact_id "
             "WHERE d.channel_id=$1 AND d.player_group_id IS NULL AND NOT de.removed AND f.status<>'retracted' AND f.source_event_ids && $2::uuid[] "
             "AND NOT EXISTS(SELECT 1 FROM unnest(f.source_event_ids) s JOIN events e ON e.id=s)", {channelId, ids})) {
        Json::Value op; op["op"] = "remove_entry"; op["fact_id"] = r["fact_id"];
        auto& ops = byDocument[r["document_id"].asString()];
        if (ops.isNull()) ops = Json::Value(Json::arrayValue);
        ops.append(op);
    }
    for (const auto& [documentId, ops] : byDocument) {
        Proposal p; p.channelId = channelId; p.documentId = documentId; p.ops = ops; p.actor = "system";
        p.summary = "Removed: the chat line it came from was recalled";
        try { docs.commit(p); }
        catch (const std::exception& e) { ALOG_WARN << "recall: journal entries in " << documentId << " not retracted: " << e.what(); }
    }
}

} // namespace acerciae::recall
