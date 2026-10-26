// Core unit tests: no database required.
#include "core/Text.h"
#include "core/Json.h"
#include "core/Crypto.h"
#include "core/Db.h"
#include "llm/SchemaValidator.h"
#include "llm/MockLlmClient.h"
#include "llm/LlmGateway.h"
#include "knowledge/KnowledgeService.h"
#include "documents/DocumentService.h"
#include <iostream>
#include <functional>
#include <vector>

using namespace acerciae;
static int failures = 0, passed = 0;
#define CHECK(cond) do { if (!(cond)) { std::cerr << "  FAIL " << __FILE__ << ":" << __LINE__ << " " #cond "\n"; failures++; } else passed++; } while (0)
static void test(const char* name, std::function<void()> fn) { std::cout << "- " << name << "\n"; try { fn(); } catch (const std::exception& e) { std::cerr << "  EXCEPTION " << e.what() << "\n"; failures++; } }

int main() {
    test("text utilities", [] {
        auto kw = text::keywords("The Sheriff promised to bring the lighthouse key tomorrow.");
        CHECK(std::find(kw.begin(), kw.end(), "sheriff") != kw.end());
        CHECK(std::find(kw.begin(), kw.end(), "lighthouse") != kw.end());
        CHECK(std::find(kw.begin(), kw.end(), "the") == kw.end());
        auto pn = text::properNouns("I walk to the Blackwater Docks and meet Jonah Pike at midnight.");
        CHECK(std::find(pn.begin(), pn.end(), "Blackwater Docks") != pn.end());
        CHECK(std::find(pn.begin(), pn.end(), "Jonah Pike") != pn.end());
        auto q = text::quotedSpeech("He smiles. \"I promise I'll bring the key.\" Then: “Stay off the water.”");
        CHECK(q.size() == 2);
        CHECK(q[0] == "I promise I'll bring the key.");
        CHECK(text::icontains("Tarnished BADGE", "badge"));
    });
    test("password hashing", [] {
        auto h = crypto::hashPassword("secret-pw");
        CHECK(crypto::verifyPassword("secret-pw", h));
        CHECK(!crypto::verifyPassword("wrong", h));
        CHECK(crypto::uuid4().size() == 36);
    });
    test("pg array literal escaping", [] {
        CHECK(pgArrayLiteral({"a", "b\"c"}) == "{\"a\",\"b\\\"c\"}");
        CHECK(pgArrayLiteral({}) == "{}");
    });
    test("schema validator", [] {
        auto schema = json::parse(R"({"type":"object","required":["score","conflicts"],"properties":{"score":{"type":["integer","null"],"minimum":0,"maximum":100},"conflicts":{"type":"array","items":{"type":"object","required":["description"]}},"mode":{"type":"string","enum":["a","b"]}}})");
        std::vector<std::string> errs;
        CHECK(SchemaValidator::validate(schema, json::parse(R"({"score":50,"conflicts":[{"description":"x"}]})"), errs));
        CHECK(SchemaValidator::validate(schema, json::parse(R"({"score":null,"conflicts":[]})"), errs));
        errs.clear(); CHECK(!SchemaValidator::validate(schema, json::parse(R"({"score":150,"conflicts":[]})"), errs)); CHECK(!errs.empty());
        errs.clear(); CHECK(!SchemaValidator::validate(schema, json::parse(R"({"conflicts":[{"x":1}]})"), errs)); CHECK(errs.size() == 2);
        errs.clear(); CHECK(!SchemaValidator::validate(schema, json::parse(R"({"score":1,"conflicts":[],"mode":"c"})"), errs));
    });
    test("knowledge scope algebra", [] {
        KnowledgeScope pub{"public", {}}, gm{"gm", {}}, c1{"character", {"a", "b"}}, c2{"character", {"b", "c"}};
        CHECK(gm.narrowerThan(pub)); CHECK(!pub.narrowerThan(gm)); CHECK(c1.narrowerThan(pub)); CHECK(!c1.narrowerThan(c2));
        auto i = c1.intersect(c2); CHECK(i.scope == "character" && i.characterIds.size() == 1 && i.characterIds[0] == "b");
        auto e = KnowledgeScope{"character", {"a"}}.intersect(KnowledgeScope{"character", {"c"}}); CHECK(e.scope == "gm");
        CHECK(pub.intersect(c1).scope == "character");
    });
    test("mock observer extraction distinguishes attempt / confirmation / claim / hypothesis", [] {
        Json::Value ctx; ctx["scene"]["id"] = "s1"; ctx["scene"]["location"] = "Sheriff's Office"; ctx["scene"]["participants"] = Json::Value(Json::arrayValue);
        Json::Value p; p["name"] = "Nora Blake"; p["character_id"] = "c1"; ctx["scene"]["participants"].append(p);
        ctx["characters"] = Json::Value(Json::arrayValue); Json::Value ch; ch["name"] = "Nora Blake"; ch["kind"] = "pc"; ctx["characters"].append(ch);
        ctx["related_history"] = Json::Value(Json::arrayValue); ctx["module_nodes"] = Json::Value(Json::arrayValue);
        auto ev = [&](const std::string& id, const std::string& role, const std::string& who, const std::string& content) { Json::Value e; e["event_id"] = id; e["actor_role"] = role; e["character_name"] = who; e["kind"] = "message.posted"; e["content"] = content; ctx["new_events"].append(e); };
        ev("e1", "player", "Nora Blake", "I try the editor's safe. I pick the lock.");
        ev("e2", "gm", "", "The safe clicks open. Inside, Nora discovers secret documents: a ledger of payments from the Lantern Society to Sheriff Dunmore.");
        ev("e3", "gm", "", "Dunmore smiles. \"I promise I'll look for the key and bring it to you.\"");
        ev("e4", "player", "Nora Blake", "Maybe the Sheriff is hiding something.");
        auto out = MockLlmClient::observerExtract(ctx);
        std::map<std::string, Json::Value> docs; for (auto& pr : out["proposals"]) docs[pr["document_type"].asString()] = pr["ops"];
        bool attempted = false, confirmedClue = false, promise = false, hypothesis = false;
        for (auto& op : docs["current_scene"]) if (op["fact"]["status"] == "attempted" && op["fact"]["source_event_ids"][0] == "e1") attempted = true;
        for (auto& op : docs["clue_journal"]) if (op["fact"]["status"] == "confirmed" && op["fact"]["source_event_ids"][0] == "e2") confirmedClue = true;
        for (auto& op : docs["relationships"]) if (op["fact"]["data"]["relation"] == "promised" && op["fact"]["status"] == "npc_claim") promise = true;
        for (auto& op : docs["open_threads"]) if (op["fact"]["status"] == "hypothesis") hypothesis = true;
        CHECK(attempted); CHECK(confirmedClue); CHECK(promise); CHECK(hypothesis);
        // every op cites a source event from the batch
        for (auto& [d, ops] : docs) for (auto& op : ops) { auto src = op.isMember("fact") ? op["fact"]["source_event_ids"] : op["source_event_ids"]; CHECK(src.isArray() && !src.empty()); }
    });
    test("mock observer highlights historical foreshadowing", [] {
        Json::Value ctx; ctx["scene"]["id"] = "s3"; ctx["scene"]["location"] = "Hale Boarding House"; ctx["characters"] = Json::Value(Json::arrayValue); ctx["module_nodes"] = Json::Value(Json::arrayValue);
        Json::Value h; h["fact_id"] = "f-badge"; h["document_type"] = "clue_journal"; h["summary"] = "a tarnished badge with a lantern sigil"; h["scene_title"] = "Session 1"; h["matched_terms"].append("badge"); ctx["related_history"].append(h);
        Json::Value e; e["event_id"] = "e9"; e["actor_role"] = "player"; e["character_name"] = "Thomas Reed"; e["kind"] = "message.posted"; e["content"] = "I put the tarnished badge on the table."; ctx["new_events"].append(e);
        auto out = MockLlmClient::observerExtract(ctx);
        CHECK(out["highlights"].size() == 1); CHECK(out["highlights"][0]["fact_id"] == "f-badge"); CHECK(out["highlights"][0]["source_event_ids"][0] == "e9");
        bool appended = false; for (auto& pr : out["proposals"]) if (pr["document_type"] == "clue_journal") for (auto& op : pr["ops"]) if (op["op"] == "append_text" && op["fact_id"] == "f-badge") appended = true;
        CHECK(appended);
    });
    test("mock consistency flags promised-but-not-delivered item", [] {
        Json::Value ctx; ctx["draft"] = "I take out the key that the Sheriff gave me last week and unlock the basement.";
        ctx["character"]["name"] = "Harvey Walters"; ctx["scene"]["location"] = "Hale Boarding House"; ctx["rule_system"] = "coc7e";
        Json::Value f; f["fact_id"] = "f1"; f["kind"] = "relationship"; f["summary"] = "Sheriff Amos Dunmore promises Harvey Walters: \"I promise I'll look for it and bring you the key\""; f["status"] = "npc_claim"; f["data"]["relation"] = "promised"; ctx["known_facts"].append(f);
        auto out = MockLlmClient::consistency(ctx);
        CHECK(!out["insufficient_evidence"].asBool()); CHECK(out["score"].asInt() < 70); CHECK(out["conflicts"].size() >= 1);
        CHECK(out["conflicts"][0]["evidence_fact_ids"][0] == "f1");
        Json::Value ctx2 = ctx; ctx2["known_facts"] = Json::Value(Json::arrayValue); ctx2["draft"] = "I whistle a tune.";
        auto out2 = MockLlmClient::consistency(ctx2);
        CHECK(out2["insufficient_evidence"].asBool()); CHECK(out2["score"].isNull());
    });
    test("mock inspiration uses only known facts and never auto-sends", [] {
        Json::Value ctx; ctx["character"]["name"] = "Nora Blake"; ctx["character"]["speaking_style"] = "blunt"; ctx["scene"]["location"] = "Gazette Office";
        Json::Value m; m["actor_role"] = "gm"; m["content"] = "Dunmore says, \"Nobody goes out there now.\""; ctx["recent_messages"].append(m);
        Json::Value f; f["fact_id"] = "f-clue"; f["kind"] = "clue"; f["summary"] = "secret documents"; f["data"]["title"] = "secret documents"; ctx["known_facts"].append(f);
        auto out = MockLlmClient::inspiration(ctx);
        CHECK(!out["draft"].asString().empty()); CHECK(out["used_fact_ids"].size() >= 1);
        ctx["variant"] = 1; auto out2 = MockLlmClient::inspiration(ctx); CHECK(out2["draft"] != out["draft"]);
    });
    test("mock module structuring produces cited nodes and edges", [] {
        Json::Value ctx; Json::Value pg; pg["page"] = 2; pg["text"] = "Chapter One: Arrival\n\nScene: The Sheriff's Office\nSheriff Amos Dunmore receives the investigators. A tarnished badge lies on the desk.\n\nNPC: Sheriff Amos Dunmore\nSTR 70 CON 65. Skills: Persuade 60%.\n\nItem: The Lighthouse Key\nAn iron key held by the Sheriff.\nIf the investigators obtain the key they may enter the lighthouse.\n"; ctx["pages"].append(pg);
        auto out = MockLlmClient::moduleStructure(ctx);
        std::set<std::string> types; for (auto& n : out["nodes"]) { types.insert(n["node_type"].asString()); CHECK(n["citations"][0]["page"] == 2); }
        CHECK(types.count("scene")); CHECK(types.count("npc")); CHECK(types.count("item")); CHECK(types.count("condition")); CHECK(types.count("stage"));
        CHECK(out["edges"].size() >= 2);
    });
    test("gateway validates mock output against schema", [] {
        Config cfg; LlmGateway gw(cfg, std::make_unique<MockLlmClient>());
        LlmRequest req; req.task = "consistency"; req.responseSchema = json::parse(R"({"type":"object","required":["rationale","conflicts"]})");
        LlmMessage u; u.role = "user"; Json::Value ctx; ctx["draft"] = "hello"; ctx["known_facts"] = Json::Value(Json::arrayValue); u.content = json::dump(ctx); req.messages.push_back(u);
        auto o = gw.runStructured(req); CHECK(o.ok); CHECK(o.data.isMember("conflicts")); CHECK(gw.isMock());
    });
    test("document entry rendering", [] {
        Json::Value f; f["summary"] = "A brass key"; f["status"] = "confirmed"; f["data"]["title"] = "Brass key"; f["data"]["source"] = "found at the docks";
        auto md = DocumentService::renderEntry("clue", f); CHECK(md.find("**Brass key**") != std::string::npos); CHECK(md.find("status: confirmed") != std::string::npos);
        CHECK(DocumentService::titleFor("open_threads") == "Open Threads");
    });
    std::cout << passed << " checks passed, " << failures << " failed\n";
    return failures == 0 ? 0 : 1;
}
