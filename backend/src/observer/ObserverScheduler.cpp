#include "ObserverScheduler.h"
#include "../events/EventStore.h"
#include "../documents/DocumentService.h"
#include "../highlights/HighlightService.h"
#include "../retrieval/ContextRetrievalService.h"
#include "../knowledge/KnowledgeService.h"
#include "../knowledge/Visibility.h"
#include "../llm/LlmGateway.h"
#include "../ws/Notifier.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../core/Log.h"
#include "../core/Errors.h"
#include <chrono>

namespace acerciae {

ObserverScheduler::ObserverScheduler(const Config& cfg, Db& db, EventStore& events, DocumentService& docs, HighlightService& highlights,
                                     ContextRetrievalService& retrieval, LlmGateway& llm, Notifier& notifier, KnowledgeService& knowledge)
    : cfg_(cfg), db_(db), events_(events), docs_(docs), highlights_(highlights), retrieval_(retrieval), llm_(llm), notifier_(notifier), knowledge_(knowledge) {}
ObserverScheduler::~ObserverScheduler() { stop(); }

void ObserverScheduler::start() {
    if (running_.exchange(true)) return;
    // Jobs left 'running' by a crashed process must not block the task lock forever.
    try { db_.exec("UPDATE ai_jobs SET status='failed', error='interrupted (restart)', finished_at=now() WHERE status='running'"); } catch (...) {}
    observeThread_ = std::thread([this] { observeLoop(); });
    consolidateThread_ = std::thread([this] { consolidateLoop(); });
    cleanupThread_ = std::thread([this] { cleanupLoop(); });
    ALOG_INFO << "AI observer started: observe every " << cfg_.observerIntervalMs << "ms, consolidate every " << cfg_.consolidatorIntervalMs << "ms";
}
void ObserverScheduler::stop() {
    if (!running_.exchange(false)) return;
    cv_.notify_all();
    for (auto* t : {&observeThread_, &consolidateThread_, &cleanupThread_}) if (t->joinable()) t->join();
}
template <typename F> static void loopEvery(std::atomic<bool>& running, std::mutex& mu, std::condition_variable& cv, int ms, F fn) {
    while (running) {
        try { fn(); } catch (const std::exception& e) { ALOG_ERROR << "scheduler loop error: " << e.what(); }
        std::unique_lock<std::mutex> lk(mu);
        cv.wait_for(lk, std::chrono::milliseconds(ms), [&] { return !running.load(); });
    }
}
void ObserverScheduler::observeLoop() { loopEvery(running_, cvMu_, cv_, cfg_.observerIntervalMs, [this] { if (cfg_.observerEnabled) observeTick(); }); }
void ObserverScheduler::consolidateLoop() {
    loopEvery(running_, cvMu_, cv_, cfg_.consolidatorIntervalMs, [this] {
        if (!cfg_.observerEnabled) return;
        for (auto& ch : db_.queryJson("SELECT id FROM channels WHERE ai_enabled")) consolidateChannel(ch["id"].asString());
    });
}
void ObserverScheduler::cleanupLoop() { loopEvery(running_, cvMu_, cv_, cfg_.highlightCleanupIntervalMs, [this] { cleanupHighlights(); }); }

int ObserverScheduler::cleanupHighlights() {
    int n = 0;
    for (auto& [channel, ids] : highlights_.cleanupExpired()) { n += (int)ids.size(); notifier_.highlightExpired(channel, ids); }
    return n;
}

bool ObserverScheduler::tryLock(const std::string& key) { std::lock_guard<std::mutex> lk(lockMu_); return locks_.insert(key).second; }
void ObserverScheduler::unlock(const std::string& key) { std::lock_guard<std::mutex> lk(lockMu_); locks_.erase(key); }

ChannelAccess ObserverScheduler::systemAccess(const std::string& channelId) {
    ChannelAccess a; a.channelId = channelId; a.isGm = true; a.userId = "00000000-0000-0000-0000-000000000000";
    auto m = knowledge_.channelMode(channelId); a.knowledgeMode = m.isNull() ? "isolated" : m["knowledge_mode"].asString();
    return a;
}

void ObserverScheduler::observeTick() {
    ticks_++;
    for (auto& ch : db_.queryJson("SELECT id FROM channels WHERE ai_enabled")) {
        try { observeChannel(ch["id"].asString()); }
        catch (const std::exception& e) { ALOG_ERROR << "observe channel " << ch["id"].asString() << ": " << e.what(); }
    }
}

static const char* OBSERVED_KINDS = "('message.posted','scene.entered','scene.created','scene.updated','scene.closed','gm.declared')";

Json::Value ObserverScheduler::observeChannel(const std::string& channelId) {
    Json::Value out(Json::arrayValue);
    auto groups = db_.queryJson(
        "SELECT coalesce(e.chat_window_id::text,'') AS window_id, coalesce(e.scene_id::text,'') AS scene_id, count(*) AS pending, min(e.seq) AS from_seq, max(e.seq) AS to_seq "
        "FROM events e LEFT JOIN ai_processing_cursors c ON c.channel_id=e.channel_id AND c.kind='observe' AND c.group_key = coalesce(e.chat_window_id::text,'') || ':' || coalesce(e.scene_id::text,'') "
        "WHERE e.channel_id=$1 AND e.seq > coalesce(c.last_seq, 0) AND e.kind IN " + std::string(OBSERVED_KINDS) + " GROUP BY 1,2 ORDER BY min(e.seq)", {channelId});
    for (auto& g : groups) {
        auto r = processGroup(channelId, g["window_id"].asString(), g["scene_id"].asString(), g["from_seq"].asInt64());
        if (!r.isNull()) out.append(r);
    }
    return out;
}

Json::Value ObserverScheduler::processGroup(const std::string& channelId, const std::string& windowId, const std::string& sceneId, int64_t) {
    std::string groupKey = windowId + ":" + sceneId;
    std::string lockKey = channelId + "/" + groupKey;
    if (!tryLock(lockKey)) return Json::Value();           // previous cycle for this group still running
    struct Unlock { ObserverScheduler* s; std::string k; ~Unlock() { s->unlock(k); } } ul{this, lockKey};

    // DB-level task lock + cursor read.
    Json::Value job;
    int64_t lastSeq = 0;
    try {
        job = db_.tx([&](pqxx::work& w) {
            auto c = Db::queryOne(w, "SELECT last_seq FROM ai_processing_cursors WHERE channel_id=$1 AND kind='observe' AND group_key=$2", {channelId, groupKey});
            lastSeq = c.isNull() ? 0 : c["last_seq"].asInt64();
            return Db::queryOne(w, "INSERT INTO ai_jobs(channel_id, kind, group_key, from_seq, llm_mode) VALUES($1,'observe',$2,$3,$4) RETURNING id", {channelId, groupKey, lastSeq, llm_.mode()});
        });
    } catch (const pqxx::unique_violation&) { return Json::Value(); }   // another instance holds the lock
    auto jobId = job["id"].asString();
    auto finish = [&](const std::string& status, const std::string& error, const Json::Value& result, int64_t toSeq, int n, int llmCalls) {
        db_.tx([&](pqxx::work& w) {
            Db::exec(w, "UPDATE ai_jobs SET status=$2, error=$3, result=$4::jsonb, to_seq=$5, event_count=$6, llm_calls=$7, finished_at=now() WHERE id=$1",
                {jobId, status, error.empty() ? dbNull() : DbParam(error), json::dump(result), toSeq, (int64_t)n, (int64_t)llmCalls});
            if (status == "succeeded")
                Db::exec(w, "INSERT INTO ai_processing_cursors(channel_id, kind, group_key, last_seq) VALUES($1,'observe',$2,$3) ON CONFLICT (channel_id, kind, group_key) DO UPDATE SET last_seq=GREATEST(ai_processing_cursors.last_seq, EXCLUDED.last_seq), updated_at=now()",
                    {channelId, groupKey, toSeq});
        });
    };

    Json::Value summary; summary["job_id"] = jobId; summary["group_key"] = groupKey; summary["documents"] = Json::Value(Json::arrayValue); summary["highlights"] = 0; summary["module_hints"] = 0; summary["knowledge_suggestions"] = 0; summary["pending_review"] = 0;
    try {
        // Read the batch strictly after the cursor, bounded.
        auto batch = db_.queryJson(
            "SELECT e.id AS event_id, e.seq, e.kind, e.scene_id, e.actor_role, e.character_id, c.name AS character_name, e.visibility, e.audience, e.payload, e.created_at "
            "FROM events e LEFT JOIN characters c ON c.id=e.character_id WHERE e.channel_id=$1 AND coalesce(e.chat_window_id::text,'')=$2 AND coalesce(e.scene_id::text,'')=$3 AND e.seq > $4 AND e.kind IN " + std::string(OBSERVED_KINDS) + " ORDER BY e.seq LIMIT $5",
            {channelId, windowId, sceneId, lastSeq, (int64_t)cfg_.observerMaxBatch});
        if (batch.empty()) { finish("skipped", "", summary, lastSeq, 0, 0); return Json::Value(); }
        int64_t toSeq = batch[batch.size() - 1]["seq"].asInt64();
        summary["event_count"] = (int)batch.size();
        auto sys = systemAccess(channelId);
        std::vector<std::string> terms;
        auto ctx = buildGroupContext(sys, channelId, windowId, sceneId, batch, terms);

        LlmRequest req; req.task = "observer_extract"; req.system = observerSystemPrompt(); req.responseSchema = observerSchema();
        req.tools = ContextRetrievalService::toolSpecs(true); req.temperature = cfg_.llmTemperature; req.maxTokens = cfg_.llmMaxTokens;
        LlmMessage u; u.role = "user"; u.content = json::dump(ctx); req.messages.push_back(u);
        auto outcome = llm_.runStructured(req, [&](const std::string& name, const Json::Value& args) { return retrieval_.executeTool(sys, name, args); }, 4);
        llmCalls_ += outcome.llmCalls;
        if (!outcome.ok) { finish("failed", outcome.error, summary, lastSeq, (int)batch.size(), outcome.llmCalls); ALOG_WARN << "observer job failed: " << outcome.error; summary["error"] = outcome.error; notifier_.aiJobFinished(channelId, summary); return summary; }
        summary["tool_calls"] = outcome.toolCalls;
        applyExtraction(sys, channelId, jobId, outcome.data, batch, summary);
        suggestKnowledgeSharing(channelId, batch, jobId, summary);
        finish("succeeded", "", summary, toSeq, (int)batch.size(), outcome.llmCalls);
        groupsProcessed_++;
        summary["status"] = "succeeded";
        notifier_.aiJobFinished(channelId, summary);
        return summary;
    } catch (const std::exception& e) {
        ALOG_ERROR << "observer group failed: " << e.what();
        finish("failed", e.what(), summary, lastSeq, 0, 0);
        summary["status"] = "failed"; summary["error"] = e.what();
        return summary;
    }
}

Json::Value ObserverScheduler::buildGroupContext(const ChannelAccess& sys, const std::string& channelId, const std::string& windowId, const std::string& sceneId, const Json::Value& batch, std::vector<std::string>& terms) {
    Json::Value ctx;
    auto ch = db_.queryOne("SELECT knowledge_mode, rule_system, name FROM channels WHERE id=$1", {channelId});
    ctx["channel"] = ch; ctx["chat_window_id"] = windowId;
    Json::Value scene;
    if (!sceneId.empty()) {
        scene = retrieval_.getSceneById(sys, sceneId, 30);
        // Only events strictly before this batch count as prior context.
        Json::Value prior(Json::arrayValue); int64_t firstSeq = batch[0]["seq"].asInt64();
        for (auto& e : scene["log"]) if (e["seq"].asInt64() < firstSeq) prior.append(e);
        scene["log"] = prior; scene.removeMember("facts");
    }
    if (!windowId.empty()) scene["participants"] = db_.queryJson("SELECT c.id AS character_id, c.name, c.kind FROM chat_window_members wm JOIN characters c ON c.id=wm.character_id WHERE wm.chat_window_id=$1", {windowId});
    ctx["scene"] = scene;
    Json::Value evs(Json::arrayValue);
    for (auto& e : batch) {
        Json::Value x; x["event_id"] = e["event_id"]; x["seq"] = e["seq"]; x["kind"] = e["kind"]; x["actor_role"] = e["actor_role"]; x["character_id"] = e["character_id"]; x["character_name"] = e["character_name"];
        x["content"] = e["payload"]["content"]; x["audience"] = e["audience"]; x["visibility"] = e["visibility"]; x["payload"] = e["payload"];
        evs.append(x);
    }
    ctx["new_events"] = evs;
    Json::Value docs(Json::objectValue);
    for (auto& t : DocumentService::coreDocTypes()) docs[t] = retrieval_.documentSnapshot(sys, t, sceneId, 25);
    ctx["documents"] = docs;
    // Term selection for historical retrieval: proper nouns from every event first, then distinctive
    // keywords. Words that merely name the current scene/location or are generic setting nouns are
    // dropped so that "office" or "house" do not light up half the archive.
    static const std::set<std::string> generic = {"office","house","street","room","water","night","morning","afternoon","evening","door","table","window","floor","wall","town","thing","things","people","place","someone","something","everyone","nothing","there","where","again","still","since","yesterday","today","tomorrow","first","second","three","two","investigators","sheriff"};
    std::set<std::string> sceneWords;
    for (auto& w : text::keywords(json::str(scene, "location") + " " + json::str(scene, "title"), 3)) sceneWords.insert(w);
    for (auto& c : db_.queryJson("SELECT name FROM characters WHERE channel_id=$1 AND kind='pc'", {channelId})) { sceneWords.insert(text::lower(c["name"].asString())); for (auto& w : text::words(c["name"].asString())) sceneWords.insert(text::lower(w)); }
    std::vector<std::string> proper, plain; std::set<std::string> seen;
    for (auto& e : batch) {
        auto content = json::str(e["payload"], "content");
        for (auto& n : text::properNouns(content)) { auto l = text::lower(n); if (seen.insert(l).second && !sceneWords.count(l) && !generic.count(l)) proper.push_back(n); }
    }
    for (auto& e : batch) {
        auto content = json::str(e["payload"], "content");
        for (auto& k : text::keywords(content, 5)) if (seen.insert(k).second && !sceneWords.count(k) && !generic.count(k)) plain.push_back(k);
    }
    terms.clear(); for (auto& t : proper) terms.push_back(t); for (auto& t : plain) terms.push_back(t);
    if (terms.size() > 24) terms.resize(24);
    ctx["related_history"] = retrieval_.relatedHistory(sys, terms, sceneId, 12);
    ctx["characters"] = db_.queryJson("SELECT id, name, kind, user_id FROM characters WHERE channel_id=$1", {channelId});
    // Module awareness (GM layer): nodes whose names appear in the new text.
    auto mod = db_.queryOne("SELECT id FROM modules WHERE channel_id=$1 AND status='ready' ORDER BY created_at DESC LIMIT 1", {channelId});
    ctx["has_module"] = !mod.isNull();
    ctx["module_nodes"] = Json::Value(Json::arrayValue);
    ctx["scene_is_off_module"] = false;
    if (!mod.isNull()) {
        std::string all; for (auto& e : batch) all += json::str(e["payload"], "content") + "\n";
        for (auto& n : db_.queryJson("SELECT id AS node_id, name, node_type, progress FROM module_nodes WHERE module_id=$1 AND length(name) >= 4 AND $2 ILIKE '%' || name || '%' LIMIT 10", {mod["id"].asString(), all}))
            ctx["module_nodes"].append(n);
        auto loc = json::str(scene, "location");
        if (!loc.empty()) {
            auto match = db_.queryOne("SELECT id FROM module_nodes WHERE module_id=$1 AND node_type IN ('location','scene') AND (name ILIKE '%' || $2 || '%' OR $2 ILIKE '%' || name || '%' OR similarity(name, $2) > 0.4) LIMIT 1", {mod["id"].asString(), loc});
            ctx["scene_is_off_module"] = match.isNull() || json::toBool(scene, "off_module");
            if (match.isNull() && !sceneId.empty()) db_.exec("UPDATE scenes SET off_module=true WHERE id=$1 AND NOT off_module", {sceneId});
        }
    }
    return ctx;
}

void ObserverScheduler::applyExtraction(const ChannelAccess& sys, const std::string& channelId, const std::string& jobId, const Json::Value& data, const Json::Value& batch, Json::Value& summary) {
    std::vector<std::string> batchIds; for (auto& e : batch) batchIds.push_back(e["event_id"].asString());
    std::string sceneId = json::str(batch[0], "scene_id");
    for (auto& p : data["proposals"]) {
        Proposal pr; pr.channelId = channelId; pr.documentType = json::str(p, "document_type"); pr.ops = p["ops"]; pr.actor = "ai"; pr.aiJobId = jobId;
        pr.sourceEventIds = json::strArray(p["source_event_ids"]); pr.evidence = p["evidence"]; pr.summary = "AI observer: " + std::to_string(pr.ops.size()) + " proposed change(s)";
        if (std::find(DocumentService::coreDocTypes().begin(), DocumentService::coreDocTypes().end(), pr.documentType) == DocumentService::coreDocTypes().end()) continue;
        try {
            auto res = docs_.commit(pr);
            Json::Value d; d["doc_type"] = res.docType; d["version"] = res.version; d["applied"] = res.applied; d["rejected"] = res.rejected; d["pending_review"] = res.pendingReview; d["log"] = res.log;
            summary["documents"].append(d);
            summary["pending_review"] = summary["pending_review"].asInt() + res.pendingReview;
            for (auto& fid : res.touchedFactIds) {
                auto f = db_.queryOne("SELECT summary, data FROM knowledge_facts WHERE id=$1", {fid});
                if (!f.isNull()) retrieval_.indexEmbedding(fid, f["summary"].asString());
            }
        } catch (const ApiError& e) { Json::Value d; d["doc_type"] = pr.documentType; d["error"] = e.what(); summary["documents"].append(d); }
    }
    // Highlights: bind to the entry of the cited fact; scope = the fact's own knowledge scope.
    for (auto& h : data["highlights"]) {
        auto factId = json::str(h, "fact_id");
        if (!Visibility::isUuid(factId)) continue;
        auto entry = db_.queryOne("SELECT de.id AS entry_id, de.document_id, d.gm_only FROM document_entries de JOIN documents d ON d.id=de.document_id JOIN knowledge_facts f ON f.id=de.fact_id WHERE de.fact_id=$1 AND f.channel_id=$2 AND NOT de.removed LIMIT 1", {factId, channelId});
        if (entry.isNull()) continue;
        auto scope = db_.tx([&](pqxx::work& w) { return knowledge_.getScope(w, factId); });
        NewHighlight nh; nh.channelId = channelId; nh.documentId = entry["document_id"].asString(); nh.entryId = entry["entry_id"].asString();
        nh.reason = json::str(h, "reason", "Related to the current conversation"); nh.kind = json::str(h, "kind", "association");
        nh.sourceEventIds = json::strArray(h["source_event_ids"]); nh.priority = json::toInt(h, "priority", 2); nh.ttlSeconds = cfg_.highlightTtlSeconds;
        // Only cite events from this batch (never fabricated ids).
        std::vector<std::string> src; for (auto& s : nh.sourceEventIds) if (std::find(batchIds.begin(), batchIds.end(), s) != batchIds.end()) src.push_back(s); nh.sourceEventIds = src;
        if (entry["gm_only"].asBool() || scope.scope == "gm") { nh.visibilityScope = "gm"; highlights_.create(nh); summary["highlights"] = summary["highlights"].asInt() + 1; }
        else if (scope.scope == "public") { nh.visibilityScope = "public"; highlights_.create(nh); summary["highlights"] = summary["highlights"].asInt() + 1; }
        else { int n = 0; for (auto& c : scope.characterIds) { if (n++ >= 6) break; nh.visibilityScope = "character"; nh.characterId = c; highlights_.create(nh); summary["highlights"] = summary["highlights"].asInt() + 1; } }
    }
    // Module hints are GM-only "potential associations"; never facts.
    auto mod = db_.queryOne("SELECT id FROM modules WHERE channel_id=$1 AND status='ready' ORDER BY created_at DESC LIMIT 1", {channelId});
    for (auto& mh : data["module_hints"]) {
        auto nodeId = json::str(mh, "node_id");
        if (!Visibility::isUuid(nodeId) || mod.isNull()) continue;
        std::vector<std::string> src; for (auto& s : json::strArray(mh["source_event_ids"])) if (std::find(batchIds.begin(), batchIds.end(), s) != batchIds.end()) src.push_back(s);
        auto dup = db_.queryOne("SELECT id FROM module_hints WHERE channel_id=$1 AND node_id=$2 AND status='potential' AND reason=$3", {channelId, nodeId, json::str(mh, "reason")});
        if (!dup.isNull()) continue;
        db_.exec("INSERT INTO module_hints(channel_id, module_id, node_id, reason, source_event_ids) VALUES($1,$2,$3,$4,$5::uuid[])", {channelId, mod["id"].asString(), nodeId, json::str(mh, "reason", "Potential association"), pgArrayLiteral(src)});
        db_.exec("UPDATE module_nodes SET progress = CASE WHEN progress='untouched' THEN 'active' ELSE progress END, progress_event_ids = (SELECT array_agg(DISTINCT x) FROM unnest(progress_event_ids || $2::uuid[]) x), updated_at=now() WHERE id=$1", {nodeId, pgArrayLiteral(src)});
        summary["module_hints"] = summary["module_hints"].asInt() + 1;
        // Surface it on the GM-only Module Progress document as a potential-association highlight when an entry exists.
        auto entry = db_.queryOne("SELECT de.id AS entry_id, de.document_id FROM document_entries de JOIN documents d ON d.id=de.document_id JOIN knowledge_facts f ON f.id=de.fact_id WHERE d.channel_id=$1 AND d.doc_type='module_progress' AND f.data->>'node_id'=$2 AND NOT de.removed ORDER BY de.updated_at DESC LIMIT 1", {channelId, nodeId});
        if (!entry.isNull()) { NewHighlight nh; nh.channelId = channelId; nh.documentId = entry["document_id"].asString(); nh.entryId = entry["entry_id"].asString(); nh.reason = json::str(mh, "reason"); nh.kind = "potential_association"; nh.sourceEventIds = src; nh.visibilityScope = "gm"; nh.ttlSeconds = cfg_.highlightTtlSeconds * 2; highlights_.create(nh); }
    }
    if (!data["module_hints"].empty() && !mod.isNull()) { Json::Value p; p["module_id"] = mod["id"]; p["hints"] = (int)data["module_hints"].size(); notifier_.moduleUpdated(channelId, p); }
    // Scene metadata inferred from GM narration.
    if (data.isMember("scene_update") && data["scene_update"].isObject() && !sceneId.empty()) {
        auto loc = json::str(data["scene_update"], "location"); auto when = json::str(data["scene_update"], "narrative_time");
        if (!loc.empty()) db_.exec("UPDATE scenes SET location=$2 WHERE id=$1 AND location <> $2", {sceneId, loc});
        if (!when.empty()) db_.exec("UPDATE scenes SET narrative_time=$2 WHERE id=$1 AND narrative_time <> $2", {sceneId, when});
        if (!loc.empty() || !when.empty()) notifier_.sceneChanged(channelId, db_.queryOne("SELECT * FROM scenes WHERE id=$1", {sceneId}));
    }
    (void)sys;
}

// Intelligent knowledge grouping (v1): when a character talks about a fact they know in front of
// characters who do not, propose sharing it — the GM confirms or overrides.
void ObserverScheduler::suggestKnowledgeSharing(const std::string& channelId, const Json::Value& batch, const std::string& jobId, Json::Value& summary) {
    auto mode = knowledge_.channelMode(channelId);
    if (mode.isNull() || mode["knowledge_mode"].asString() != "isolated") return;
    for (auto& e : batch) {
        if (json::str(e, "actor_role") != "player" || json::str(e, "visibility") != "window") continue;
        auto speaker = json::str(e, "character_id"); if (speaker.empty()) continue;
        auto audience = json::strArray(e["audience"]);
        std::vector<std::string> others; for (auto& a : audience) if (a != speaker) others.push_back(a);
        if (others.empty()) continue;
        auto content = json::str(e["payload"], "content");
        auto kws = text::keywords(content, 5); if (kws.empty()) continue;
        // Facts the speaker knows privately (character scope) that match the message and that some listener lacks.
        for (auto& f : db_.queryJson("SELECT f.id, f.summary FROM knowledge_facts f WHERE f.channel_id=$1 AND f.status <> 'retracted' AND EXISTS (SELECT 1 FROM knowledge_visibility kv WHERE kv.fact_id=f.id AND kv.scope='character' AND kv.character_id=$2) AND NOT EXISTS (SELECT 1 FROM knowledge_visibility kv WHERE kv.fact_id=f.id AND kv.scope='public') LIMIT 100", {channelId, speaker})) {
            int hits = 0; for (auto& k : kws) if (text::icontains(f["summary"].asString(), k)) hits++;
            if (hits < 2) continue;
            std::vector<std::string> lacking;
            for (auto& o : others) { auto r = db_.queryOne("SELECT 1 AS ok FROM knowledge_visibility WHERE fact_id=$1 AND scope='character' AND character_id=$2", {f["id"].asString(), o}); if (r.isNull()) lacking.push_back(o); }
            if (lacking.empty()) continue;
            Json::Value op; op["op"] = "share_knowledge"; op["fact_id"] = f["id"]; op["character_ids"] = json::fromStrArray(lacking);
            op["reason"] = json::str(e, "character_name", "A character") + " appears to share this in conversation: \"" + text::truncate(content, 120) + "\"";
            Json::Value ops(Json::arrayValue); ops.append(op);
            auto dup = db_.queryOne("SELECT id FROM document_proposals WHERE channel_id=$1 AND status='needs_gm_review' AND ops->0->>'op'='share_knowledge' AND ops->0->>'fact_id'=$2", {channelId, f["id"].asString()});
            if (!dup.isNull()) continue;
            db_.exec("INSERT INTO document_proposals(channel_id, ai_job_id, ops, source_event_ids, status, rejection_reason) VALUES($1,$2,$3::jsonb,$4::uuid[],'needs_gm_review','knowledge sharing suggestion')",
                {channelId, jobId, json::dump(ops), pgArrayLiteral({json::str(e, "event_id")})});
            summary["knowledge_suggestions"] = summary["knowledge_suggestions"].asInt() + 1;
        }
    }
    if (summary["knowledge_suggestions"].asInt() > 0) { Json::Value p; p["kind"] = "knowledge_sharing"; p["count"] = summary["knowledge_suggestions"]; notifier_.proposalPending(channelId, p); }
}

Json::Value ObserverScheduler::consolidateChannel(const std::string& channelId) {
    std::string lockKey = channelId + "/consolidate";
    if (!tryLock(lockKey)) return Json::Value();
    struct Unlock { ObserverScheduler* s; std::string k; ~Unlock() { s->unlock(k); } } ul{this, lockKey};
    Json::Value job;
    int64_t lastSeq = 0, maxSeq = events_.maxSeq(channelId);
    auto c = db_.queryOne("SELECT last_seq FROM ai_processing_cursors WHERE channel_id=$1 AND kind='consolidate' AND group_key=''", {channelId});
    lastSeq = c.isNull() ? 0 : c["last_seq"].asInt64();
    if (maxSeq <= lastSeq) return Json::Value();           // nothing new since last consolidation → no LLM call
    try { job = db_.queryOne("INSERT INTO ai_jobs(channel_id, kind, group_key, from_seq, llm_mode) VALUES($1,'consolidate','',$2,$3) RETURNING id", {channelId, lastSeq, llm_.mode()}); }
    catch (const pqxx::unique_violation&) { return Json::Value(); }
    auto jobId = job["id"].asString();
    Json::Value summary; summary["job_id"] = jobId; summary["kind"] = "consolidate"; summary["documents"] = Json::Value(Json::arrayValue);
    try {
        auto sys = systemAccess(channelId);
        Json::Value ctx; Json::Value docs(Json::objectValue);
        for (auto& t : DocumentService::coreDocTypes()) docs[t] = retrieval_.documentSnapshot(sys, t, "", 80);
        ctx["documents"] = docs; ctx["channel_id"] = channelId;
        LlmRequest req; req.task = "consolidate"; req.responseSchema = consolidateSchema(); req.temperature = cfg_.llmTemperature;
        req.system = "You are the low-frequency consolidation pass of a TRPG campaign chronicler. Review the documents and propose ONLY structural maintenance: resolve threads that later confirmed records answer (cite the confirming source_event_ids), merge duplicate relationships, and flag long timelines. Never add new facts, never change confirmed records. Reply with JSON {\"proposals\":[{\"document_type\":..., \"ops\":[...]}], \"notes\":[...]}.";
        LlmMessage u; u.role = "user"; u.content = json::dump(ctx); req.messages.push_back(u);
        auto outcome = llm_.runStructured(req, nullptr, 2);
        llmCalls_ += outcome.llmCalls;
        if (!outcome.ok) throw std::runtime_error(outcome.error);
        for (auto& p : outcome.data["proposals"]) {
            Proposal pr; pr.channelId = channelId; pr.documentType = json::str(p, "document_type"); pr.ops = p["ops"]; pr.actor = "ai"; pr.aiJobId = jobId; pr.summary = "AI consolidation";
            try { auto res = docs_.commit(pr); Json::Value d; d["doc_type"] = res.docType; d["applied"] = res.applied; d["rejected"] = res.rejected; d["pending_review"] = res.pendingReview; summary["documents"].append(d); }
            catch (const ApiError& e) { Json::Value d; d["doc_type"] = pr.documentType; d["error"] = e.what(); summary["documents"].append(d); }
        }
        summary["notes"] = outcome.data["notes"];
        db_.tx([&](pqxx::work& w) {
            Db::exec(w, "UPDATE ai_jobs SET status='succeeded', result=$2::jsonb, to_seq=$3, llm_calls=$4, finished_at=now() WHERE id=$1", {jobId, json::dump(summary), maxSeq, (int64_t)outcome.llmCalls});
            Db::exec(w, "INSERT INTO ai_processing_cursors(channel_id, kind, group_key, last_seq) VALUES($1,'consolidate','',$2) ON CONFLICT (channel_id, kind, group_key) DO UPDATE SET last_seq=EXCLUDED.last_seq, updated_at=now()", {channelId, maxSeq});
        });
        summary["status"] = "succeeded";
        notifier_.aiJobFinished(channelId, summary);
    } catch (const std::exception& e) {
        db_.exec("UPDATE ai_jobs SET status='failed', error=$2, finished_at=now() WHERE id=$1", {jobId, std::string(e.what())});
        summary["status"] = "failed"; summary["error"] = e.what();
    }
    return summary;
}

Json::Value ObserverScheduler::status() const {
    Json::Value s; s["running"] = running_.load(); s["enabled"] = cfg_.observerEnabled; s["interval_ms"] = cfg_.observerIntervalMs; s["consolidate_interval_ms"] = cfg_.consolidatorIntervalMs;
    s["ticks"] = ticks_.load(); s["groups_processed"] = groupsProcessed_.load(); s["llm_calls"] = llmCalls_.load(); s["llm"] = llm_.status(); return s;
}
Json::Value ObserverScheduler::listJobs(const std::string& channelId, int limit) {
    return db_.queryJson("SELECT id, kind, group_key, status, from_seq, to_seq, event_count, llm_calls, llm_mode, error, result, started_at, finished_at FROM ai_jobs WHERE channel_id=$1 ORDER BY started_at DESC LIMIT $2", {channelId, (int64_t)std::max(1, std::min(limit, 100))});
}

std::string ObserverScheduler::observerSystemPrompt() {
    return R"(You are the silent background chronicler of a Call of Cthulhu / BRP tabletop campaign. You never speak to the players. You read a batch of new chat events and propose structured, incremental updates to six living documents: current_scene, clue_journal, relationships, open_threads, timeline, module_progress (GM-only).

Rules:
- Raw events are the only source of truth. Every op MUST cite source_event_ids from the batch you were given. Never invent ids.
- Distinguish epistemic status precisely: a character attempting something = "attempted"; the GM declaring it happened = "confirmed"; an NPC asserting something = "npc_claim"; a player theory = "hypothesis"; your own inference = "ai_inferred". Only GM-authored events justify "confirmed".
- Never record speculation as fact. Never write module secrets into player-visible documents. Never author plot.
- Prefer small incremental ops (add_entry, update_entry, set_status, append_text, add_relation, link_facts, remove_entry) over rewriting. Reuse existing fact_id values from the provided document snapshots when updating.
- When new text refers back to something recorded in an earlier scene (see related_history, or use the search tools), emit a highlight on that fact_id with a short reason and the event ids that triggered it.
- If play touches module elements (module_nodes) or leaves the module, propose module_progress entries and module_hints marked as potential associations; do not treat the module as what actually happened.
- Use the retrieval tools when you need older history; the current scene is already provided.

Output strictly this JSON shape:
{"proposals":[{"document_type":"clue_journal","ops":[{"op":"add_entry","fact":{"summary":"...","status":"confirmed","data":{...},"source_event_ids":["..."],"entities":[{"name":"...","kind":"npc|location|item|organisation|pc"}]}}]}],
 "highlights":[{"fact_id":"...","reason":"...","source_event_ids":["..."],"kind":"association"}],
 "module_hints":[{"node_id":"...","reason":"...","source_event_ids":["..."]}],
 "scene_update":{"location":"...","narrative_time":"..."}}
Data conventions: clue -> {title, source, discovered_by, handed_over:bool}; relationship -> {from, from_kind, to, to_kind, relation}; thread -> {title, thread_kind: question|foreshadowing|promise|agreement|deadline}; timeline -> {when}; scene_state -> {facet: location|action|event|npc_statement|status}; module_progress -> {node_id, node_name, node_type, progress}.)";
}

Json::Value ObserverScheduler::observerSchema() {
    static Json::Value s = json::parse(R"({
      "type":"object","required":["proposals"],
      "properties":{
        "proposals":{"type":"array","items":{"type":"object","required":["document_type","ops"],"properties":{
          "document_type":{"type":"string","enum":["current_scene","clue_journal","relationships","open_threads","timeline","module_progress"]},
          "ops":{"type":"array","items":{"type":"object","required":["op"],"properties":{"op":{"type":"string"},"fact":{"type":"object"},"fact_id":{"type":"string"},"status":{"type":"string"},"source_event_ids":{"type":"array","items":{"type":"string"}}}}},
          "source_event_ids":{"type":"array","items":{"type":"string"}}}}},
        "highlights":{"type":"array","items":{"type":"object","required":["fact_id","reason"],"properties":{"fact_id":{"type":"string"},"reason":{"type":"string"},"source_event_ids":{"type":"array","items":{"type":"string"}},"kind":{"type":"string"}}}},
        "module_hints":{"type":"array","items":{"type":"object","required":["node_id","reason"],"properties":{"node_id":{"type":"string"},"reason":{"type":"string"}}}},
        "scene_update":{"type":"object","properties":{"location":{"type":"string"},"narrative_time":{"type":"string"}}},
        "knowledge_suggestions":{"type":"array"}
      }})");
    return s;
}
Json::Value ObserverScheduler::consolidateSchema() {
    static Json::Value s = json::parse(R"({"type":"object","required":["proposals"],"properties":{"proposals":{"type":"array","items":{"type":"object","required":["document_type","ops"],"properties":{"document_type":{"type":"string"},"ops":{"type":"array"}}}},"notes":{"type":"array"}}})");
    return s;
}

} // namespace acerciae
