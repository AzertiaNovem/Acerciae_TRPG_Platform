#include "ModuleImporter.h"
#include "../llm/LlmGateway.h"
#include "../ws/Notifier.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../core/Log.h"
#include "../core/Crypto.h"
#include "../knowledge/Visibility.h"
#include <poppler-document.h>
#include <poppler-page.h>
#include <filesystem>
#include <fstream>
#include <map>
#include <thread>

namespace acerciae {

std::vector<std::string> ModuleImporter::extractPdfText(const std::string& bytes) {
    std::vector<char> buf(bytes.begin(), bytes.end());
    std::unique_ptr<poppler::document> doc(poppler::document::load_from_raw_data(buf.data(), (int)buf.size()));
    if (!doc) throw badRequest("could not parse PDF");
    if (doc->is_locked()) throw badRequest("PDF is password protected");
    std::vector<std::string> pages;
    int n = doc->pages();
    if (n > 600) throw badRequest("PDF has too many pages (max 600)");
    for (int i = 0; i < n; ++i) {
        std::unique_ptr<poppler::page> p(doc->create_page(i));
        std::string t;
        if (p) { auto u = p->text().to_utf8(); t.assign(u.begin(), u.end()); }
        pages.push_back(t);
    }
    return pages;
}

Json::Value ModuleImporter::structureSchema() {
    static Json::Value s = json::parse(R"({"type":"object","required":["nodes"],"properties":{
      "nodes":{"type":"array","items":{"type":"object","required":["key","node_type","name"],"properties":{"key":{"type":"string"},"node_type":{"type":"string","enum":["npc","location","item","clue","secret","stage","scene","condition","twist","ending"]},"name":{"type":"string"},"description":{"type":"string"},"citations":{"type":"array","items":{"type":"object","required":["page"],"properties":{"page":{"type":"integer"},"excerpt":{"type":"string"}}}}}}},
      "edges":{"type":"array","items":{"type":"object","required":["from_key","to_key","relation"],"properties":{"from_key":{"type":"string"},"to_key":{"type":"string"},"relation":{"type":"string"}}}}}})");
    return s;
}

Json::Value ModuleImporter::importPdf(const ChannelAccess& a, const std::string& fileName, const std::string& bytes, const std::string& title) {
    if (!a.isGm) throw forbidden("GM role required");
    if (bytes.size() < 5 || bytes.compare(0, 5, "%PDF-") != 0) throw badRequest("file is not a PDF");
    if (bytes.size() > cfg_.maxUploadMb * 1024 * 1024) throw badRequest("file exceeds upload limit");
    std::filesystem::create_directories(cfg_.uploadDir);
    auto safeName = crypto::uuid4() + ".pdf";
    auto path = (std::filesystem::path(cfg_.uploadDir) / safeName).string();
    { std::ofstream out(path, std::ios::binary); out.write(bytes.data(), (std::streamsize)bytes.size()); }
    auto row = db_.queryOne("INSERT INTO modules(channel_id, title, file_name, file_path, status, llm_mode, uploaded_by) VALUES($1,$2,$3,$4,'uploaded',$5,$6) RETURNING *",
        {a.channelId, title.empty() ? fileName : title, fileName.substr(0, 200), path, llm_.mode(a.channelId), a.userId});
    auto id = row["id"].asString();
    std::thread([this, id] { try { process(id); } catch (const std::exception& e) { ALOG_ERROR << "module import failed: " << e.what(); } }).detach();
    return row;
}

Json::Value ModuleImporter::importText(const ChannelAccess& a, const std::string& title, const std::vector<std::string>& pages) {
    if (!a.isGm) throw forbidden("GM role required");
    if (pages.empty()) throw badRequest("no text");
    auto row = db_.queryOne("INSERT INTO modules(channel_id, title, file_name, status, llm_mode, uploaded_by, page_count) VALUES($1,$2,'(text import)','extracting',$3,$4,$5) RETURNING *",
        {a.channelId, title.empty() ? "Imported module" : title, llm_.mode(a.channelId), a.userId, (int64_t)pages.size()});
    auto id = row["id"].asString();
    db_.tx([&](pqxx::work& w) { for (size_t i = 0; i < pages.size(); ++i) Db::exec(w, "INSERT INTO module_pages(module_id, page_number, text) VALUES($1,$2,$3)", {id, (int64_t)(i + 1), pages[i]}); });
    process(id);
    return get(a, id);
}

void ModuleImporter::process(const std::string& moduleId) {
    auto m = db_.queryOne("SELECT * FROM modules WHERE id=$1", {moduleId});
    if (m.isNull()) return;
    auto channelId = m["channel_id"].asString();
    try {
        if (m["status"].asString() == "uploaded") {
            db_.exec("UPDATE modules SET status='extracting', updated_at=now() WHERE id=$1", {moduleId});
            std::ifstream in(m["file_path"].asString(), std::ios::binary); std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
            auto pages = extractPdfText(bytes);
            db_.tx([&](pqxx::work& w) {
                Db::exec(w, "DELETE FROM module_pages WHERE module_id=$1", {moduleId});
                for (size_t i = 0; i < pages.size(); ++i) Db::exec(w, "INSERT INTO module_pages(module_id, page_number, text) VALUES($1,$2,$3)", {moduleId, (int64_t)(i + 1), pages[i]});
                Db::exec(w, "UPDATE modules SET page_count=$2, updated_at=now() WHERE id=$1", {moduleId, (int64_t)pages.size()});
            });
        }
        db_.exec("UPDATE modules SET status='structuring', updated_at=now() WHERE id=$1", {moduleId});
        auto pages = db_.queryJson("SELECT page_number AS page, text FROM module_pages WHERE module_id=$1 ORDER BY page_number", {moduleId});
        structurePages(moduleId, channelId, pages);
        db_.exec("UPDATE modules SET status='ready', error=NULL, updated_at=now() WHERE id=$1", {moduleId});
        Json::Value p; p["module_id"] = moduleId; p["status"] = "ready"; notifier_.moduleUpdated(channelId, p);
    } catch (const std::exception& e) {
        db_.exec("UPDATE modules SET status='failed', error=$2, updated_at=now() WHERE id=$1", {moduleId, std::string(e.what())});
        Json::Value p; p["module_id"] = moduleId; p["status"] = "failed"; p["error"] = e.what(); notifier_.moduleUpdated(channelId, p);
    }
}

void ModuleImporter::structurePages(const std::string& moduleId, const std::string& channelId, const Json::Value& pages) {
    // Chunk pages so each model call stays within a sane context; keys are global so chunks can link.
    const size_t chunkChars = 12000;
    std::vector<Json::Value> chunks; Json::Value cur(Json::arrayValue); size_t curSize = 0;
    for (auto& p : pages) {
        auto t = json::str(p, "text"); if (text::trim(t).empty()) continue;
        if (curSize + t.size() > chunkChars && !cur.empty()) { chunks.push_back(cur); cur = Json::Value(Json::arrayValue); curSize = 0; }
        cur.append(p); curSize += t.size();
    }
    if (!cur.empty()) chunks.push_back(cur);
    std::map<std::string, std::string> keyToId;   // node key -> id
    std::vector<Json::Value> pendingEdges;
    db_.exec("DELETE FROM module_nodes WHERE module_id=$1", {moduleId});   // re-import replaces graph (edges cascade)
    int chunkIdx = 0;
    for (auto& chunk : chunks) {
        chunkIdx++;
        LlmRequest req; req.channelId = channelId; req.task = "module_structure"; req.responseSchema = structureSchema(); req.temperature = 0.1; req.maxTokens = 4096;
        req.system = R"(You convert tabletop RPG module text (Call of Cthulhu / BRP) into a conditional knowledge graph. Extract nodes of type npc, location, item, clue, secret, stage, scene, condition, twist, ending and edges (requires, reveals, leads_to, located_in, knows, holds, unlocks, triggers, found_in, takes_place_at, appears_in). Every node MUST cite page numbers and a short verbatim excerpt. Keys are stable slugs like "npc|sheriff dunmore" so later chunks can reference earlier nodes. Do not invent content that is not in the text. Output JSON {"nodes":[{"key","node_type","name","description","citations":[{"page","excerpt"}]}],"edges":[{"from_key","to_key","relation"}]})";
        Json::Value ctx; ctx["pages"] = chunk; ctx["chunk"] = chunkIdx; ctx["total_chunks"] = (int)chunks.size();
        Json::Value known(Json::arrayValue); for (auto& [k, id] : keyToId) known.append(k); ctx["known_keys"] = known;
        LlmMessage u; u.role = "user"; u.content = json::dump(ctx); req.messages.push_back(u);
        auto outcome = llm_.runStructured(req, nullptr, 2);
        if (!outcome.ok) throw std::runtime_error("structuring failed on chunk " + std::to_string(chunkIdx) + ": " + outcome.error);
        db_.tx([&](pqxx::work& w) {
            for (auto& n : outcome.data["nodes"]) {
                auto key = json::str(n, "key"); if (key.empty()) key = json::str(n, "node_type") + "|" + text::lower(json::str(n, "name"));
                Json::Value cits = n["citations"].isArray() ? n["citations"] : Json::Value(Json::arrayValue);
                if (keyToId.count(key)) {
                    Db::exec(w, "UPDATE module_nodes SET citations = citations || $2::jsonb, description = CASE WHEN length(description) < length($3) THEN $3 ELSE description END, updated_at=now() WHERE id=$1", {keyToId[key], json::dump(cits), json::str(n, "description")});
                    continue;
                }
                Json::Value data = n.isMember("data") && n["data"].isObject() ? n["data"] : Json::Value(Json::objectValue); data["key"] = key;
                auto row = Db::queryOne(w, "INSERT INTO module_nodes(module_id, channel_id, node_type, name, description, data, citations) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id",
                    {moduleId, channelId, json::str(n, "node_type", "clue"), text::truncate(json::str(n, "name"), 160), json::str(n, "description"), json::dump(data), json::dump(cits)});
                keyToId[key] = row["id"].asString();
            }
            for (auto& e : outcome.data["edges"]) pendingEdges.push_back(e);
        });
    }
    db_.tx([&](pqxx::work& w) {
        for (auto& e : pendingEdges) {
            auto f = keyToId.find(json::str(e, "from_key")), t = keyToId.find(json::str(e, "to_key"));
            if (f == keyToId.end() || t == keyToId.end() || f->second == t->second) continue;
            Db::exec(w, "INSERT INTO module_edges(module_id, from_node_id, to_node_id, relation) VALUES($1,$2,$3,$4)", {moduleId, f->second, t->second, json::str(e, "relation", "related")});
        }
    });
}

Json::Value ModuleImporter::list(const ChannelAccess& a) {
    if (!a.isGm) throw forbidden("GM role required");
    return db_.queryJson("SELECT m.id, m.title, m.file_name, m.page_count, m.status, m.error, m.llm_mode, m.created_at, m.updated_at, (SELECT count(*) FROM module_nodes n WHERE n.module_id=m.id) AS node_count, (SELECT count(*) FROM module_edges e WHERE e.module_id=m.id) AS edge_count FROM modules m WHERE m.channel_id=$1 ORDER BY m.created_at DESC", {a.channelId});
}
Json::Value ModuleImporter::get(const ChannelAccess& a, const std::string& moduleId) {
    if (!a.isGm) throw forbidden("GM role required");
    auto m = db_.queryOne("SELECT id, channel_id, title, file_name, page_count, status, error, llm_mode, created_at, updated_at FROM modules WHERE id=$1 AND channel_id=$2", {moduleId, a.channelId});
    if (m.isNull()) throw notFound("module not found");
    m["nodes"] = db_.queryJson("SELECT n.*, (SELECT count(*) FROM module_hints h WHERE h.node_id=n.id AND h.status='potential') AS pending_hints FROM module_nodes n WHERE n.module_id=$1 ORDER BY array_position(ARRAY['stage','scene','location','npc','clue','item','secret','condition','twist','ending'], n.node_type), n.created_at", {moduleId});
    m["edges"] = db_.queryJson("SELECT e.id, e.from_node_id, e.to_node_id, e.relation, f.name AS from_name, t.name AS to_name FROM module_edges e JOIN module_nodes f ON f.id=e.from_node_id JOIN module_nodes t ON t.id=e.to_node_id WHERE e.module_id=$1", {moduleId});
    m["progress"] = db_.queryJson("SELECT progress, count(*) AS n FROM module_nodes WHERE module_id=$1 GROUP BY progress", {moduleId});
    return m;
}
Json::Value ModuleImporter::page(const ChannelAccess& a, const std::string& moduleId, int pageNumber) {
    if (!a.isGm) throw forbidden("GM role required");
    auto p = db_.queryOne("SELECT p.module_id, p.page_number, p.text FROM module_pages p JOIN modules m ON m.id=p.module_id WHERE p.module_id=$1 AND m.channel_id=$2 AND p.page_number=$3", {moduleId, a.channelId, (int64_t)pageNumber});
    if (p.isNull()) throw notFound("page not found");
    return p;
}
Json::Value ModuleImporter::updateNode(const ChannelAccess& a, const std::string& nodeId, const Json::Value& body) {
    if (!a.isGm) throw forbidden("GM role required");
    auto n = db_.queryOne("SELECT * FROM module_nodes WHERE id=$1 AND channel_id=$2", {nodeId, a.channelId});
    if (n.isNull()) throw notFound("node not found");
    auto progress = json::str(body, "progress", n["progress"].asString());
    static const std::set<std::string> prog = {"untouched","active","revealed","completed","skipped"};
    if (!prog.count(progress)) throw badRequest("invalid progress");
    auto type = json::str(body, "node_type", n["node_type"].asString());
    static const std::set<std::string> types = {"npc","location","item","clue","secret","stage","scene","condition","twist","ending"};
    if (!types.count(type)) throw badRequest("invalid node_type");
    auto row = db_.queryOne("UPDATE module_nodes SET name=$2, description=$3, node_type=$4, progress=$5, gm_edited=true, updated_at=now() WHERE id=$1 RETURNING *",
        {nodeId, json::str(body, "name", n["name"].asString()), json::str(body, "description", n["description"].asString()), type, progress});
    Json::Value p; p["module_id"] = row["module_id"]; p["node_id"] = nodeId; notifier_.moduleUpdated(a.channelId, p);
    return row;
}
Json::Value ModuleImporter::listHints(const ChannelAccess& a, const std::string& status) {
    if (!a.isGm) throw forbidden("GM role required");
    std::string sql = "SELECT h.*, n.name AS node_name, n.node_type, f.summary AS fact_summary FROM module_hints h LEFT JOIN module_nodes n ON n.id=h.node_id LEFT JOIN knowledge_facts f ON f.id=h.fact_id WHERE h.channel_id=$1";
    DbParams p{a.channelId};
    if (!status.empty()) { sql += " AND h.status=$2"; p.push_back(status); }
    sql += " ORDER BY h.created_at DESC LIMIT 100";
    return db_.queryJson(sql, p);
}
Json::Value ModuleImporter::decideHint(const ChannelAccess& a, const std::string& hintId, const std::string& decision) {
    if (!a.isGm) throw forbidden("GM role required");
    if (decision != "accepted" && decision != "dismissed") throw badRequest("decision must be accepted or dismissed");
    auto h = db_.queryOne("UPDATE module_hints SET status=$3 WHERE id=$1 AND channel_id=$2 RETURNING *", {hintId, a.channelId, decision});
    if (h.isNull()) throw notFound("hint not found");
    if (decision == "accepted" && !h["node_id"].isNull()) db_.exec("UPDATE module_nodes SET progress = CASE WHEN progress IN ('untouched','active') THEN 'revealed' ELSE progress END, updated_at=now() WHERE id=$1", {h["node_id"].asString()});
    return h;
}
Json::Value ModuleImporter::gmWorkspace(const ChannelAccess& a) {
    if (!a.isGm) throw forbidden("GM role required");
    Json::Value w;
    w["modules"] = list(a);
    w["scenes"] = db_.queryJson("SELECT s.id, s.title, s.location, s.narrative_time, s.status, s.off_module, s.module_node_id, n.name AS module_node_name, (SELECT count(*) FROM events e WHERE e.scene_id=s.id) AS event_count FROM scenes s LEFT JOIN module_nodes n ON n.id=s.module_node_id WHERE s.channel_id=$1 ORDER BY s.sequence", {a.channelId});
    w["pending_hints"] = listHints(a, "potential");
    w["pending_proposals"] = db_.queryJson("SELECT p.id, p.document_id, d.doc_type, p.ops, p.rejection_reason, p.source_event_ids, p.created_at FROM document_proposals p LEFT JOIN documents d ON d.id=p.document_id WHERE p.channel_id=$1 AND p.status='needs_gm_review' AND (p.document_id IS NULL OR d.player_group_id IS NULL) ORDER BY p.created_at DESC LIMIT 50", {a.channelId});
    w["node_progress"] = db_.queryJson("SELECT n.node_type, n.progress, count(*) AS n FROM module_nodes n JOIN modules m ON m.id=n.module_id WHERE m.channel_id=$1 AND m.status='ready' GROUP BY 1,2 ORDER BY 1,2", {a.channelId});
    w["gm_secrets"] = db_.queryJson("SELECT f.id, f.kind, f.summary, f.status FROM knowledge_facts f WHERE f.channel_id=$1 AND f.status <> 'retracted' AND f.player_group_id IS NULL ORDER BY f.updated_at DESC LIMIT 50", {a.channelId});
    w["recent_jobs"] = db_.queryJson("SELECT id, kind, group_key, status, event_count, llm_calls, llm_mode, error, started_at, finished_at FROM ai_jobs WHERE channel_id=$1 ORDER BY started_at DESC LIMIT 15", {a.channelId});
    return w;
}

} // namespace acerciae
