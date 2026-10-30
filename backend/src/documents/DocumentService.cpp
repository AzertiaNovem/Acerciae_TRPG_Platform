#include "NarrativeMemoryPolicy.h"
#include "DocumentService.h"
#include "../ws/Notifier.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../core/Log.h"
#include "../knowledge/Visibility.h"
#include <algorithm>
#include <set>

namespace acerciae {

const std::vector<std::string>& DocumentService::coreDocTypes() {
    static const std::vector<std::string> t = {"current_scene","clue_journal","relationships","open_threads","timeline","module_progress"};
    return t;
}
std::string DocumentService::titleFor(const std::string& t) {
    if (t == "current_scene") return "Current Scene";
    if (t == "clue_journal") return "Clue Journal";
    if (t == "relationships") return "Relationship Journal";
    if (t == "open_threads") return "Open Threads";
    if (t == "timeline") return "Timeline";
    if (t == "module_progress") return "Module Progress";
    return t;
}
static std::string kindForDoc(const std::string& t) {
    if (t == "current_scene") return "scene_state";
    if (t == "clue_journal") return "clue";
    if (t == "relationships") return "relationship";
    if (t == "open_threads") return "thread";
    if (t == "timeline") return "timeline";
    if (t == "module_progress") return "module_progress";
    return "note";
}
static const std::set<std::string>& validStatuses() {
    static const std::set<std::string> s = {"attempted","confirmed","npc_claim","hypothesis","ai_inferred","gm_secret","retracted","resolved","pending_review"};
    return s;
}

void DocumentService::ensureCoreDocuments(pqxx::work& w, const std::string& channelId) {
    for (auto& t : coreDocTypes())
        Db::exec(w, "INSERT INTO documents(channel_id, doc_type, title, gm_only) VALUES($1,$2,$3,$4) ON CONFLICT (channel_id, doc_type) WHERE player_group_id IS NULL DO NOTHING",
            {channelId, t, titleFor(t), true});
}
std::string DocumentService::documentIdFor(pqxx::work& w, const std::string& channelId, const std::string& docType) {
    auto r = Db::queryOne(w, "SELECT id FROM documents WHERE channel_id=$1 AND doc_type=$2 AND player_group_id IS NULL", {channelId, docType});
    if (r.isNull()) { ensureCoreDocuments(w, channelId); r = Db::queryOne(w, "SELECT id FROM documents WHERE channel_id=$1 AND doc_type=$2 AND player_group_id IS NULL", {channelId, docType}); }
    if (r.isNull()) throw notFound("unknown document type: " + docType);
    return r["id"].asString();
}

std::string DocumentService::renderEntry(const std::string& kind, const Json::Value& f) {
    auto summary = json::str(f, "summary");
    auto status = json::str(f, "status", "confirmed");
    const auto& d = f["data"];
    std::string md;
    auto tag = [&](const std::string& s) { return std::string(" _(") + s + ")_"; };
    if (kind == "clue") {
        md = "**" + json::str(d, "title", text::truncate(summary, 60)) + "** — " + summary;
        std::string meta = "status: " + status;
        if (!json::str(d, "source").empty()) meta += "; source: " + json::str(d, "source");
        if (!json::str(d, "discovered_by").empty()) meta += "; found by: " + json::str(d, "discovered_by");
        md += tag(meta);
    } else if (kind == "relationship") {
        md = "**" + json::str(d, "from", "?") + " → " + json::str(d, "to", "?") + "** (" + json::str(d, "relation", "relation") + "): " + summary + tag("status: " + status);
    } else if (kind == "thread") {
        md = "- [" + std::string(status == "resolved" ? "x" : " ") + "] **" + json::str(d, "title", text::truncate(summary, 60)) + "** — " + summary + tag(json::str(d, "thread_kind", "question"));
    } else if (kind == "timeline") {
        md = "**" + json::str(d, "when", "unspecified time") + "** — " + summary + tag("status: " + status);
    } else if (kind == "scene_state") {
        auto facet = json::str(d, "facet", "event");
        md = "**[" + facet + "]** " + summary + tag("status: " + status);
    } else if (kind == "module_progress") {
        md = "**" + json::str(d, "node_name", "module node") + "** (" + json::str(d, "node_type", "") + "): " + summary + tag("progress: " + json::str(d, "progress", status));
    } else md = summary + tag("status: " + status);
    return md;
}

struct DocumentService::OpContext {
    std::string channelId, documentId, docType, factKind, knowledgeMode, actor, actorUserId;
    ChannelAccess access;
    std::vector<std::string> allowedSources;
    int newVersion = 0;
    std::vector<std::string> defaultSources;
    std::string proposalId, aiJobId;
};

static std::vector<std::string> mergeSources(const Json::Value& op, const std::vector<std::string>& defaults) {
    auto own = json::strArray(op["source_event_ids"]);
    if (own.empty() && op.isMember("fact")) own = json::strArray(op["fact"]["source_event_ids"]);
    if (own.empty()) return defaults;
    return own;
}

void DocumentService::linkEntities(pqxx::work& w, const std::string& channelId, const std::string& factId, const Json::Value& entities, const std::string&) {
    if (!entities.isArray()) return;
    auto group = Db::queryOne(w,"SELECT player_group_id FROM knowledge_facts WHERE id=$1",{factId});
    auto groupId = json::str(group,"player_group_id");
    for (auto& e : entities) {
        auto name = json::str(e, "name"); if (name.empty()) continue;
        auto id = knowledge_.upsertEntity(w, channelId, json::str(e, "kind", "concept"), name, json::str(e, "description"), groupId);
        knowledge_.linkFactEntity(w, factId, id, json::str(e, "role", "mentioned"));
    }
}

void DocumentService::indexFact(pqxx::work& w, const std::string& channelId, const std::string& factId, const std::string& kind, const Json::Value& f) {
    auto group = Db::queryOne(w,"SELECT player_group_id FROM knowledge_facts WHERE id=$1",{factId});
    auto groupId = json::str(group,"player_group_id");
    const auto& d = f["data"];
    auto status = json::str(f, "status");
    if (kind == "clue") {
        Db::exec(w, "INSERT INTO clues(fact_id, channel_id, title, discovered_scene, confirmed) VALUES($1,$2,$3,$4,$5) "
                    "ON CONFLICT (fact_id) DO UPDATE SET title=EXCLUDED.title, confirmed=EXCLUDED.confirmed",
            {factId, channelId, json::str(d, "title", text::truncate(json::str(f, "summary"), 80)),
             json::str(f, "scene_id").empty() ? dbNull() : DbParam(json::str(f, "scene_id")), status == "confirmed"});
    } else if (kind == "thread") {
        auto tk = json::str(d, "thread_kind", "question");
        static const std::set<std::string> kinds = {"question","foreshadowing","promise","agreement","deadline"};
        if (!kinds.count(tk)) tk = "question";
        Db::exec(w, "INSERT INTO narrative_threads(fact_id, channel_id, title, thread_kind, resolved) VALUES($1,$2,$3,$4,$5) "
                    "ON CONFLICT (fact_id) DO UPDATE SET title=EXCLUDED.title, thread_kind=EXCLUDED.thread_kind, resolved=EXCLUDED.resolved",
            {factId, channelId, json::str(d, "title", text::truncate(json::str(f, "summary"), 80)), tk, status == "resolved"});
    } else if (kind == "relationship") {
        auto from = json::str(d, "from"), to = json::str(d, "to"), rel = json::str(d, "relation", "related");
        if (!from.empty() && !to.empty()) {
            auto fe = knowledge_.upsertEntity(w, channelId, json::str(d, "from_kind", "npc"), from, "", groupId);
            auto te = knowledge_.upsertEntity(w, channelId, json::str(d, "to_kind", "npc"), to, "", groupId);
            knowledge_.linkFactEntity(w, factId, fe, "from"); knowledge_.linkFactEntity(w, factId, te, "to");
            knowledge_.addRelation(w, channelId, fe, te, rel, factId);
        }
    }
}

void DocumentService::applyOp(pqxx::work& w, OpContext& ctx, const Json::Value& op, CommitResult& res) {
    auto type = json::str(op, "op");
    Json::Value log; log["op"] = type;
    auto reject = [&](const std::string& why) { log["decision"] = "rejected"; log["reason"] = why; res.rejected++; res.log.append(log); };
    auto pending = [&](const std::string& why, const Json::Value& payload) {
        if (!ctx.access.isGm) { reject(why); return; }
        // Contradiction with a confirmed record: never silently overwrite. Store for GM review.
        Json::Value ops(Json::arrayValue); ops.append(payload);
        auto pr = Db::queryOne(w, "INSERT INTO document_proposals(channel_id, document_id, ai_job_id, expected_version, ops, source_event_ids, evidence, status, rejection_reason) "
                                  "VALUES($1,$2,$3,$4,$5::jsonb,$6::uuid[],'[]'::jsonb,'needs_gm_review',$7) RETURNING id",
            {ctx.channelId, ctx.documentId, ctx.aiJobId.empty() ? dbNull() : DbParam(ctx.aiJobId), (int64_t)ctx.newVersion - 1, json::dump(ops), pgArrayLiteral(mergeSources(op, ctx.defaultSources)), why});
        log["decision"] = "needs_gm_review"; log["reason"] = why; log["proposal_id"] = pr["id"];
        res.pendingReview++; res.log.append(log);
    };
    const bool isAi = ctx.actor == "ai";
    // The Keeper's chronicler: every op, removals and links included, cites lines of the batch it was given.
    if (ctx.access.isGm && isAi && !ctx.allowedSources.empty()) {
        const auto sources = mergeSources(op, ctx.defaultSources);
        if (sources.empty()) return reject("AI changes must cite the chat lines they come from");
        for (const auto& id : sources)
            if (std::find(ctx.allowedSources.begin(), ctx.allowedSources.end(), id) == ctx.allowedSources.end()) return reject("Source is outside the batch the AI was given");
    }
    if (!ctx.access.isGm) {
        const auto sources = mergeSources(op,ctx.defaultSources);
        if (sources.empty()) return reject("Player memory requires chat evidence");
        for (const auto& id : sources) {
            if (!Visibility::isUuid(id) || std::find(ctx.allowedSources.begin(),ctx.allowedSources.end(),id)==ctx.allowedSources.end())
                return reject("Source is outside the authorized chat batch");
        }
        auto rows=Db::queryJson(w,"SELECT e.id FROM events e WHERE e.channel_id=$1 AND e.id=ANY("+Visibility::uuidArray(sources)+") AND "+Visibility::eventFilter(ctx.access),{ctx.channelId});
        std::set<std::string> unique(sources.begin(),sources.end());
        if (rows.size()!=unique.size()) return reject("Source is not readable by this player group");
        if (ctx.docType=="module_progress" || json::str(op,"status")=="gm_secret" || json::str(op["fact"],"status")=="gm_secret") return reject("KP-only content");
        // References in free-form data must resolve inside the same memory partition.
        auto checkData=[&](const Json::Value& data) {
            for (const auto& key : {"related_fact_ids","note_for_fact_id"}) {
                auto refs=data[key]; if(refs.isString()) { Json::Value arr(Json::arrayValue); arr.append(refs); refs=arr; }
                if(!refs.isArray()) continue;
                for(const auto& id : refs) {
                    if(!id.isString() || !Visibility::isUuid(id.asString())) return false;
                    if(Db::queryOne(w,"SELECT f.id FROM knowledge_facts f WHERE f.id=$1 AND "+Visibility::factFilter(ctx.access),{id.asString()}).isNull()) return false;
                }
            }
            return !data.isMember("node_id") && !data.isMember("module_node_id");
        };
        if(!checkData(op["data"]) || !checkData(op["fact"]["data"])) return reject("Cross-partition reference");
    }


    // Do not let an AI manufacture a story entry from only a placeholder or an unexplained raw roll.
    // Existing action entries can give a raw roll its missing context; allow the model to judge updates.
    // Other messages (including semantically irrelevant debugging prose) remain a model editorial decision.
    if (isAi && (type == "add_entry" || type == "update_entry" || type == "set_status" || type == "append_text")) {
        const auto sources = mergeSources(op, ctx.defaultSources);
        if (!sources.empty()) {
            for (const auto& id : sources) if (!Visibility::isUuid(id)) return reject("invalid source event id");
            auto evidence = Db::queryJson(w, "SELECT kind,payload FROM events WHERE channel_id=$1 AND id=ANY(" + Visibility::uuidArray(sources) + ")", {ctx.channelId});
            if (!evidence.empty() && std::all_of(evidence.begin(), evidence.end(), type == "add_entry" ? narrative_memory::obviousNonNarrative : narrative_memory::placeholderOnly))
                return reject("No narrative evidence: only placeholders or unexplained raw rolls");
        }
    }

    if (type == "add_entry") {
        Json::Value fact = op["fact"];
        if (!fact.isObject()) return reject("add_entry requires fact");
        auto summary = text::trim(json::str(fact, "summary"));
        if (summary.size() < 3) return reject("fact summary too short");
        auto sources = mergeSources(op, ctx.defaultSources);
        if (isAi && sources.empty()) return reject("AI facts require at least one source event");
        for (auto& s : sources) if (!Visibility::isUuid(s)) return reject("invalid source event id");
        auto status = json::str(fact, "status", "confirmed");
        if (!validStatuses().count(status)) status = "ai_inferred";
        // AI may only mark something confirmed when a GM-authored or system event backs it.
        if (isAi && status == "confirmed" && !sources.empty()) {
            auto gm = Db::queryOne(w, "SELECT count(*) AS n FROM events WHERE channel_id=$1 AND id = ANY(" + Visibility::uuidArray(sources) + ") AND actor_role IN ('gm','system')", {ctx.channelId});
            if (gm.isNull() || gm["n"].asInt() == 0) { status = "attempted"; log["note"] = "downgraded to attempted: no GM confirmation among sources"; }
        }
        // Deduplicate: same kind + near-identical summary already in this document → update instead.
        auto dup = Db::queryOne(w, "SELECT f.id FROM knowledge_facts f JOIN document_entries de ON de.fact_id=f.id WHERE de.document_id=$1 AND f.kind=$2 AND lower(f.summary)=lower($3) AND NOT de.removed LIMIT 1",
            {ctx.documentId, ctx.factKind, summary});
        if (!dup.isNull()) {
            Json::Value upd; upd["op"] = "update_entry"; upd["fact_id"] = dup["id"]; upd["source_event_ids"] = json::fromStrArray(sources);
            if (fact.isMember("data")) upd["data"] = fact["data"];
            upd["status"] = status;
            log["note"] = "merged into existing entry"; 
            return applyOp(w, ctx, upd, res);
        }
        // Validate event ownership; legacy audience flags never publish KP facts.
        knowledge_.deriveScope(w, ctx.channelId, ctx.knowledgeMode, sources);
        KnowledgeScope scope{"gm", {}};
        Json::Value data = fact.isMember("data") && fact["data"].isObject() ? fact["data"] : Json::Value(Json::objectValue);
        std::string sceneId = json::str(fact, "scene_id");
        if ((!ctx.access.isGm || sceneId.empty()) && !sources.empty()) {
            auto sc = Db::queryOne(w, "SELECT scene_id FROM events WHERE id=$1", {sources.front()});
            if (!sc.isNull() && !sc["scene_id"].isNull()) sceneId = sc["scene_id"].asString();
        }
        if(!sceneId.empty() && Db::queryOne(w,"SELECT id FROM scenes WHERE id=$1 AND channel_id=$2",{sceneId,ctx.channelId}).isNull()) return reject("Scene outside this channel");
        auto row = Db::queryOne(w, "INSERT INTO knowledge_facts(channel_id, kind, summary, data, status, scene_id, source_event_ids, created_by, player_group_id) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::uuid[],$8,$9::uuid) RETURNING id",
            {ctx.channelId, ctx.factKind, summary, json::dump(data), status, sceneId.empty() ? dbNull() : DbParam(sceneId), pgArrayLiteral(sources), isAi ? "ai" : (ctx.actor == "gm" ? "gm" : "system"), ctx.access.playerGroupId.empty() ? dbNull() : DbParam(ctx.access.playerGroupId)});
        auto factId = row["id"].asString();
        knowledge_.setScope(w, factId, KnowledgeScope{"gm", {}}, isAi ? "event" : "gm");
        Json::Value full; full["summary"] = summary; full["status"] = status; full["data"] = data; full["scene_id"] = sceneId;
        indexFact(w, ctx.channelId, factId, ctx.factKind, full);
        linkEntities(w, ctx.channelId, factId, fact["entities"], ctx.actor);
        auto md = json::str(fact, "content_md"); if (md.empty()) md = renderEntry(ctx.factKind, full);
        auto pos = Db::queryOne(w, "SELECT coalesce(max(position),0)+1 AS p FROM document_entries WHERE document_id=$1", {ctx.documentId});
        auto entry = Db::queryOne(w, "INSERT INTO document_entries(document_id, fact_id, section, position, content_md, created_version, updated_version) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id",
            {ctx.documentId, factId, json::str(fact, "section", json::str(data,"facet",json::str(data,"thread_kind",status))), (int64_t)pos["p"].asInt(), md, (int64_t)ctx.newVersion});
        log["decision"] = "applied"; log["fact_id"] = factId; log["entry_id"] = entry["id"]; log["status"] = status; log["scope"] = scope.toJson();
        res.applied++; res.touchedFactIds.push_back(factId); res.touchedEntryIds.push_back(entry["id"].asString());
        for (auto& s : sources) res.sourceEventIds.push_back(s);
        res.log.append(log);
        return;
    }

    // All remaining ops address an existing fact.
    auto factId = json::str(op, "fact_id");
    if (factId.empty() && !json::str(op, "entry_id").empty()) {
        auto e = Db::queryOne(w, "SELECT fact_id FROM document_entries WHERE id=$1 AND document_id=$2", {json::str(op, "entry_id"), ctx.documentId});
        if (!e.isNull()) factId = e["fact_id"].asString();
    }
    if (!Visibility::isUuid(factId)) return reject("op requires fact_id");
    auto cur = Db::queryOne(w, "SELECT f.*, de.id AS entry_id, de.content_md, de.removed FROM knowledge_facts f JOIN document_entries de ON de.fact_id=f.id AND de.document_id=$2 WHERE f.id=$1 AND f.channel_id=$3",
        {factId, ctx.documentId, ctx.channelId});
    if (cur.isNull()) return reject("fact not found in this document");
    auto curStatus = cur["status"].asString();
    log["fact_id"] = factId; log["entry_id"] = cur["entry_id"];
    auto sources = mergeSources(op, ctx.defaultSources);
    auto mergedSources = json::strArray(cur["source_event_ids"]);
    for (auto& s : sources) if (std::find(mergedSources.begin(), mergedSources.end(), s) == mergedSources.end()) mergedSources.push_back(s);

    if (type == "update_entry" || type == "set_status") {
        auto newStatus = json::str(op, "status", curStatus);
        if (!validStatuses().count(newStatus)) return reject("invalid status");
        auto newSummary = json::str(op, "summary", cur["summary"].asString());
        Json::Value newData = cur["data"];
        if (op.isMember("data") && op["data"].isObject()) for (auto it = op["data"].begin(); it != op["data"].end(); ++it) newData[it.name()] = *it;
        if (isAi) {
            if (sources.empty()) return reject("AI updates require a source event");
            if (newStatus == "confirmed" && curStatus != "confirmed") {
                auto gm = Db::queryOne(w, "SELECT count(*) AS n FROM events WHERE channel_id=$1 AND id = ANY(" + Visibility::uuidArray(sources) + ") AND actor_role IN ('gm','system')", {ctx.channelId});
                if (gm.isNull() || gm["n"].asInt() == 0) return reject("cannot confirm without a GM-authored source event");
            }
            // Changing or weakening an already-confirmed fact is a contradiction → GM review.
            bool contradicts = curStatus == "confirmed" && (newStatus != "confirmed" || (newSummary != cur["summary"].asString() && json::toBool(op, "contradiction", false)));
            if (curStatus == "confirmed" && newStatus != "confirmed" && newStatus != "resolved") contradicts = true;
            if (contradicts) { Json::Value payload = op; payload["previous"] = cur["summary"]; payload["previous_status"] = curStatus; return pending("contradicts a confirmed record", payload); }
        }
        if (isAi && cur["created_by"].asString() == "gm" && newSummary != cur["summary"].asString()) {
            Json::Value payload = op; payload["previous"] = cur["summary"]; return pending("would alter a GM-authored entry", payload);
        }
        // Repetition is not a revision. Evidence still lives in chat and the recorded proposal.
        if (isAi && !cur["removed"].asBool() && newSummary == cur["summary"].asString() && newStatus == curStatus && newData == cur["data"] &&
            (!op.isMember("content_md") || json::str(op,"content_md") == json::str(cur,"content_md")) && op["entities"].empty()) {
            log["decision"] = "skipped"; log["reason"] = "No material change to the existing entry"; res.log.append(log); return;
        }
        Db::exec(w, "UPDATE knowledge_facts SET summary=$2, data=$3::jsonb, status=$4, source_event_ids=$5::uuid[], version=version+1, updated_at=now() WHERE id=$1",
            {factId, newSummary, json::dump(newData), newStatus, pgArrayLiteral(mergedSources)});
        Json::Value full; full["summary"] = newSummary; full["status"] = newStatus; full["data"] = newData; full["scene_id"] = cur["scene_id"].isNull() ? "" : cur["scene_id"].asString();
        indexFact(w, ctx.channelId, factId, ctx.factKind, full);
        linkEntities(w, ctx.channelId, factId, op["entities"], ctx.actor);
        auto md = json::str(op, "content_md"); if (md.empty()) md = renderEntry(ctx.factKind, full);
        Db::exec(w, "UPDATE document_entries SET content_md=$2, updated_version=$3, removed=false, updated_at=now() WHERE id=$1", {cur["entry_id"].asString(), md, (int64_t)ctx.newVersion});

        // Becoming a GM secret always tightens access, whether or not a visibility was supplied.
        if (newStatus == "gm_secret") { knowledge_.setScope(w, factId, KnowledgeScope{"gm", {}}, isAi ? "ai_proposal" : "gm"); log["scope"] = "gm"; }
        log["decision"] = "applied"; log["status"] = newStatus; res.applied++;
        res.touchedFactIds.push_back(factId); res.touchedEntryIds.push_back(cur["entry_id"].asString());
        for (auto& s : sources) res.sourceEventIds.push_back(s);
        res.log.append(log);
        return;
    }
    if (type == "append_text") {
        auto t = text::trim(json::str(op, "text"));
        if (t.empty()) return reject("append_text requires text");
        if (isAi && sources.empty()) return reject("AI updates require a source event");
        Db::exec(w, "UPDATE document_entries SET content_md = content_md || E'\\n\\n' || $2, updated_version=$3, updated_at=now() WHERE id=$1", {cur["entry_id"].asString(), t, (int64_t)ctx.newVersion});
        Db::exec(w, "UPDATE knowledge_facts SET source_event_ids=$2::uuid[], version=version+1, updated_at=now() WHERE id=$1", {factId, pgArrayLiteral(mergedSources)});
        log["decision"] = "applied"; res.applied++; res.touchedFactIds.push_back(factId); res.touchedEntryIds.push_back(cur["entry_id"].asString()); res.log.append(log);
        for (auto& s : sources) res.sourceEventIds.push_back(s);
        return;
    }
    if (type == "remove_entry") {
        if (isAi && curStatus == "confirmed") { Json::Value payload = op; payload["previous"] = cur["summary"]; return pending("removal of a confirmed record", payload); }
        Db::exec(w, "UPDATE document_entries SET removed=true, updated_version=$2, updated_at=now() WHERE id=$1", {cur["entry_id"].asString(), (int64_t)ctx.newVersion});
        Db::exec(w, "UPDATE knowledge_facts SET status='retracted', version=version+1, updated_at=now() WHERE id=$1", {factId});
        log["decision"] = "applied"; res.applied++; res.touchedFactIds.push_back(factId); res.touchedEntryIds.push_back(cur["entry_id"].asString()); res.log.append(log);
        return;
    }
    if (type == "add_relation") {
        auto from = json::str(op["from"], "name"), to = json::str(op["to"], "name"), rel = json::str(op, "relation");
        if (from.empty() || to.empty() || rel.empty()) return reject("add_relation requires from, to, relation");
        auto fe = knowledge_.upsertEntity(w, ctx.channelId, json::str(op["from"], "kind", "npc"), from, "", ctx.access.playerGroupId);
        auto te = knowledge_.upsertEntity(w, ctx.channelId, json::str(op["to"], "kind", "npc"), to, "", ctx.access.playerGroupId);
        knowledge_.linkFactEntity(w, factId, fe, "from"); knowledge_.linkFactEntity(w, factId, te, "to");
        knowledge_.addRelation(w, ctx.channelId, fe, te, rel, factId);
        log["decision"] = "applied"; res.applied++; res.touchedFactIds.push_back(factId); res.log.append(log);
        return;
    }
    if (type == "link_facts") {
        auto other = json::str(op, "related_fact_id");
        if (!Visibility::isUuid(other)) return reject("link_facts requires related_fact_id");
        if(Db::queryOne(w,"SELECT f.id FROM knowledge_facts f WHERE f.id=$1 AND f.channel_id=$2 AND "+Visibility::factFilter(ctx.access),{other,ctx.channelId}).isNull()) return reject("related fact is outside this memory partition");
        Db::exec(w, "UPDATE clues SET related_fact_ids = array_append(array_remove(related_fact_ids, $2::uuid), $2::uuid) WHERE fact_id=$1", {factId, other});
        Db::exec(w, "UPDATE knowledge_facts SET data = data || jsonb_build_object('related_fact_ids', coalesce(data->'related_fact_ids','[]'::jsonb) || to_jsonb($2::text)), updated_at=now() WHERE id=$1 AND NOT (coalesce(data->'related_fact_ids','[]'::jsonb) ? $2)", {factId, other});
        log["decision"] = "applied"; res.applied++; res.touchedFactIds.push_back(factId); res.log.append(log);
        return;
    }
    reject("unknown op: " + type);
}

Json::Value DocumentService::snapshotEntries(pqxx::work& w, const std::string& documentId) {
    return Db::queryJson(w, "SELECT de.id AS entry_id, de.fact_id, de.section, de.position, de.content_md, de.removed, de.updated_version, f.summary, f.status, f.data, f.source_event_ids "
                            "FROM document_entries de JOIN knowledge_facts f ON f.id=de.fact_id WHERE de.document_id=$1 ORDER BY de.position", {documentId});
}

CommitResult DocumentService::commit(const Proposal& p) {
    if (!p.ops.isArray() || p.ops.empty()) throw badRequest("proposal has no ops");
    CommitResult res;
    Json::Value notifyPayload;
    db_.tx([&](pqxx::work& w) {
        std::string docId = p.documentId;
        ChannelAccess memory; memory.channelId=p.channelId; memory.isGm=p.playerGroupId.empty(); memory.playerGroupId=p.playerGroupId; memory.playerGroupVersion=p.playerGroupVersion;
        if(!memory.isGm) {
            if(p.actor!="ai") throw forbidden("Player memory can only be summarized from chat");
            auto group=Db::queryOne(w,"SELECT version FROM player_groups WHERE id=$1 AND channel_id=$2 FOR UPDATE",{p.playerGroupId,p.channelId});
            if(group.isNull() || group["version"].asInt()!=p.playerGroupVersion) throw conflict("Player group changed during generation");
            if(docId.empty()) { auto d=Db::queryOne(w,"SELECT id FROM documents WHERE player_group_id=$1 AND doc_type=$2",{p.playerGroupId,p.documentType}); if(d.isNull()) throw notFound("player document not found"); docId=d["id"].asString(); }
        }
        if (docId.empty()) docId = documentIdFor(w, p.channelId, p.documentType);
        auto doc = Db::queryOne(w, "SELECT * FROM documents WHERE id=$1 AND channel_id=$2 FOR UPDATE", {docId, p.channelId});
        if (doc.isNull()) throw notFound("document not found");
        if(json::str(doc,"player_group_id")!=p.playerGroupId) throw forbidden("Document belongs to another memory partition");
        int curVersion = doc["version"].asInt();
        if (p.expectedVersion >= 0 && p.expectedVersion != curVersion)
            throw conflict("document version mismatch: expected " + std::to_string(p.expectedVersion) + ", current " + std::to_string(curVersion));
        auto mode = Db::queryOne(w, "SELECT knowledge_mode FROM channels WHERE id=$1", {p.channelId});
        OpContext ctx; ctx.channelId = p.channelId; ctx.documentId = docId; ctx.docType = doc["doc_type"].asString(); ctx.factKind = kindForDoc(ctx.docType);
        ctx.access=memory; ctx.allowedSources=p.allowedSourceEventIds;
        ctx.knowledgeMode = mode["knowledge_mode"].asString(); ctx.actor = p.actor; ctx.actorUserId = p.actorUserId; ctx.newVersion = curVersion + 1; ctx.defaultSources = p.sourceEventIds; ctx.aiJobId = p.aiJobId;
        // Record the proposal itself for traceability.
        auto pr = Db::queryOne(w, "INSERT INTO document_proposals(channel_id, document_id, ai_job_id, expected_version, ops, source_event_ids, evidence, status) VALUES($1,$2,$3,$4,$5::jsonb,$6::uuid[],$7::jsonb,'pending') RETURNING id",
            {p.channelId, docId, p.aiJobId.empty() ? dbNull() : DbParam(p.aiJobId), (int64_t)curVersion, json::dump(p.ops), pgArrayLiteral(p.sourceEventIds), json::dump(p.evidence)});
        ctx.proposalId = pr["id"].asString();
        res.documentId = docId; res.docType = ctx.docType; res.gmOnly = doc["gm_only"].asBool();
        for (const auto& op : p.ops) {
            if (!op.isObject()) { res.rejected++; continue; }
            try { applyOp(w, ctx, op, res); }
            catch (const ApiError& e) { Json::Value l; l["op"] = json::str(op, "op"); l["decision"] = "rejected"; l["reason"] = e.what(); res.log.append(l); res.rejected++; }
        }
        if (res.applied > 0) {
            res.version = ctx.newVersion;
            Db::exec(w, "UPDATE documents SET version=$2, updated_at=now() WHERE id=$1", {docId, (int64_t)res.version});
            auto snap = snapshotEntries(w, docId);
            std::sort(res.sourceEventIds.begin(), res.sourceEventIds.end()); res.sourceEventIds.erase(std::unique(res.sourceEventIds.begin(), res.sourceEventIds.end()), res.sourceEventIds.end());
            Db::exec(w, "INSERT INTO document_revisions(document_id, version, actor, actor_user_id, ops, snapshot, summary, source_event_ids, ai_job_id) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::uuid[],$9)",
                {docId, (int64_t)res.version, p.actor, p.actorUserId.empty() ? dbNull() : DbParam(p.actorUserId), json::dump(p.ops), json::dump(snap),
                 p.summary.empty() ? (std::to_string(res.applied) + " change(s) by " + p.actor) : p.summary, pgArrayLiteral(res.sourceEventIds), p.aiJobId.empty() ? dbNull() : DbParam(p.aiJobId)});
            Db::exec(w, "UPDATE document_proposals SET status='committed', committed_version=$2, decided_at=now() WHERE id=$1", {ctx.proposalId, (int64_t)res.version});
        } else {
            res.version = curVersion;
            Db::exec(w, "UPDATE document_proposals SET status='rejected', rejection_reason=$2, decided_at=now() WHERE id=$1", {ctx.proposalId, json::dump(res.log)});
        }
        notifyPayload["player_group_id"] = p.playerGroupId; notifyPayload["document_id"] = docId; notifyPayload["doc_type"] = ctx.docType; notifyPayload["version"] = res.version;
        notifyPayload["change_count"] = res.applied; notifyPayload["gm_only"] = res.gmOnly; notifyPayload["actor"] = p.actor;
        notifyPayload["summary"] = p.summary; notifyPayload["entry_ids"] = json::fromStrArray(res.touchedEntryIds);
        notifyPayload["pending_review"] = res.pendingReview;
    });
    if (res.applied > 0) notifier_.documentUpdated(p.channelId, notifyPayload);
    if (res.pendingReview > 0) { Json::Value pp; pp["document_id"] = res.documentId; pp["count"] = res.pendingReview; notifier_.proposalPending(p.channelId, pp); }
    return res;
}

// ---- reading ---------------------------------------------------------------------------------
static std::string entrySelect(const ChannelAccess& a) {
    return "SELECT de.id, de.document_id, de.fact_id, de.section, de.position, de.content_md, de.created_version, de.updated_version, de.created_at, de.updated_at, "
           "f.kind, f.summary, f.status, f.data, f.scene_id, f.source_event_ids, f.created_by, CASE WHEN f.player_group_id IS NULL THEN s.title ELSE NULL END AS scene_title, "
           "(SELECT json_agg(json_build_object('id', e.id, 'name', e.name, 'kind', e.kind, 'role', fe.role)) FROM fact_entities fe JOIN entities e ON e.id=fe.entity_id WHERE fe.fact_id=f.id) AS entities "
           + std::string(a.isGm ? ", (SELECT json_agg(json_build_object('scope', kv.scope, 'character_id', kv.character_id)) FROM knowledge_visibility kv WHERE kv.fact_id=f.id) AS visibility " : "") +
           "FROM document_entries de JOIN knowledge_facts f ON f.id=de.fact_id LEFT JOIN scenes s ON s.id=f.scene_id ";
}

Json::Value DocumentService::listDocuments(const ChannelAccess& a, int) {
    std::string sql =
        "SELECT d.id, d.doc_type, d.title, d.version, d.gm_only, d.updated_at, "
        "(SELECT count(*) FROM document_entries de JOIN knowledge_facts f ON f.id=de.fact_id WHERE de.document_id=d.id AND NOT de.removed AND " + Visibility::factFilter(a) + ") AS entry_count, "
        "(SELECT count(*) FROM document_entries de JOIN knowledge_facts f ON f.id=de.fact_id WHERE de.document_id=d.id AND NOT de.removed AND de.updated_version > greatest(d.version-3,0) AND " + Visibility::factFilter(a) + ") AS recent_changes, "
        "(SELECT f.summary FROM document_entries de JOIN knowledge_facts f ON f.id=de.fact_id WHERE de.document_id=d.id AND NOT de.removed AND " + Visibility::factFilter(a) + " ORDER BY de.updated_version DESC, de.position DESC LIMIT 1) AS preview "
        "FROM documents d WHERE d.channel_id=$1 AND " + Visibility::partitionFilter(a,"d") + std::string(a.isGm ? "" : " AND NOT d.gm_only") + " ORDER BY array_position(ARRAY['current_scene','clue_journal','relationships','open_threads','timeline','module_progress'], d.doc_type)";
    return db_.queryJson(sql, {a.channelId});
}

Json::Value DocumentService::getDocument(const ChannelAccess& a, const std::string& documentId, const std::string& sceneId, int sinceVersion) {
    auto doc = db_.queryOne("SELECT d.* FROM documents d WHERE id=$1 AND channel_id=$2 AND " + Visibility::partitionFilter(a,"d"), {documentId, a.channelId});
    if (doc.isNull()) throw notFound("document not found");
    if (doc["gm_only"].asBool() && !a.isGm) throw forbidden("GM-only document");
    std::string sql = entrySelect(a) + "WHERE de.document_id=$1 AND NOT de.removed AND " + Visibility::factFilter(a);
    DbParams p{documentId};
    if (doc["doc_type"].asString() == "current_scene" && sceneId!="all") {
        std::string sid = sceneId;
        if (sid.empty()) { auto ch = db_.queryOne("SELECT current_scene_id FROM channels WHERE id=$1", {a.channelId}); if (!ch.isNull() && !ch["current_scene_id"].isNull()) sid = ch["current_scene_id"].asString(); }
        if (!sid.empty() && !Visibility::isUuid(sid)) throw badRequest("invalid scene id");
        if (!sid.empty()) { p.push_back(sid); sql += " AND f.scene_id=$2"; doc["scene_id"] = sid; auto sc = db_.queryOne("SELECT title, location, narrative_time, status FROM scenes WHERE id=$1 AND channel_id=$2", {sid, a.channelId}); if(a.isGm) doc["scene"] = sc; }
    }
    sql += " ORDER BY de.section, de.position";
    auto entries = db_.queryJson(sql, p);
    std::string md = "# " + doc["title"].asString() + "\n\n";
    if (doc.isMember("scene") && !doc["scene"].isNull()) md += "**" + doc["scene"]["title"].asString() + "** — " + doc["scene"]["location"].asString() + (doc["scene"]["narrative_time"].asString().empty() ? "" : " · " + doc["scene"]["narrative_time"].asString()) + "\n\n";
    std::string curSection; int changed = 0;
    for (auto& e : entries) {
        auto sec = e["section"].asString();
        if (sec != curSection) { curSection = sec; if (!sec.empty()) md += "## " + sec + "\n\n"; }
        md += e["content_md"].asString() + "\n\n";
        e["changed_since"] = sinceVersion >= 0 && e["updated_version"].asInt() > sinceVersion;
        if (e["changed_since"].asBool()) changed++;
    }
    doc["entries"] = entries; doc["markdown"] = md; doc["changed_since_count"] = changed;
    return doc;
}
Json::Value DocumentService::getEntry(const ChannelAccess& a, const std::string& entryId) {
    auto e = db_.queryOne(entrySelect(a) + "JOIN documents d ON d.id=de.document_id WHERE de.id=$1 AND d.channel_id=$2 AND " + Visibility::factFilter(a), {entryId, a.channelId});
    if (e.isNull()) throw notFound("entry not found");
    return e;
}
Json::Value DocumentService::relatedEntries(const ChannelAccess& a, const std::string& entryId) {
    auto e = getEntry(a, entryId);
    // Related = entries sharing an entity, or explicitly linked.
    return db_.queryJson(entrySelect(a) +
        "JOIN documents d ON d.id=de.document_id WHERE d.channel_id=$1 AND de.id <> $2 AND NOT de.removed AND " + Visibility::factFilter(a) + " AND (" + std::string(a.isGm ? "" : "NOT d.gm_only AND ") +
        "(f.id IN (SELECT fe2.fact_id FROM fact_entities fe1 JOIN fact_entities fe2 ON fe1.entity_id=fe2.entity_id WHERE fe1.fact_id=$3)) "
        "OR (f.data->'related_fact_ids') ? $3::text OR ((SELECT f0.data->'related_fact_ids' FROM knowledge_facts f0 WHERE f0.id=$3) ? f.id::text)) ORDER BY de.updated_at DESC LIMIT 20",
        {a.channelId, entryId, e["fact_id"].asString()});
}
Json::Value DocumentService::listRevisions(const ChannelAccess& a, const std::string& documentId, int limit) {
    auto doc = db_.queryOne("SELECT d.* FROM documents d WHERE id=$1 AND channel_id=$2 AND " + Visibility::partitionFilter(a,"d"), {documentId, a.channelId});
    if (doc.isNull()) throw notFound("document not found");
    if (doc["gm_only"].asBool() && !a.isGm) throw forbidden("GM-only document");
    return db_.queryJson("SELECT r.id, r.version, r.actor, r.summary, r.source_event_ids, r.created_at, u.display_name AS actor_name, jsonb_array_length(r.ops) AS op_count "
                         "FROM document_revisions r LEFT JOIN users u ON u.id=r.actor_user_id WHERE r.document_id=$1 ORDER BY r.version DESC LIMIT $2", {documentId, (int64_t)std::max(1, std::min(limit, 200))});
}
Json::Value DocumentService::getRevision(const ChannelAccess& a, const std::string& documentId, int version) {
    auto doc = db_.queryOne("SELECT d.* FROM documents d WHERE id=$1 AND channel_id=$2 AND " + Visibility::partitionFilter(a,"d"), {documentId, a.channelId});
    if (doc.isNull()) throw notFound("document not found");
    if (doc["gm_only"].asBool() && !a.isGm) throw forbidden("GM-only document");
    auto r = db_.queryOne("SELECT * FROM document_revisions WHERE document_id=$1 AND version=$2", {documentId, (int64_t)version});
    if (r.isNull()) throw notFound("revision not found");
    if (!a.isGm) {
        // Players only see snapshot entries whose facts they may know.
        Json::Value filtered(Json::arrayValue);
        std::vector<std::string> ids; for (auto& e : r["snapshot"]) ids.push_back(e["fact_id"].asString());
        std::set<std::string> allowed;
        if (!ids.empty()) for (auto& x : db_.queryJson("SELECT f.id FROM knowledge_facts f WHERE f.id = ANY(" + Visibility::uuidArray(ids) + ") AND " + Visibility::factFilter(a))) allowed.insert(x["id"].asString());
        for (auto& e : r["snapshot"]) if (allowed.count(e["fact_id"].asString())) filtered.append(e);
        r["snapshot"] = filtered; r["ops"] = Json::Value(Json::arrayValue);
    }
    return r;
}

Json::Value DocumentService::gmCorrectEntry(const ChannelAccess& a, const std::string& documentId, const std::string& entryId, const Json::Value& body) {
    if (!a.isGm) throw forbidden("GM role required");
    auto e = getEntry(a, entryId);
    if (e["document_id"].asString() != documentId) throw badRequest("entry does not belong to document");
    Json::Value op; op["op"] = json::str(body, "op", "update_entry"); op["fact_id"] = e["fact_id"];
    if (body.isMember("summary")) op["summary"] = body["summary"];
    if (body.isMember("status")) op["status"] = body["status"];
    if (body.isMember("data")) op["data"] = body["data"];
    if (body.isMember("content_md")) op["content_md"] = body["content_md"];
    if (body.isMember("visibility")) op["visibility"] = body["visibility"];
    Proposal p; p.channelId = a.channelId; p.documentId = documentId; p.actor = "gm"; p.actorUserId = a.userId;
    p.expectedVersion = json::toInt(body, "expected_version", -1);
    p.summary = "GM correction: " + json::str(body, "reason", "manual edit");
    p.ops.append(op);
    auto res = commit(p);
    // Trace the correction as an event so that later analysis knows the old reading was wrong.
    Json::Value payload; payload["entry_id"] = entryId; payload["fact_id"] = e["fact_id"]; payload["previous_summary"] = e["summary"]; payload["previous_status"] = e["status"];
    payload["new_status"] = json::str(body, "status", e["status"].asString()); payload["reason"] = json::str(body, "reason");
    payload["content"] = "GM corrected document entry: " + json::str(body, "summary", e["summary"].asString()) + " [" + payload["new_status"].asString() + "]";
    db_.exec("INSERT INTO events(channel_id, actor_user_id, actor_role, kind, payload, visibility) VALUES($1,$2,'gm','document.corrected',$3::jsonb,'gm_only')", {a.channelId, a.userId, json::dump(payload)});
    Json::Value out; out["version"] = res.version; out["log"] = res.log; out["entry"] = getEntry(a, entryId);
    return out;
}

Json::Value DocumentService::gmRollback(const ChannelAccess& a, const std::string& documentId, int toVersion) {
    if (!a.isGm) throw forbidden("GM role required");
    Json::Value notify;
    int newVersion = 0;
    db_.tx([&](pqxx::work& w) {
        auto doc = Db::queryOne(w, "SELECT d.* FROM documents d WHERE id=$1 AND channel_id=$2 AND " + Visibility::partitionFilter(a,"d") + " FOR UPDATE", {documentId, a.channelId});
        if (doc.isNull()) throw notFound("document not found");
        auto rev = Db::queryOne(w, "SELECT * FROM document_revisions WHERE document_id=$1 AND version=$2", {documentId, (int64_t)toVersion});
        if (rev.isNull()) throw notFound("revision not found");
        newVersion = doc["version"].asInt() + 1;
        std::set<std::string> keep;
        for (auto& e : rev["snapshot"]) {
            keep.insert(e["entry_id"].asString());
            Db::exec(w, "UPDATE document_entries SET content_md=$2, removed=$3, position=$4, updated_version=$5, updated_at=now() WHERE id=$1",
                {e["entry_id"].asString(), e["content_md"].asString(), e["removed"].asBool(), (int64_t)e["position"].asInt(), (int64_t)newVersion});
            Db::exec(w, "UPDATE knowledge_facts SET summary=$2, status=$3, data=$4::jsonb, version=version+1, updated_at=now() WHERE id=$1",
                {e["fact_id"].asString(), e["summary"].asString(), e["status"].asString(), json::dump(e["data"])});
        }
        // Entries that did not exist at that version are removed (soft) so nothing is lost.
        for (auto& e : Db::queryJson(w, "SELECT id, fact_id FROM document_entries WHERE document_id=$1", {documentId}))
            if (!keep.count(e["id"].asString())) {
                Db::exec(w, "UPDATE document_entries SET removed=true, updated_version=$2 WHERE id=$1", {e["id"].asString(), (int64_t)newVersion});
                Db::exec(w, "UPDATE knowledge_facts SET status='retracted', updated_at=now() WHERE id=$1", {e["fact_id"].asString()});
            }
        Db::exec(w, "UPDATE documents SET version=$2, updated_at=now() WHERE id=$1", {documentId, (int64_t)newVersion});
        Json::Value ops(Json::arrayValue); Json::Value op; op["op"] = "rollback"; op["to_version"] = toVersion; ops.append(op);
        Db::exec(w, "INSERT INTO document_revisions(document_id, version, actor, actor_user_id, ops, snapshot, summary) VALUES($1,$2,'gm',$3,$4::jsonb,$5::jsonb,$6)",
            {documentId, (int64_t)newVersion, a.userId, json::dump(ops), json::dump(snapshotEntries(w, documentId)), "Rolled back to version " + std::to_string(toVersion)});
        Json::Value payload; payload["document_id"] = documentId; payload["to_version"] = toVersion; payload["content"] = "GM rolled back " + doc["title"].asString() + " to version " + std::to_string(toVersion);
        Db::exec(w, "INSERT INTO events(channel_id, actor_user_id, actor_role, kind, payload, visibility) VALUES($1,$2,'gm','document.rolled_back',$3::jsonb,'gm_only')", {a.channelId, a.userId, json::dump(payload)});
        notify["document_id"] = documentId; notify["doc_type"] = doc["doc_type"]; notify["version"] = newVersion; notify["change_count"] = (int)keep.size(); notify["gm_only"] = doc["gm_only"]; notify["actor"] = "gm"; notify["summary"] = "rollback";
    });
    notifier_.documentUpdated(a.channelId, notify);
    return getDocument(a, documentId, "", -1);
}

Json::Value DocumentService::listProposals(const ChannelAccess& a, const std::string& status) {
    if (!a.isGm) throw forbidden("GM role required");
    std::string sql = "SELECT p.*, d.doc_type, d.title AS document_title FROM document_proposals p LEFT JOIN documents d ON d.id=p.document_id WHERE p.channel_id=$1 AND (p.document_id IS NULL OR d.player_group_id IS NULL)";
    DbParams params{a.channelId};
    if (!status.empty()) { sql += " AND p.status=$2"; params.push_back(status); }
    sql += " ORDER BY p.created_at DESC LIMIT 100";
    return db_.queryJson(sql, params);
}
Json::Value DocumentService::decideProposal(const ChannelAccess& a, const std::string& proposalId, bool accept) {
    if (!a.isGm) throw forbidden("GM role required");
    if (!Visibility::isUuid(proposalId)) throw notFound("proposal not found");
    auto pr = db_.queryOne("SELECT p.* FROM document_proposals p WHERE id=$1 AND channel_id=$2 AND (p.document_id IS NULL OR EXISTS(SELECT 1 FROM documents d WHERE d.id=p.document_id AND d.player_group_id IS NULL))", {proposalId, a.channelId});
    if (pr.isNull()) throw notFound("proposal not found");
    if (!accept) {
        auto r = db_.queryOne("UPDATE document_proposals SET status='rejected', decided_at=now() WHERE id=$1 AND status='needs_gm_review' RETURNING *", {proposalId});
        if (r.isNull()) throw conflict("proposal already decided");
        return r;
    }
    // Claim the proposal before applying it: of two simultaneous accepts, only one applies the operations.
    if (db_.queryOne("UPDATE document_proposals SET status='applying' WHERE id=$1 AND status='needs_gm_review' RETURNING id", {proposalId}).isNull())
        throw conflict("proposal already decided");
    // Knowledge-sharing suggestions are not document ops: accepting them widens who knows the fact.
    if (pr["ops"].isArray() && !pr["ops"].empty() && json::str(pr["ops"][0], "op") == "share_knowledge") {
        throw conflict("Direct knowledge sharing has been retired; use chat");
    }
    Proposal p; p.channelId = a.channelId; p.documentId = pr["document_id"].asString(); p.actor = "gm"; p.actorUserId = a.userId;
    p.ops = pr["ops"]; p.sourceEventIds = json::strArray(pr["source_event_ids"]); p.summary = "GM accepted AI proposal";
    for (auto& op : p.ops) { op.removeMember("previous"); op.removeMember("previous_status"); }
    CommitResult res;
    try { res = commit(p); }
    catch (...) { db_.exec("UPDATE document_proposals SET status='needs_gm_review' WHERE id=$1 AND status='applying'", {proposalId}); throw; }
    auto out = db_.queryOne("UPDATE document_proposals SET status='committed', committed_version=$2, decided_at=now() WHERE id=$1 RETURNING *", {proposalId, (int64_t)res.version});
    out["log"] = res.log;
    return out;
}

} // namespace acerciae
