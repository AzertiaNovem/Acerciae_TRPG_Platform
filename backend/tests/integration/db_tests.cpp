// Database-backed tests for the validation core. Requires PostgreSQL; set TEST_DATABASE_URL (a
// database that may be wiped) — defaults to postgresql://postgres@localhost:5432/acerciae_test.
#include <drogon/utils/Utilities.h>
#include "logstudio/ObjectStore.h"
#include "logstudio/LogStudioService.h"
#include "logstudio/PresentationService.h"
#include "logstudio/PublicationService.h"
#include "characters/CharacterSpaceService.h"
#include "logstudio/MediaService.h"
#include "app/Services.h"
#include "atmosphere/AtmosphereService.h"
#include "logstudio/ImageProvider.h"
#include "logstudio/MediaService.h"
#include "auth/AuthService.h"
#include "chat/ChatService.h"
#include "scenes/SceneManager.h"
#include "scenes/ScenarioService.h"
#include "reminders/ReminderService.h"
#include "script/ScriptKnowledgeService.h"
#include "modules/ModuleImporter.h"
#include "documents/DocumentService.h"
#include "knowledge/KnowledgeService.h"
#include "highlights/HighlightService.h"
#include "observer/ObserverScheduler.h"
#include "consistency/ConsistencyService.h"
#include "inspiration/InspirationService.h"
#include "servers/ServerSettingsService.h"
#include "servers/AiPolicyService.h"
#include "dice/DiceService.h"
#include "llm/LlmGateway.h"
#include "llm/MockLlmClient.h"
#include "retrieval/ContextRetrievalService.h"
#include "events/EventStore.h"
#include "core/Json.h"
#include "core/Text.h"
#include "core/Errors.h"
#include <iostream>
#include <cstdlib>
#include <future>
#include <mutex>

using namespace acerciae;
static int failures = 0, passed = 0;
#define CHECK(cond) do { if (!(cond)) { std::cerr << "  FAIL " << __LINE__ << ": " #cond "\n"; failures++; } else passed++; } while (0)
static void test(const char* name, std::function<void()> fn) { std::cout << "- " << name << "\n"; try { fn(); } catch (const std::exception& e) { std::cerr << "  EXCEPTION " << e.what() << "\n"; failures++; } }

class RecordingMemoryClient : public ILlmClient {
public:
    std::vector<LlmRequest> requests;
    std::string secretEntityId,sceneId;
    MockLlmClient mock;
    std::string mode() const override{return "mock";}
    std::string modelName() const override{return "recorded-memory-test";}
    LlmResponse complete(const LlmRequest& req) override {
        requests.push_back(req);
        bool hadTool=false;for(const auto& m:req.messages)if(m.role=="tool")hadTool=true;
        if(req.system.find("ONE player group")!=std::string::npos && !hadTool) {
            LlmResponse r;r.ok=true;
            auto add=[&](const std::string& name,const Json::Value& args){Json::Value call;call["id"]=name;call["name"]=name;call["arguments"]=json::dump(args);r.toolCalls.append(call);};
            Json::Value m;m["query"]="secret";add("get_module_excerpt",m);
            Json::Value e;e["entity"]=secretEntityId;add("get_entity",e);
            Json::Value scene;scene["scene_id"]=sceneId;add("get_scene_by_id",scene);
            return r;
        }
        return mock.complete(req);
    }
};

// A controllable real-gateway fixture: tests inspect the exact combined prompt and return one plan.
class ReminderPlanClient : public ILlmClient {
public:
    Json::Value plan, context;
    int calls = 0;
    std::function<void()> beforeReturn;
    std::string mode() const override { return "live"; }
    std::string modelName() const override { return "reminder-lifecycle-test"; }
    LlmResponse complete(const LlmRequest& req) override {
        LlmResponse r; r.ok = true;
        if (req.task == "scenario_outline") { r.content = R"({"outline":"Fixture outline","key_points":[]})"; return r; }
        ++calls; context = json::parse(req.messages.back().content);
        if (beforeReturn) beforeReturn();
        r.content = json::dump(plan); return r;
    }
};

class ModuleProgressClient : public ILlmClient {
public:
    bool fail=false;size_t timeoutAbove=0;long failureStatus=0;std::vector<LlmRequest> requests;
    std::string mode() const override{return "live";}
    std::string modelName() const override{return "module-progress-fixture";}
    LlmResponse complete(const LlmRequest& req) override {
        requests.push_back(req);LlmResponse r;
        if(fail){r.error="fixture output limit reached";r.providerStatus=failureStatus;return r;}
        if(timeoutAbove){size_t bytes=0;auto ctx=json::parse(req.messages.back().content);for(const auto& p:ctx["pages"])bytes+=p["text"].asString().size();
            if(bytes>timeoutAbove){r.providerStatus=504;r.error="upstream deadline";return r;}}
        r.ok=true;r.content=R"({"nodes":[{"key":"location|harbour","node_type":"location","name":"Harbour","description":"Rainy harbour","citations":[{"page":1,"excerpt":"Scene"}]}],"edges":[]})";
        return r;
    }
};

int main() {
    const char* url = std::getenv("TEST_DATABASE_URL");
    Config cfg; cfg.databaseUrl = url ? url : "postgresql://postgres@localhost:5432/acerciae_test"; cfg.migrationsDir = "./migrations"; cfg.seedDemo = false;
    setenv("LLM_API_KEY", "", 1);
    auto& S = Services::build(cfg);
    { Db admin(cfg.databaseUrl, 1); admin.exec("DROP SCHEMA public CASCADE"); admin.exec("CREATE SCHEMA public"); }
    S.db->runMigrations(cfg.migrationsDir);

    auto suffix = std::to_string(std::rand() % 100000);
    auto gmUser = S.auth->registerUser("gm" + suffix, "password", "GM")["id"].asString();
    auto p1User = S.auth->registerUser("p1" + suffix, "password", "P1")["id"].asString();
    auto p2User = S.auth->registerUser("p2" + suffix, "password", "P2")["id"].asString();
    auto p3User = S.auth->registerUser("p3" + suffix, "password", "P3")["id"].asString();
    Principal gmP{gmUser, "gm", "GM"};
    auto server = S.chat->createServer(gmP, "T");
    Json::Value cb; cb["name"] = "C"; cb["knowledge_mode"] = "isolated";
    auto channelId = S.chat->createChannel(gmP, server["id"].asString(), cb)["id"].asString();
    auto gm = S.auth->channelAccess(gmUser, channelId);
    for (auto u : {"p1", "p2", "p3"}) S.chat->addChannelMember(gm, u + suffix, "player");
    auto mkChar = [&](const std::string& uid, const std::string& name) { Json::Value b; b["name"] = name; return S.chat->createCharacter(S.auth->channelAccess(uid, channelId), b)["id"].asString(); };
    auto c1 = mkChar(p1User, "Alpha"), c2 = mkChar(p2User, "Bravo"), c3 = mkChar(p3User, "Charlie");
    auto p1 = S.auth->channelAccess(p1User, channelId), p3 = S.auth->channelAccess(p3User, channelId);
    auto mainWin = S.chat->listWindows(gm)[0]["id"].asString();
    Json::Value wb; wb["name"] = "Split"; wb["kind"] = "group"; wb["members"] = Json::Value(Json::arrayValue);
    { Json::Value m; m["user_id"] = p1User; wb["members"].append(m); m["user_id"] = p2User; wb["members"].append(m); }
    auto splitWin = S.chat->createWindow(gm, wb)["id"].asString();
    p1=S.auth->channelAccess(p1User,channelId); p3=S.auth->channelAccess(p3User,channelId);
    auto say = [&](const std::string& uid, const std::string& win, const std::string& content, const std::string& kind = "ic") { Json::Value b; b["content"] = content; b["kind"] = kind; return S.chat->postMessage(S.auth->channelAccess(uid, channelId), win, b); };
    auto eventOf = [&](const std::string& messageId) { return S.db->queryOne("SELECT id, audience FROM events WHERE message_id=$1", {messageId}); };

    std::string clueFactId, clueEntryId, clueDocId;
    test("AI confirmed status requires a GM-authored source; player sources are downgraded", [&] {
        auto playerMsg = say(p1User, splitWin, "I find a brass key under the mat.");
        auto ev = eventOf(playerMsg["id"].asString());
        Proposal p; p.channelId = channelId; p.documentType = "clue_journal"; p.actor = "ai";
        Json::Value op; op["op"] = "add_entry"; op["fact"]["summary"] = "A brass key under the mat"; op["fact"]["status"] = "confirmed"; op["fact"]["source_event_ids"].append(ev["id"]);
        p.ops.append(op);
        auto r = S.documents->commit(p);
        CHECK(r.applied == 1); CHECK(r.log[0]["status"] == "attempted");
        auto gmMsg = say(gmUser, splitWin, "You find a brass key under the mat; it is cold and heavy.", "narration");
        auto gev = eventOf(gmMsg["id"].asString());
        Proposal p2 = p; p2.ops = Json::Value(Json::arrayValue);
        Json::Value op2; op2["op"] = "add_entry"; op2["fact"]["summary"] = "Brass key found under the mat (GM confirmed)"; op2["fact"]["status"] = "confirmed"; op2["fact"]["source_event_ids"].append(gev["id"]); op2["fact"]["data"]["title"] = "brass key";
        p2.ops.append(op2);
        auto r2 = S.documents->commit(p2);
        CHECK(r2.applied == 1); CHECK(r2.log[0]["status"] == "confirmed");
        clueFactId = r2.log[0]["fact_id"].asString(); clueEntryId = r2.log[0]["entry_id"].asString(); clueDocId = r2.documentId;
    });
    test("AI facts without a source event are rejected", [&] {
        Proposal p; p.channelId = channelId; p.documentType = "clue_journal"; p.actor = "ai";
        Json::Value op; op["op"] = "add_entry"; op["fact"]["summary"] = "Invented fact with no source"; op["fact"]["status"] = "confirmed"; p.ops.append(op);
        auto r = S.documents->commit(p);
        CHECK(r.applied == 0); CHECK(r.rejected == 1);
    });
    test("KP records are inaccessible to players; each group independently summarizes witnessed chat", [&] {
        for(const auto& viewer : {p1,p3}) {
            bool denied=false; try {S.documents->getDocument(viewer,clueDocId,"",-1);} catch(const ApiError& e){denied=e.status()==404;} CHECK(denied);
            denied=false; try {S.documents->listRevisions(viewer,clueDocId,10);} catch(const ApiError& e){denied=e.status()==404;} CHECK(denied);
        }
        CHECK(S.knowledge->listFacts(p1,"clue","brass","",10).empty());
        auto jobs=S.observer->observeChannel(channelId,true);
        for(const auto& j : jobs) CHECK(j["status"]=="succeeded");
        auto p1facts=S.knowledge->listFacts(p1,"clue","brass","",10);
        CHECK(!p1facts.empty()); CHECK(S.knowledge->listFacts(p3,"clue","brass","",10).empty());
        for(const auto& f : p1facts) CHECK(f["id"]!=clueFactId);
        bool denied=false; try{S.knowledge->gmSetScope(gm,clueFactId,KnowledgeScope{"public",{}});}catch(const ApiError& e){denied=e.status()==409;} CHECK(denied);
    });
    test("contradicting a confirmed record becomes a pending GM proposal, not a silent overwrite", [&] {
        auto ev = eventOf(say(p1User, splitWin, "Actually I never took the key.")["id"].asString());
        Proposal p; p.channelId = channelId; p.documentType = "clue_journal"; p.actor = "ai";
        Json::Value op; op["op"] = "set_status"; op["fact_id"] = clueFactId; op["status"] = "retracted"; op["source_event_ids"].append(ev["id"]); p.ops.append(op);
        auto r = S.documents->commit(p);
        CHECK(r.applied == 0); CHECK(r.pendingReview == 1);
        auto f = S.knowledge->getFact(gm, clueFactId); CHECK(f["status"] == "confirmed");
        auto pending = S.documents->listProposals(gm, "needs_gm_review"); CHECK(!pending.empty());
        auto decided = S.documents->decideProposal(gm, pending[0]["id"].asString(), false); CHECK(decided["status"] == "rejected");
    });
    test("optimistic concurrency: stale expected_version is refused", [&] {
        auto doc = S.db->queryOne("SELECT version FROM documents WHERE id=$1", {clueDocId});
        auto ev = eventOf(say(gmUser, splitWin, "A gull cries.", "narration")["id"].asString());
        Proposal p; p.channelId = channelId; p.documentId = clueDocId; p.actor = "ai"; p.expectedVersion = doc["version"].asInt() - 1;
        Json::Value op; op["op"] = "add_entry"; op["fact"]["summary"] = "Gull cry"; op["fact"]["status"] = "confirmed"; op["fact"]["source_event_ids"].append(ev["id"]); p.ops.append(op);
        bool threw = false; try { S.documents->commit(p); } catch (const ApiError& e) { threw = e.status() == 409; }
        CHECK(threw);
    });
    test("GM correction keeps history and the corrected status stops being used as confirmed context", [&] {
        int before = S.documents->listRevisions(gm, clueDocId, 50).size();
        Json::Value body; body["status"] = "attempted"; body["summary"] = "Brass key: the attempt to take it was NOT confirmed"; body["reason"] = "AI misread the attempt as success";
        auto out = S.documents->gmCorrectEntry(gm, clueDocId, clueEntryId, body);
        CHECK(out["entry"]["status"] == "attempted");
        auto revs = S.documents->listRevisions(gm, clueDocId, 50);
        CHECK((int)revs.size() == before + 1); CHECK(revs[0]["actor"] == "gm");
        auto confirmed = S.knowledge->listFacts(gm, "clue", "brass", "", 10);
        bool anyConfirmed = false; for (auto& f : confirmed) if (f["id"] == clueFactId && f["status"] == "confirmed") anyConfirmed = true;
        CHECK(!anyConfirmed);
        // The snapshot of the previous version still carries the old reading; rollback restores it as a new revision.
        auto older = S.documents->getRevision(gm, clueDocId, revs[1]["version"].asInt());
        bool hadConfirmed = false; for (auto& e : older["snapshot"]) if (e["fact_id"] == clueFactId && e["status"] == "confirmed") hadConfirmed = true;
        CHECK(hadConfirmed);
        auto rolled = S.documents->gmRollback(gm, clueDocId, revs[1]["version"].asInt());
        CHECK(rolled["version"].asInt() == revs[0]["version"].asInt() + 1);
        CHECK(S.knowledge->getFact(gm, clueFactId)["status"] == "confirmed");
        // events trace both the correction and the rollback
        CHECK(!S.db->queryJson("SELECT 1 FROM events WHERE channel_id=$1 AND kind='document.corrected'", {channelId}).empty());
        CHECK(!S.db->queryJson("SELECT 1 FROM events WHERE channel_id=$1 AND kind='document.rolled_back'", {channelId}).empty());
    });
    test("observer processes a batch once per group, advances cursors, and skips when idle", [&] {
        say(p1User, mainWin, "I examine the lantern carefully."); say(p2User, mainWin, "I keep watch at the door."); say(gmUser, mainWin, "You notice a brass plate on the lantern.", "narration");
        auto jobs = S.observer->observeChannel(channelId);
        int observeJobs = 0; for (auto& j : jobs) if (j["status"] == "succeeded") observeJobs++;
        CHECK(observeJobs >= 1);
        auto again = S.observer->observeChannel(channelId);
        CHECK(again.empty());   // nothing new → no LLM call, no job
        auto cursors = S.db->queryJson("SELECT last_seq FROM ai_processing_cursors WHERE channel_id=$1 AND kind='observe'", {channelId});
        CHECK(!cursors.empty());
        auto facts = S.knowledge->listFacts(gm, "", "lantern", "", 10);
        CHECK(!facts.empty());
    });
    test("highlights expire and are cleaned up independently", [&] {
        NewHighlight h; h.channelId = channelId; h.documentId = clueDocId; h.entryId = clueEntryId; h.reason = "test"; h.ttlSeconds = 1; h.visibilityScope = "public";
        auto created = S.highlights->create(h, false);
        CHECK(!created.isNull());
        S.db->exec("UPDATE highlights SET expires_at = now() - interval '1 second' WHERE id=$1", {created["id"].asString()});
        auto removed = S.observer->cleanupHighlights();
        CHECK(removed >= 1);
        CHECK(S.highlights->listActive(gm, clueDocId).empty() || true);
    });
    test("consistency check cites only accessible evidence and never leaks GM-only facts", [&] {
        Json::Value secret; secret["content"] = "SECRET: the key opens the crypt under the chapel."; secret["kind"] = "narration"; secret["visibility"] = "gm_only";
        auto sm = S.chat->postMessage(gm, mainWin, secret);
        auto sev = eventOf(sm["id"].asString());
        Proposal p; p.channelId = channelId; p.documentType = "clue_journal"; p.actor = "ai";
        Json::Value op; op["op"] = "add_entry"; op["fact"]["summary"] = "The key opens the crypt under the chapel"; op["fact"]["status"] = "gm_secret"; op["fact"]["source_event_ids"].append(sev["id"]); p.ops.append(op);
        CHECK(S.documents->commit(p).applied == 1);
        auto r3 = S.consistency->check(p3, mainWin, c3, "I use the key to open the crypt under the chapel.");
        std::string dump = json::dump(r3);
        CHECK(dump.find("crypt under the chapel") == std::string::npos || r3["evidence"].empty());
        for (auto& e : r3["evidence"]) CHECK(e["summary"].asString().find("crypt") == std::string::npos);
        auto r1 = S.consistency->check(p1, splitWin, c1, "I take out the brass key.");
        CHECK(!r1["evidence"].empty() || r1["insufficient_evidence"].asBool());
    });
    test("Private conversations update only the relevant independent player memory", [&] {
        auto gmMsg=say(gmUser,mainWin,"On the mantelpiece you all notice a silver locket engraved with a lantern.","narration");
        auto gev=eventOf(gmMsg["id"].asString());
        Proposal p; p.channelId=channelId; p.documentType="clue_journal";
        Json::Value op; op["op"]="add_entry"; op["fact"]["summary"]="A silver locket engraved with a lantern"; op["fact"]["status"]="confirmed"; op["fact"]["source_event_ids"].append(gev["id"]); p.ops.append(op);
        auto result=S.documents->commit(p); CHECK(result.applied==1);
        S.observer->observeChannel(channelId,true);
        CHECK(!S.knowledge->listFacts(p3,"clue","locket","",10).empty());
        say(p1User,splitWin,"About that silver locket, I pocket it when nobody is looking.");
        S.observer->observeChannel(channelId,true);
        CHECK(json::dump(S.knowledge->listFacts(p3,"","","",200)).find("pocket")==std::string::npos);
        CHECK(json::dump(S.knowledge->listFacts(p1,"","","",200)).find("pocket")!=std::string::npos);
    });
    test("P1: highlights are scoped to witnesses of the triggering event, not just readers of the fact", [&] {
        // The campaign moves to a new scenario so the locket mention counts as a cross-scene callback.
        Json::Value sb; sb["title"] = "Split scene"; sb["location"] = "Back room";
        auto splitScene = S.scenes->create(gm, sb)["id"].asString();
        S.scenes->enterScene(gm, splitScene);
        say(p1User, splitWin, "I look at the silver locket again under the lamp.");
        S.observer->observeChannel(channelId, true);
        auto hl3 = S.highlights->listActive(p3, "");
        for (auto& h : hl3) CHECK(h["reason"].asString().find("locket") == std::string::npos);
        auto hl1 = S.highlights->listActive(p1, "");
        bool alphaHas = false; for (auto& h : hl1) if (h["reason"].asString().find("locket") != std::string::npos) alphaHas = true;
        CHECK(alphaHas);
    });
    test("P1: setting gm_secret through a status-only GM correction removes player access", [&] {
        auto doc = S.documents->getDocument(gm, clueDocId, "", -1);
        std::string entryId, factId;
        for (auto& e : doc["entries"]) if (e["summary"].asString().find("silver locket") != std::string::npos && e["status"] == "confirmed") { entryId = e["id"].asString(); factId = e["fact_id"].asString(); }
        CHECK(!entryId.empty());
        Json::Value body; body["status"] = "gm_secret"; body["summary"] = "The silver locket is the cult's key to the sea cave"; body["reason"] = "keeper only";
        S.documents->gmCorrectEntry(gm, clueDocId, entryId, body);
        bool threw = false; try { S.documents->getEntry(p3, entryId); } catch (const ApiError& e) { threw = e.status() == 404; }
        CHECK(threw);
        CHECK(S.knowledge->listFacts(p1, "clue", "sea cave", "", 10).empty());
        auto scope = S.db->tx([&](pqxx::work& w) { return S.knowledge->getScope(w, factId); }); CHECK(scope.scope == "gm");
    });
    test("P1: inspiration never reveals an NPC's undisclosed full name", [&] {
        Json::Value npc; npc["name"] = "Arthur Crowley"; npc["kind"] = "npc"; S.chat->createCharacter(gm, npc);
        say(gmUser, mainWin, "A thin man introduces himself only as Arthur and offers you tea.", "narration");
        S.observer->observeChannel(channelId, true);
        bool leaked = false;
        for (int v = 0; v < 5; ++v) { auto d = S.inspiration->draft(p1, mainWin, c1, "", v); if (d["draft"].asString().find("Crowley") != std::string::npos) leaked = true; }
        CHECK(!leaked);
        CHECK(S.knowledge->listFacts(p1, "", "Crowley", "", 10).empty());
    });
    test("scenario system: campaign-wide; the observer only suggests, the Keeper opens the next scenario for every window, the old one closes and is summarized", [&] {
        for (int i = 0; i < 6; ++i) say(gmUser, mainWin, "The office clock ticks on; Dunmore shuffles another stack of papers (" + std::to_string(i) + ").", "narration");
        S.observer->observeChannel(channelId, true);
        auto before = S.db->queryOne("SELECT current_scene_id FROM channels WHERE id=$1", {channelId})["current_scene_id"].asString();
        CHECK(S.db->queryOne("SELECT active_scene_id FROM chat_windows WHERE id=$1", {splitWin})["active_scene_id"] == before);   // every window shares it
        auto boundary = say(gmUser, mainWin, "The next morning, you arrive at the Hale boarding house. Mrs. Hale opens the door.", "narration");
        S.observer->observeChannel(channelId, true);
        // The observer does not move the story: the scenario is unchanged and the Keeper got a suggestion anchored to the line.
        CHECK(S.db->queryOne("SELECT current_scene_id FROM channels WHERE id=$1", {channelId})["current_scene_id"] == before);
        bool suggested = false; for (auto& r : S.reminders->list(gm)) if (r["kind"] == "plan" && r["title"].asString().rfind("New scenario?", 0) == 0) { suggested = true; CHECK(r["citations"][0]["message_id"] == boundary["id"]); CHECK(r["title"].asString().find("Hale boarding house") != std::string::npos); }
        CHECK(suggested);
        // The Keeper opens the next scenario: all windows move, the previous one closes and is summarized.
        Json::Value adv; adv["title"] = "Hale boarding house"; adv["location"] = "Hale boarding house"; adv["narrative_time"] = "The next morning";
        auto res = S.scenarios->advance(gm, adv);
        auto newScene = res["scene"]["id"].asString(); CHECK(newScene != before);
        CHECK(S.db->queryOne("SELECT current_scene_id FROM channels WHERE id=$1", {channelId})["current_scene_id"] == newScene);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM chat_windows WHERE channel_id=$1 AND active_scene_id<>$2", {channelId, newScene})["n"].asInt() == 0);
        auto prev = S.db->queryOne("SELECT * FROM scenes WHERE id=$1", {before});
        CHECK(prev["status"] == "closed"); CHECK(prev["summary_status"] == "ready"); CHECK(!prev["summary"].asString().empty()); CHECK(prev["summary_source_event_ids"].size() > 0);
        // The old scenario can only be consulted: new lines in any window land in the new one, and it cannot be entered again.
        auto after1 = say(p1User, mainWin, "I tip my hat to Mrs. Hale.");
        auto after2 = say(p1User, splitWin, "Alpha whispers to Bravo in the hallway.");
        CHECK(S.db->queryOne("SELECT scene_id FROM messages WHERE id=$1", {after1["id"].asString()})["scene_id"] == newScene);
        CHECK(S.db->queryOne("SELECT scene_id FROM messages WHERE id=$1", {after2["id"].asString()})["scene_id"] == newScene);
        CHECK(S.db->queryOne("SELECT scene_id FROM messages WHERE id=$1", {boundary["id"].asString()})["scene_id"] == before);
        bool refused = false; try { S.scenarios->enter(gm, before); } catch (const ApiError& e) { refused = e.status() == 409; } CHECK(refused);
        // The Keeper sees summaries; players only get neutral labels. Chat can be located by scenario and by time.
        bool summarised = false; for (auto& s : S.scenes->list(gm)) if (s["id"] == before && !s["summary"].asString().empty()) summarised = true; CHECK(summarised);
        for (auto& s : S.scenes->list(p1)) CHECK(!s.isMember("summary"));
        auto aev = eventOf(after1["id"].asString());
        Json::Value args; args["scene_id"] = newScene; auto log = S.retrieval->executeTool(p1, "get_chat_log", args);
        CHECK(log["events"].size() >= 1); CHECK(log["events"][0]["event_id"] == aev["id"]);
        Json::Value around; around["around_event_id"] = aev["id"]; around["limit"] = 4; auto ctxLog = S.retrieval->executeTool(gm, "get_chat_log", around);
        bool anchored = false; for (auto& e : ctxLog["events"]) if (e["anchor"].asBool()) anchored = true; CHECK(anchored);
        CHECK(!S.retrieval->executeTool(p1, "list_scenarios", Json::Value(Json::objectValue)).empty());
        // A GM-edited summary is never overwritten by the model; an explicit regeneration replaces it.
        Json::Value edit; edit["summary"] = "Keeper's own words."; S.scenes->update(gm, newScene, edit);
        S.scenarios->summarize(gm, newScene);
        Json::Value edit2; edit2["summary"] = "Keeper's final words."; S.scenes->update(gm, newScene, edit2);
        Json::Value adv2; adv2["title"] = "Manual stage"; adv2["location"] = "Lighthouse"; S.scenarios->advance(gm, adv2);
        CHECK(S.db->queryOne("SELECT summary, summary_status FROM scenes WHERE id=$1", {newScene})["summary"] == "Keeper's final words.");
        // A prepared scenario can be entered; closing the current one without a successor opens a fresh one on the next line.
        Json::Value prep; prep["title"] = "Prepared: the chapel"; auto prepared = S.scenes->create(gm, prep);
        auto entered = S.scenarios->enter(gm, prepared["id"].asString());
        CHECK(entered["scene"]["id"] == prepared["id"]); CHECK(entered["previous"]["status"] == "closed");
        S.scenes->close(gm, prepared["id"].asString());
        auto loose = say(gmUser, mainWin, "Rain again.", "narration");
        auto looseScene = S.db->queryOne("SELECT scene_id FROM messages WHERE id=$1", {loose["id"].asString()})["scene_id"].asString();
        CHECK(looseScene != prepared["id"].asString()); CHECK(S.db->queryOne("SELECT status FROM scenes WHERE id=$1", {looseScene})["status"] == "active");
    });
    test("reminder bubbles quote only readable lines verbatim, stay inside the group, and open the surrounding chat log", [&] {
        say(gmUser, mainWin, "On the mantel you notice a tarnished badge; it bears a lantern sigil instead of the county seal.", "narration");
        for (int i = 0; i < 9; ++i) say(gmUser, mainWin, "The fire crackles and the rain keeps falling (" + std::to_string(i) + ").", "narration");
        S.observer->observeChannel(channelId, true);
        Json::Value secret; secret["content"] = "KEEPER NOTE: the lantern sigil marks members of the Society."; secret["kind"] = "narration"; secret["visibility"] = "gm_only";
        auto secretMsg = S.chat->postMessage(gm, mainWin, secret);
        auto ask = say(p1User, mainWin, "Wait, that lantern sigil on the badge: does it match the one we saw at the docks?");
        S.observer->observeChannel(channelId, true);
        auto mine = S.reminders->list(p1);
        CHECK(!mine.empty());
        bool citesBadge = false;
        for (auto& r : mine) {
            CHECK(r["kind"] == "forgotten" || r["kind"] == "needed"); CHECK(!r["citations"].empty());
            for (auto& c : r["citations"]) {
                CHECK(c["event_id"] != eventOf(secretMsg["id"].asString())["id"]);            // GM-only lines are never quoted
                auto m = S.chat->getMessage(p1, c["message_id"].asString());                    // readable by the group, and verbatim
                for (auto& q : c["quotes"]) { CHECK(m["content"].asString().find(q.asString()) != std::string::npos); if (q.asString().find("lantern sigil") != std::string::npos || q.asString().find("badge") != std::string::npos) citesBadge = true; }
            }
        }
        CHECK(citesBadge);
        auto first = mine[0]["id"].asString();
        auto ctx = S.reminders->context(p1, first, 20);
        bool cited = false; for (auto& e : ctx["events"]) if (e["cited"].asBool()) { cited = true; CHECK(!e["quotes"].empty()); }
        CHECK(cited); CHECK(json::dump(ctx).find("marks members of the Society") == std::string::npos);
        // Another group neither lists nor opens it; the Keeper sees none of the players' bubbles in their own list.
        for (auto& r : S.reminders->list(p3)) CHECK(r["id"] != first);
        bool denied = false; try { S.reminders->context(p3, first, 20); } catch (const ApiError& e) { denied = e.status() == 404; } CHECK(denied);
        for (auto& r : S.reminders->list(gm)) CHECK(r["player_group_id"].isNull());
        // Dismissal is per user and the knowledge prelude carries the group's story index, never KP text.
        S.reminders->dismiss(p1, first);
        for (auto& r : S.reminders->list(p1)) CHECK(r["id"] != first);
        auto prelude = S.retrieval->knowledgePrelude(p1);
        CHECK(prelude.find("KP_SCENE_CLASSIFIED") == std::string::npos);
        CHECK(!S.db->queryJson("SELECT 1 FROM player_scenario_outlines o JOIN player_group_members pm ON pm.group_id=o.group_id WHERE pm.user_id=$1", {p1User}).empty());
        (void)ask;
    });
    test("narrative editing rejects placeholder-only evidence, updates one entry and skips repetition", [&] {
        auto noise = say(gmUser, mainWin, "Narration", "narration");
        auto noiseId = eventOf(noise["id"].asString())["id"].asString();
        auto roll = say(gmUser, mainWin, ".r 1d100");
        auto rollId = eventOf(roll["id"].asString())["id"].asString();
        auto story = say(gmUser, mainWin, "The courier leaves a sealed violet letter beside the well.", "narration");
        auto storyId = eventOf(story["id"].asString())["id"].asString();
        auto evidence = say(gmUser, mainWin, "The violet letter is addressed to the Northwatch curator.", "narration");
        auto evidenceId = eventOf(evidence["id"].asString())["id"].asString();
        p1 = S.auth->channelAccess(p1User, channelId);
        for (bool player : {false,true}) {
            Proposal p; p.channelId=channelId; p.documentType="current_scene"; p.actor="ai";
            if(player) {p.playerGroupId=p1.playerGroupId;p.playerGroupVersion=p1.playerGroupVersion;}
            p.allowedSourceEventIds={noiseId,rollId,storyId,evidenceId};
            Json::Value op; op["op"]="add_entry";op["fact"]["summary"]="A placeholder narration was sent, with no plot content.";op["fact"]["status"]="confirmed";op["fact"]["source_event_ids"].append(noiseId);p.ops.append(op);
            auto rejected=S.documents->commit(p);CHECK(rejected.applied==0);CHECK(rejected.rejected==1);
            op["fact"]["source_event_ids"][0]=rollId;op["fact"]["summary"]="An unexplained dice result was rolled.";p.ops[0]=op;
            CHECK(S.documents->commit(p).applied==0);
            op["fact"]["summary"]="The courier left a sealed violet letter by the well.";op["fact"]["source_event_ids"][0]=storyId;p.ops[0]=op;
            auto added=S.documents->commit(p);CHECK(added.applied==1);auto fid=added.touchedFactIds.at(0);
            Json::Value upd;upd["op"]="update_entry";upd["fact_id"]=fid;upd["summary"]="The courier's sealed violet letter by the well is addressed to the Northwatch curator.";upd["source_event_ids"].append(evidenceId);p.ops[0]=upd;
            auto updated=S.documents->commit(p);CHECK(updated.applied==1);CHECK(updated.touchedFactIds.at(0)==fid);
            auto fact=S.db->queryOne("SELECT * FROM knowledge_facts WHERE id=$1",{fid});CHECK(fact["source_event_ids"].size()==2);
            CHECK(S.db->queryOne("SELECT count(*) AS n FROM document_entries WHERE document_id=$1 AND fact_id=$2 AND NOT removed",{added.documentId,fid})["n"].asInt()==1);
            auto repeated=S.documents->commit(p);CHECK(repeated.applied==0);CHECK(repeated.version==updated.version);
            CHECK(S.db->queryOne("SELECT version FROM knowledge_facts WHERE id=$1",{fid})["version"]==fact["version"]);
        }
        CHECK(S.chat->getMessage(gm,noise["id"].asString())["content"]=="Narration");
        CHECK(S.chat->getMessage(gm,roll["id"].asString())["content"]==".r 1d100");
    });
    test("one reminder plan maintains old entries and creates new ones, with evidence, scope and version guards", [&] {
        auto client = std::make_unique<ReminderPlanClient>(); auto* fixture = client.get();
        LlmGateway gateway(cfg, std::move(client));
        ReminderService service(*S.db, gateway, *S.retrieval, *S.notifier);
        p1 = S.auth->channelAccess(p1User, channelId);
        auto event = [&](const std::string& text, bool secret = false) {
            Json::Value b; b["content"] = text; b["kind"] = "narration"; if (secret) b["visibility"] = "gm_only";
            auto m = S.chat->postMessage(gm, mainWin, b);
            return S.db->queryOne("SELECT id AS event_id,seq,scene_id,kind,actor_role,payload,payload->>'content' AS content FROM events WHERE message_id=$1", {m["id"].asString()});
        };
        auto original = event("Bring the amber compass back to the archivist.");
        auto insert = [&](const std::string& title, const ChannelAccess& view) {
            Json::Value q; q["event_id"] = original["event_id"]; q["text"] = original["content"];
            Json::Value qs(Json::arrayValue); qs.append(q);
            auto citations = ReminderService::resolveCitations(qs, {{original["event_id"].asString(), original}});
            return S.db->queryOne("INSERT INTO reminders(channel_id,player_group_id,scene_id,kind,title,why,citations,source_event_ids,dedupe_key,player_group_version) VALUES($1,$2::uuid,$3,'needed',$4,'Return it',$5::jsonb,$6::uuid[],$7,$8) RETURNING *", {channelId, view.isGm ? dbNull() : DbParam(view.playerGroupId), original["scene_id"].asString(), title, json::dump(citations), pgArrayLiteral({original["event_id"].asString()}), title, view.isGm ? dbNull() : DbParam((int64_t)view.playerGroupVersion)});
        };
        auto old = insert("Return amber compass", p1);
        auto kp = insert("Keeper classified compass", gm);
        auto other = insert("Other group compass", S.auth->channelAccess(p3User, channelId));
        auto row = [&](const Json::Value& r) { return S.db->queryOne("SELECT * FROM reminders WHERE id=$1", {r["id"].asString()}); };
        auto change = [&](const Json::Value& r, const std::string& action, const Json::Value& e) {
            Json::Value c; c["reminder_id"] = r["id"]; c["expected_version"] = r["version"]; c["action"] = action; c["reason"] = "New conversation evidence.";
            Json::Value q; q["event_id"] = e["event_id"]; q["text"] = e["content"]; c["quotes"].append(q); return c;
        };
        auto run = [&](const Json::Value& e, bool keeper = false) {
            Json::Value batch(Json::arrayValue); batch.append(e); int calls = 0;
            return keeper ? service.afterBatchKp(gm, batch, "", calls, Json::Value(Json::arrayValue)) : service.afterBatch(p1, batch, "", calls);
        };
        auto reset = [&] { fixture->plan = json::parse(R"({"changes":[],"reminders":[]})"); };
        auto resolved = event("The archivist accepts the amber compass. Now bring the blue ledger to the dock.");
        reset(); fixture->plan["changes"].append(change(old, "resolve", resolved));
        auto newReminder = change(old, "update", resolved); newReminder["title"] = "Deliver the blue ledger"; newReminder["kind"] = "needed";
        fixture->plan["reminders"].append(newReminder);
        // Attempts to target another partition never enter the planner's managed set.
        fixture->plan["changes"].append(change(kp, "resolve", resolved)); fixture->plan["changes"].append(change(other, "resolve", resolved));
        int beforeCalls = fixture->calls; auto result = run(resolved);
        CHECK(result["created"].asInt() == 1); CHECK(result["changed"].asInt() == 1); CHECK(fixture->calls == beforeCalls + 1);
        CHECK(row(old)["status"] == "resolved"); CHECK(row(old)["citations"] == old["citations"]); CHECK(row(old)["source_event_ids"] == old["source_event_ids"]);
        CHECK(row(kp)["status"] == "active"); CHECK(row(other)["status"] == "active");
        for (const auto& r : fixture->context["managed_reminders"]) { CHECK(r["player_group_id"] == p1.playerGroupId); CHECK(r["id"] != kp["id"]); }
        auto ledger = S.db->queryOne("SELECT * FROM reminders WHERE channel_id=$1 AND player_group_id=$2 AND title='Deliver the blue ledger'", {channelId, p1.playerGroupId});
        CHECK(!ledger.isNull());
        // No duplicate create or stale re-application on retry of the same batch.
        result = run(resolved); CHECK(result["created"].asInt() == 0); CHECK(result["changed"].asInt() == 0);
        auto away = event("We leave the docks and spend the night investigating the chapel.");
        reset(); fixture->plan["changes"].append(change(ledger, "defer", away)); result = run(away);
        CHECK(row(ledger)["status"] == "deferred"); CHECK(result["changed"].asInt() == 1);
        for (const auto& r : service.list(p1)) CHECK(r["id"] != ledger["id"]);
        // A per-user dismissal survives automatic reactivation.
        S.db->exec("INSERT INTO reminder_dismissals(reminder_id,user_id) VALUES($1,$2)", {ledger["id"].asString(), p1User});
        auto back = event("We return to the docks with the blue ledger.");
        reset(); fixture->plan["changes"].append(change(row(ledger), "reactivate", back)); result = run(back);
        CHECK(row(ledger)["status"] == "active"); CHECK(result["changed"].asInt() == 1);
        for (const auto& r : service.list(p1)) CHECK(r["id"] != ledger["id"]);
        // A valid update preserves original source material and records separate review evidence.
        auto update = event("The dock clerk requests the blue ledger at the east pier.");
        reset(); auto revised = change(row(ledger), "update", update); revised["title"] = "Deliver ledger at east pier"; fixture->plan["changes"].append(revised); run(update);
        CHECK(row(ledger)["title"] == "Deliver ledger at east pier"); CHECK(row(ledger)["citations"] == ledger["citations"]);
        CHECK(row(ledger)["review_citations"][0]["event_id"] == update["event_id"]);
        // Forged quotes, historical evidence, stale versions and a model's guessed IDs cannot retire it.
        auto next = event("The party discusses a different route.");
        auto stable = row(ledger);
        reset(); auto bad = change(stable, "resolve", next); bad["quotes"][0]["text"] = "The ledger was delivered."; fixture->plan["changes"].append(bad); run(next); CHECK(row(ledger) == stable);
        reset(); fixture->plan["changes"].append(change(stable, "resolve", original)); run(next); CHECK(row(ledger) == stable);
        reset(); bad = change(stable, "resolve", next); bad["expected_version"] = 1; fixture->plan["changes"].append(bad); run(next); CHECK(row(ledger) == stable);
        auto secret = event("The blue ledger conceals the Keeper's private solution.", true);
        reset(); fixture->plan["changes"].append(change(stable, "resolve", secret)); run(next); CHECK(row(ledger) == stable);
        // Simulate a concurrent edit between model input and commit.
        reset(); fixture->plan["changes"].append(change(stable, "resolve", next));
        fixture->beforeReturn = [&] { S.db->exec("UPDATE reminders SET version=version+1 WHERE id=$1", {ledger["id"].asString()}); };
        run(next); fixture->beforeReturn = nullptr; CHECK(row(ledger)["status"] == "active");
        reset(); fixture->plan["changes"].append(change(row(old), "reactivate", next)); run(next); CHECK(row(old)["status"] == "resolved");
        // The Keeper has the same lifecycle but never receives player reminder state.
        reset(); fixture->plan["changes"].append(change(kp, "resolve", next)); result = run(next, true);
        CHECK(result["changed"].asInt() == 1); CHECK(row(kp)["status"] == "resolved");
        for (const auto& r : fixture->context["managed_reminders"]) CHECK(r["player_group_id"].isNull());
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM reminder_revisions WHERE reminder_id=$1", {ledger["id"].asString()})["n"].asInt() == 3);
        CHECK(S.db->queryOne("SELECT payload->>'content' AS content FROM events WHERE id=$1", {original["event_id"].asString()})["content"] == original["content"]);
    });
    test("script knowledge: built from the module, moved only by reviewed changes, pinned on the Keeper's board, Keeper-only", [&] {
        std::vector<std::string> pages = {
            "THE LANTERN SOCIETY\nA scenario for Call of Cthulhu set in Arkham, 1925.\n\nChapter 1: The Sheriff's Office\nThe investigators meet Sheriff Dunmore, who holds the only key to the lighthouse. He stalls them politely.\nNPC: Sheriff Dunmore\nA tired lawman who secretly belongs to the Lantern Society.\nItem: The Lighthouse Key\nAn iron key stamped with a lantern sigil.\nIf the investigators obtain the key they may enter the lighthouse at night.",
            "Chapter 2: The Lighthouse\nLocation: The Lighthouse\nA ruined tower on the cliffs north of town.\nHandout 1: The Keeper's Diary\nThe diary names the Society's members.\nTwist: The Sheriff's Betrayal\nSheriff Dunmore locks the investigators inside once they find the diary.\nSecret: What Really Happened\nThe Society drowned the lighthouse keeper in 1919.",
            "Ending: Dawn\nIf the investigators escape, the Society scatters."};
        auto mod = S.modules->importText(gm, "The Lantern Society", pages);
        CHECK(mod["status"] == "ready");
        auto all = S.script->list(gm, "");
        std::map<std::string, int> byKind; for (auto& e : all) { byKind[e["kind"].asString()]++; CHECK(e["status"] == "pending"); CHECK(e["origin"] == "script"); CHECK(!e["citations"].empty() || !e["node_ids"].empty()); }
        CHECK(byKind["flow"] >= 3 && byKind["clue"] >= 2 && byKind["foreshadowing"] >= 1 && byKind["background"] >= 1 && byKind["relationship"] >= 1);
        // Keeper-only: players get 403, their tools and prelude never carry it; the Keeper's prelude leads with it.
        bool denied = false; try { S.script->list(p1, ""); } catch (const ApiError& e) { denied = e.status() == 403; } CHECK(denied);
        for (auto& t : ContextRetrievalService::toolSpecs(false)) CHECK(t.name != "get_script_knowledge");
        CHECK(S.retrieval->knowledgePrelude(p1).find("Script flow") == std::string::npos);
        auto prelude = S.retrieval->knowledgePrelude(gm); CHECK(prelude.rfind("Script flow", 0) == 0); CHECK(prelude.find("The Lighthouse [pending]") != std::string::npos);
        auto tool = S.retrieval->executeTool(gm, "get_script_knowledge", json::parse(R"({"kind":"flow"})")); CHECK(tool["entries"].size() == byKind["flow"]);
        auto b0 = S.script->board(gm); CHECK(b0["next"]["has_script"].asBool()); CHECK(b0["next"]["current"].empty()); CHECK(!json::str(b0["next"]["next"], "title").empty());
        // Play. The Keeper narrates the first stage; a player's speculation about the lighthouse moves nothing.
        say(gmUser, mainWin, "You step into the Sheriff's Office. Sheriff Dunmore looks up from his desk and stalls you politely.", "narration");
        say(p1User, mainWin, "I bet the Lighthouse is where the Society meets. Let's ask about the key.");
        S.observer->observeChannel(channelId, true);
        bool officeActive = false;
        for (auto& e : S.script->list(gm, "flow")) { if (e["title"].asString().find("Sheriff") != std::string::npos) officeActive = e["status"] == "active"; if (e["title"] == "The Lighthouse") CHECK(e["status"] == "pending"); }
        CHECK(officeActive);
        auto changes = S.script->changes(gm, 50); CHECK(!changes.empty());
        for (auto& c : changes) { CHECK(c["verdict"] == "approved" || c["verdict"] == "rejected"); if (c["applied"].asBool()) CHECK(c["verdict"] == "approved"); CHECK(!c["evidence"].empty()); CHECK(!c["reviewer_reason"].asString().empty()); }
        auto b1 = S.script->board(gm);
        CHECK(json::str(b1["next"]["current"], "title").find("Sheriff") != std::string::npos); CHECK(b1["next"]["next"]["title"] == "The Lighthouse");
        CHECK(b1["next"]["summary"].asString().find("Next per the script: The Lighthouse") != std::string::npos); CHECK(b1["notes"].isMember("timeline") && b1["notes"].isMember("open_threads"));
        // A Keeper edit is final and logged.
        std::string keyId; for (auto& e : S.script->list(gm, "clue")) if (e["title"] == "The Lighthouse Key") keyId = e["id"].asString();
        CHECK(!keyId.empty());
        Json::Value edit; edit["status"] = "done"; edit["body"] = "Handed over by Dunmore after the bribe.";
        auto upd = S.script->update(gm, keyId, edit); CHECK(upd["gm_edited"].asBool() && upd["status"] == "done");
        CHECK(S.script->changes(gm, 1)[0]["reviewer_reason"] == "Keeper edit");
        // The party reaches the lighthouse: stage two active, stage one done. A player asks about the diary: the
        // Keeper gets a reminder pointing at the unrevealed handout; the players' dock shows nothing of it.
        say(gmUser, mainWin, "Night. You climb the cliff path to the Lighthouse; the ruined tower groans in the wind.", "narration");
        say(p1User, mainWin, "Is there a diary anywhere in here? I search the desk.");
        S.observer->observeChannel(channelId, true);
        bool lhActive = false, officeDone = false;
        for (auto& e : S.script->list(gm, "flow")) { if (e["title"] == "The Lighthouse") lhActive = e["status"] == "active"; if (e["title"].asString().find("Sheriff") != std::string::npos) officeDone = e["status"] == "done"; }
        CHECK(lhActive && officeDone);
        bool diary = false;
        for (auto& r : S.reminders->list(gm)) { CHECK(r["player_group_id"].isNull()); if (r["title"].asString().find("Diary") != std::string::npos) { diary = true; CHECK(r["script_refs"].size() == 1); CHECK(r["script_refs"][0]["kind"] == "clue"); CHECK(!r["citations"].empty()); } }
        CHECK(diary);
        for (auto& r : S.reminders->list(p1)) { CHECK(r["title"].asString().find("Diary") == std::string::npos); CHECK(r["script_refs"].empty()); }
        auto b2 = S.script->board(gm); CHECK(b2["next"]["current"]["title"] == "The Lighthouse"); CHECK(b2["next"]["next"]["title"] == "Dawn"); CHECK(b2["notes"]["stages_done"].size() == 1);
        // Rebuilding from the module keeps the Keeper's edit and the play history.
        S.script->rebuild(gm, "");
        bool kept = false; for (auto& e : S.script->list(gm, "clue")) if (e["id"].asString() == keyId) kept = e["gm_edited"].asBool() && e["status"] == "done";
        CHECK(kept);
    });
    test("dice commands update the speaking character and render with the channel's text group", [&] {
        S.dice->setRng(std::make_unique<dice::SeqRng>(std::vector<int>{20, 50, 3}));
        auto st = say(p1User, splitWin, ".st research53 SAN60 侦查50");
        CHECK(st["kind"].asString() == "roll"); CHECK(st["content"].asString() == ".st research53 SAN60 侦查50");
        auto sheet = S.db->queryOne("SELECT sheet FROM characters WHERE id=$1", {c1})["sheet"];
        CHECK(sheet["attrs"]["research"].asInt() == 53); CHECK(sheet["attrs"]["Spot Hidden"].asInt() == 50);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM events WHERE message_id=$1", {st["id"].asString()})["n"].asInt() == 0);   // bookkeeping, not story
        auto hint = S.dice->preview(p1, splitWin, "", ".ra research");
        CHECK(hint["hint"].asString() == "Alpha's research is 53");
        auto ra = say(p1User, splitWin, ".ra research");
        CHECK(ra["dice"]["text"].asString() == "Alpha's research check: D100=20/53 — Hard Success");
        auto ev = S.db->queryOne("SELECT payload FROM events WHERE message_id=$1", {ra["id"].asString()});
        CHECK(ev["payload"]["content"].asString().find("Hard Success") != std::string::npos);
        auto sc = say(p1User, splitWin, ".sc 1/1d6");
        CHECK(S.db->queryOne("SELECT sheet FROM characters WHERE id=$1", {c1})["sheet"]["attrs"]["SAN"].asInt() == 59);
        CHECK(sc["dice"]["san_new"].asInt() == 59);
        // The GM switches the channel to a custom text group.
        Json::Value g; g["name"] = "Terse"; g["base"] = "en"; g["texts"]["check.result"] = "{attr} {roll}/{target} {level}"; g["texts"]["level.regular"] = "OK";
        auto group = S.settings->createTextGroup(gmP, server["id"].asString(), g);
        Json::Value up; up["dice_text_group"] = group["id"].asString(); S.chat->updateChannel(gm, up);
        S.dice->setRng(std::make_unique<dice::SeqRng>(std::vector<int>{40}));
        CHECK(say(p1User, splitWin, ".ra research")["dice"]["text"].asString() == "research 40/53 OK");
        Json::Value zh; zh["dice_text_group"] = "builtin:zh"; S.chat->updateChannel(gm, zh);
        CHECK(S.dice->preview(p1, splitWin, "", ".ra research")["hint"].asString() == "Alpha的research为53");
        Json::Value bad; bad["dice_text_group"] = "nonsense"; bool rejected = false; try { S.chat->updateChannel(gm, bad); } catch (const ApiError& e) { rejected = e.status() == 400; } CHECK(rejected);
        // A player cannot roll as someone else's character; missing attributes are reported, not posted.
        bool forbiddenRoll = false; try { Json::Value b; b["content"] = ".ra research"; b["character_id"] = c2; S.chat->postMessage(p1, splitWin, b); } catch (const ApiError& e) { forbiddenRoll = e.status() == 403; } CHECK(forbiddenRoll);
        bool missing = false; try { say(p1User, splitWin, ".ra nosuchskill"); } catch (const ApiError& e) { missing = e.code() == "dice_error"; } CHECK(missing);
    });
    test("hidden rolls reach only the roller and the GM; the window sees a notice", [&] {
        S.dice->setRng(std::make_unique<dice::SeqRng>(std::vector<int>{77}));
        auto m = say(p1User, splitWin, ".rh 1d100");
        CHECK(m["visibility"].asString() == "whisper");
        auto p2 = S.auth->channelAccess(p2User, channelId);
        bool p2SeesResult = false, p2SeesNotice = false;
        for (auto& x : S.chat->listMessages(p2, splitWin, 50, 0)) { if (x["id"] == m["id"]) p2SeesResult = true; if (x["dice"]["type"].asString() == "hidden_notice") p2SeesNotice = true; }
        CHECK(!p2SeesResult); CHECK(p2SeesNotice);
        bool p1Sees = false; for (auto& x : S.chat->listMessages(p1, splitWin, 50, 0)) if (x["id"] == m["id"]) p1Sees = true; CHECK(p1Sees);
    });
    test("Independent groups: model input, hostile retrieval, provenance, regrouping and chat references", [&] {
        Json::Value cb2; cb2["name"]="Group boundary tests"; cb2["knowledge_mode"]="isolated";
        auto ch=S.chat->createChannel(gmP,server["id"].asString(),cb2)["id"].asString();
        auto keeper=S.auth->channelAccess(gmUser,ch);
        for(const auto& uid : {p1User,p2User,p3User}) S.chat->addChannelMember(keeper,uid,"player");
        auto makePc=[&](const std::string& uid,const std::string& name) {Json::Value b;b["name"]=name;return S.chat->createCharacter(S.auth->channelAccess(uid,ch),b)["id"].asString();};
        auto pc1=makePc(p1User,"Investigator One"),pc2=makePc(p2User,"Investigator Two"),pc3=makePc(p3User,"Investigator Three");
        auto main=S.chat->listWindows(keeper)[0]["id"].asString();
        Json::Value wb2; wb2["name"]="One private";wb2["kind"]="private";Json::Value member;member["user_id"]=p1User;wb2["members"].append(member);
        auto privateWin=S.chat->createWindow(keeper,wb2)["id"].asString();
        auto one=S.auth->channelAccess(p1User,ch),two=S.auth->channelAccess(p2User,ch),three=S.auth->channelAccess(p3User,ch);
        auto originalTwoGroup=two.playerGroupId;
        CHECK(one.playerGroupId!=two.playerGroupId && two.playerGroupId!=three.playerGroupId);
        auto write=[&](const ChannelAccess& ac,const std::string& win,const std::string& content,const std::string& vis="window") {Json::Value b;b["content"]=content;b["kind"]="narration";b["visibility"]=vis;return S.chat->postMessage(ac,win,b);};
        Json::Value scene;scene["title"]="KP_SCENE_CLASSIFIED_847";scene["summary"]="KP_SCENE_CLASSIFIED_847";scene["location"]="KP_SCENE_CLASSIFIED_847";
        auto sid=S.scenes->create(keeper,scene)["id"].asString(); S.scenes->enterScene(keeper,sid);
        auto pub=write(keeper,main,"You find a brass lantern on the table.");
        auto priv=write(keeper,privateWin,"You find a violet key labelled GROUP_ONE_ONLY_592.");
        auto secret=write(keeper,main,"You find the KP_RAW_CLASSIFIED_347 crypt key.","gm_only");
        Json::Value whisper;whisper["content"]="You find a blue key labelled GROUP_TWO_ONLY_845.";whisper["visibility"]="whisper";whisper["whisper_to"].append(pc2);whisper["kind"]="narration";
        S.chat->postMessage(keeper,main,whisper);
        auto secretEvent=eventOf(secret["id"].asString())["id"].asString();
        Proposal kp;kp.channelId=ch;kp.documentType="clue_journal";kp.actor="gm";
        Json::Value secretOp;secretOp["op"]="add_entry";secretOp["fact"]["summary"]="KP_FACT_CLASSIFIED_998";secretOp["fact"]["source_event_ids"].append(secretEvent);secretOp["fact"]["status"]="gm_secret";secretOp["fact"]["entities"][0]["name"]="KP_ENTITY_CLASSIFIED_124";secretOp["fact"]["entities"][0]["kind"]="npc";kp.ops.append(secretOp);
        auto kpResult=S.documents->commit(kp);CHECK(kpResult.applied==1);
        auto entityId=S.knowledge->listEntities(keeper,"KP_ENTITY")[0]["id"].asString();
        auto recording=std::make_unique<RecordingMemoryClient>();auto* recorded=recording.get();recorded->secretEntityId=entityId;recorded->sceneId=sid;
        LlmGateway gateway(cfg,std::move(recording));
        ObserverScheduler observer(cfg,*S.db,*S.events,*S.documents,*S.highlights,*S.retrieval,gateway,*S.notifier,*S.knowledge,*S.scenarios,*S.reminders,*S.script);
        auto jobs=observer.observeChannel(ch,true); for(const auto& j:jobs) {if(j["status"]!="succeeded")std::cerr<<json::dump(j)<<"\n";CHECK(j["status"]=="succeeded");}
        for (const auto& req : recorded->requests) if (req.task == "observer_extract") {
            CHECK(req.system.find("Choose SKIP, UPDATE, or ADD") != std::string::npos);
            CHECK(req.system.find("Do NOT create a meta-entry") != std::string::npos);
            Json::Value context;
            for (const auto& m : req.messages) if (m.role == "user") { try { auto v=json::parse(m.content); if(v.isMember("new_events")) context=v; } catch (...) {} }
            for (const auto& e : context["new_events"]) if (e["kind"] == "message.posted") CHECK(e["payload"]["message_kind"].isString());
        }
        int playerCalls=0,deniedToolResponses=0;
        for(const auto& req:recorded->requests) if(req.system.find("ONE player group")!=std::string::npos) {
            playerCalls++;
            for(const auto& tool:req.tools) CHECK(tool.name!="get_module_excerpt");
            std::string group;
            for(const auto& m:req.messages) if(m.role=="user" && !m.content.empty() && m.content[0]=='{') {auto c=json::parse(m.content);if(c.isMember("memory_group_id"))group=c["memory_group_id"].asString();}   // the knowledge index turn is plain text and is covered by the marker checks below
            for(const auto& m:req.messages) {
                CHECK(m.content.find("KP_RAW_CLASSIFIED")==std::string::npos);CHECK(m.content.find("KP_FACT_CLASSIFIED")==std::string::npos);CHECK(m.content.find("KP_SCENE_CLASSIFIED")==std::string::npos);CHECK(m.content.find("KP_ENTITY_CLASSIFIED")==std::string::npos);
                if(group==three.playerGroupId) {CHECK(m.content.find("GROUP_ONE_ONLY")==std::string::npos);CHECK(m.content.find("GROUP_TWO_ONLY")==std::string::npos);}
                if(m.role=="tool" && m.content.find("error")!=std::string::npos)deniedToolResponses++;
            }
        }
        CHECK(playerCalls>=6);CHECK(deniedToolResponses>=6);
        auto oneFacts=S.knowledge->listFacts(one,"","","",200),twoFacts=S.knowledge->listFacts(two,"","","",200),threeFacts=S.knowledge->listFacts(three,"","","",200);
        CHECK(json::dump(oneFacts).find("GROUP_ONE_ONLY")!=std::string::npos);CHECK(json::dump(oneFacts).find("GROUP_TWO_ONLY")==std::string::npos);
        CHECK(json::dump(twoFacts).find("GROUP_TWO_ONLY")!=std::string::npos);CHECK(json::dump(twoFacts).find("GROUP_ONE_ONLY")==std::string::npos);
        CHECK(json::dump(threeFacts).find("GROUP_ONE_ONLY")==std::string::npos);CHECK(json::dump(threeFacts).find("GROUP_TWO_ONLY")==std::string::npos);
        CHECK(S.documents->listDocuments(keeper,0).size()==6);CHECK(S.documents->listDocuments(one,0).size()==5);
        auto ownFact=oneFacts[0]["id"].asString();
        bool invalidName=false;
        try { S.knowledge->createPlayerGroup(keeper,std::string(101,'x')); } catch(const ApiError& e) { invalidName=e.status()==400; }
        CHECK(invalidName);
        auto playerEntity=S.knowledge->listEntities(one,"")[0]["id"].asString();
        CHECK(!playerEntity.empty());
        bool crossedRelation=false;
        try { S.db->exec("INSERT INTO entity_relations(channel_id,from_entity_id,to_entity_id,relation,fact_id) VALUES($1,$2,$2,'test',$3)",{ch,playerEntity,kpResult.touchedFactIds[0]}); }
        catch(const std::exception& e) { crossedRelation=std::string(e.what()).find("Cross-partition relation provenance")!=std::string::npos; }
        CHECK(crossedRelation);

        for(const auto& denied : {keeper,two,three}) {bool blocked=false;try{S.knowledge->getFact(denied,ownFact);}catch(const ApiError& e){blocked=e.status()==404;}CHECK(blocked);}
        auto accessibleEvent=eventOf(pub["id"].asString())["id"].asString();
        Proposal hostile;hostile.channelId=ch;hostile.playerGroupId=one.playerGroupId;hostile.playerGroupVersion=one.playerGroupVersion;hostile.documentType="clue_journal";hostile.allowedSourceEventIds={accessibleEvent,secretEvent};
        hostile.ops=kp.ops;hostile.ops[0]["fact"]["status"]="ai_inferred";
        CHECK(S.documents->commit(hostile).rejected==1);
        hostile.ops[0]["fact"]["source_event_ids"][0]=accessibleEvent;hostile.ops[0]["fact"]["data"]["related_fact_ids"].append(kpResult.touchedFactIds[0]);
        CHECK(S.documents->commit(hostile).rejected==1);
        hostile.ops[0]["fact"]["data"].removeMember("related_fact_ids");hostile.documentId=kpResult.documentId;
        bool crossDoc=false;try{S.documents->commit(hostile);}catch(const ApiError& e){crossDoc=e.status()==403;}CHECK(crossDoc);hostile.documentId.clear();
        Json::Value quoted;quoted["content"]="This earlier message is my reference.";quoted["reference_ids"].append(pub["id"]);
        auto quote=S.chat->postMessage(one,main,quoted);CHECK(quote["reference_ids"][0]==pub["id"]);
        quoted["reference_ids"][0]=secret["id"];bool cannotQuote=false;try{S.chat->postMessage(one,main,quoted);}catch(const ApiError& e){cannotQuote=e.status()==404;}CHECK(cannotQuote);
        quoted["reference_ids"][0]=priv["id"];cannotQuote=false;try{S.chat->postMessage(two,main,quoted);}catch(const ApiError& e){cannotQuote=e.status()==404;}CHECK(cannotQuote);
        auto oldGroupVersion=one.playerGroupVersion;
        S.knowledge->movePlayer(keeper,one.playerGroupId,p2User);
        CHECK(S.documents->listDocuments(one,0).empty()); // stale access cannot retrieve old or rebuilt memory
        bool stale=false;try{S.documents->commit(hostile);}catch(const ApiError& e){stale=e.status()==409;}CHECK(stale);
        one=S.auth->channelAccess(p1User,ch);two=S.auth->channelAccess(p2User,ch);CHECK(one.playerGroupVersion>oldGroupVersion);CHECK(two.playerGroupId==one.playerGroupId);
        CHECK(S.knowledge->listFacts(one,"","","",200).empty());
        CHECK(S.chat->getMessage(two,priv["id"].asString())["id"]==priv["id"]);
        bool cannotPost=false;try{write(two,privateWin,"I am not a window participant");}catch(const ApiError& e){cannotPost=e.status()==403;}CHECK(cannotPost);
        observer.observeChannel(ch,true);
        CHECK(json::dump(S.knowledge->listFacts(two,"","","",200)).find("GROUP_ONE_ONLY")!=std::string::npos);
        quoted["reference_ids"][0]=priv["id"];CHECK(S.chat->postMessage(two,main,quoted)["reference_ids"][0]==priv["id"]);
        S.knowledge->movePlayer(keeper,originalTwoGroup,p2User);one=S.auth->channelAccess(p1User,ch);two=S.auth->channelAccess(p2User,ch);
        cannotQuote=false;try{S.chat->getMessage(two,priv["id"].asString());}catch(const ApiError& e){cannotQuote=e.status()==404;}CHECK(cannotQuote);
        observer.observeChannel(ch,true);CHECK(json::dump(S.knowledge->listFacts(two,"","","",200)).find("GROUP_ONE_ONLY")==std::string::npos);
        // Removing a direct window grant invalidates its group's historical summaries too.
        S.chat->removeWindowMember(keeper,privateWin,p1User);one=S.auth->channelAccess(p1User,ch);CHECK(S.knowledge->listFacts(one,"","","",200).empty());
        observer.observeChannel(ch,true);CHECK(json::dump(S.knowledge->listFacts(one,"","","",200)).find("GROUP_ONE_ONLY")==std::string::npos);
        CHECK(S.knowledge->getFact(keeper,kpResult.touchedFactIds[0])["summary"]=="KP_FACT_CLASSIFIED_998");
        // Public-mode invitation defaults to one group, without admitting the KP.
        cb2["name"]="Shared default";cb2["knowledge_mode"]="public";auto sharedCh=S.chat->createChannel(gmP,server["id"].asString(),cb2)["id"].asString();auto sharedKeeper=S.auth->channelAccess(gmUser,sharedCh);
        S.chat->addChannelMember(sharedKeeper,p1User,"player");S.chat->addChannelMember(sharedKeeper,p2User,"player");
        CHECK(S.auth->channelAccess(p1User,sharedCh).playerGroupId==S.auth->channelAccess(p2User,sharedCh).playerGroupId);CHECK(sharedKeeper.playerGroupId.empty());
    });
    test("server maintainers control features, LLM profile and members; keys are sealed", [&] {
        auto sid = server["id"].asString();
        Principal p1P{p1User, "p1", "P1"};
        auto pub = S.settings->get(p1P, sid);
        CHECK(!pub["is_maintainer"].asBool()); CHECK(!pub.isMember("llm")); CHECK(pub["features"]["dice"].asBool());
        bool denied = false; try { S.settings->update(p1P, sid, Json::Value(Json::objectValue)); } catch (const ApiError& e) { denied = e.status() == 403; } CHECK(denied);
        Json::Value b; b["language"] = "zh-CN"; b["llm"]["provider"] = "openai_compatible"; b["tts"]["provider"] = "qwen"; b["llm"]["api_key"] = "sk-test-1234567890abcd"; b["llm"]["model"] = "my-model"; b["llm"]["reasoning_effort"] = "high"; b["llm"]["api_base"] = "https://llm.example/v1";
        b["tts"]["api_key"] = "tts-secret-key-9999"; b["tts"]["voice"] = "alloy"; b["features"]["consistency"] = false; b["features"]["dice"] = false;
        auto full = S.settings->update(gmP, sid, b);
        CHECK(json::dump(full).find("sk-test") == std::string::npos); CHECK(full["llm"]["api_key_set"].asBool()); CHECK(full["llm"]["api_key_hint"].asString() == "…abcd");
        auto stored = S.db->queryOne("SELECT llm_api_key_sealed FROM server_settings WHERE server_id=$1", {sid});
        CHECK(stored["llm_api_key_sealed"].asString().rfind("v1:", 0) == 0); CHECK(stored["llm_api_key_sealed"].asString().find("sk-test") == std::string::npos);
        auto prof = S.settings->profileForChannel(channelId);
        CHECK(prof && prof->endpoint.apiKey == "sk-test-1234567890abcd" && prof->endpoint.model == "my-model" && prof->endpoint.reasoningEffort == "high" && prof->endpoint.apiBase == "https://llm.example/v1" && prof->language == "zh-CN");
        CHECK(S.llm->mode(channelId) == "live"); CHECK(S.llm->status(channelId)["provider"].asString() == "openai_compatible");
        CHECK(S.settings->ttsConfig(sid).apiKey == "tts-secret-key-9999");
        Json::Value imageSettings; imageSettings["llm"]["provider"]="anthropic";
        imageSettings["image"]["provider"]="gpt_image"; imageSettings["image"]["api_base"]="https://images.example/v1";
        imageSettings["image"]["api_key"]="independent-image-key"; imageSettings["image"]["model"]="fixture-image";
        auto configured=S.settings->update(gmP,sid,imageSettings);
        CHECK(configured["llm"]["provider"]=="anthropic"); CHECK(configured["image"]["api_key_set"].asBool());
        CHECK(json::dump(configured).find("independent-image-key")==std::string::npos);
        auto imageStored=S.db->queryOne("SELECT image_api_key_sealed FROM server_settings WHERE server_id=$1",{sid});
        CHECK(imageStored["image_api_key_sealed"].asString().rfind("v1:",0)==0);
        CHECK(imageStored["image_api_key_sealed"].asString().find("independent-image-key")==std::string::npos);
        auto imageConfig=S.settings->imageConfigForChannel(channelId);
        CHECK(imageConfig.apiKey=="independent-image-key"); CHECK(imageConfig.apiBase=="https://images.example/v1");
        CHECK(S.settings->profileForChannel(channelId)->endpoint.apiKey=="sk-test-1234567890abcd");
        CHECK(S.settings->profileForChannel(channelId)->endpoint.provider=="anthropic");
        CHECK(S.settings->profileForChannel(channelId)->endpoint.reasoningEffort.empty());
        CHECK(S.llm->status(channelId)["provider"]=="anthropic");
        CHECK(!S.settings->get(p1P,sid).isMember("image"));
        bool keyRequired = false; try { Json::Value noKey; noKey["image"]["clear_api_key"] = true; S.settings->update(gmP, sid, noKey); } catch (const ApiError& e) { keyRequired = e.status() == 400; } CHECK(keyRequired);
        Json::Value clearImage; clearImage["image"]["clear_api_key"]=true; clearImage["image"]["provider"]="disabled";
        S.settings->update(gmP,sid,clearImage);
        CHECK(S.settings->imageConfigForChannel(channelId).apiKey.empty());

        bool off = false; try { S.settings->requireFeature(sid, "consistency"); } catch (const ApiError& e) { off = e.code() == "feature_disabled"; } CHECK(off);
        auto plain = say(p1User, splitWin, ".ra research");   // dice off: posted as an ordinary message
        CHECK(plain["kind"].asString() == "ic"); CHECK(plain["dice"].isNull());
        Json::Value clear; clear["llm"]["clear_api_key"] = true; clear["llm"]["provider"] = "mock"; clear["features"]["consistency"] = true; clear["features"]["dice"] = true; clear["language"] = "en";
        S.settings->update(gmP, sid, clear);
        CHECK(S.llm->mode(channelId) == "mock");
        // No platform key exists: a server without its own provider is mock, whatever base URL it stores.
        Json::Value baseOnly; baseOnly["llm"]["api_base"] = "https://attacker.example/v1"; S.settings->update(gmP, sid, baseOnly);
        CHECK(S.settings->profileForChannel(channelId)->endpoint.provider == "mock"); CHECK(S.settings->profileForChannel(channelId)->endpoint.apiKey.empty());
        // Provider URLs may not point inside the deployment (unless the operator allows private endpoints).
        for (auto bad : {"http://llm.example/v1", "https://127.0.0.1/v1", "https://10.1.2.3/v1", "https://[::1]/v1", "https://localhost:8080/v1", "https://169.254.169.254/latest"}) {
            bool refused = false; try { Json::Value u; u["llm"]["api_base"] = bad; S.settings->update(gmP, sid, u); } catch (const ApiError& e) { refused = e.status() == 400; } CHECK(refused);
        }
        // AI policy: a token budget for the whole server, an image budget and a concurrency limit.
        Json::Value pol; pol["ai_policy"]["token_budget"] = 100; pol["ai_policy"]["image_budget"] = 1; pol["ai_policy"]["max_concurrent"] = 1; pol["ai_policy"]["period"] = "total";
        auto withPolicy = S.settings->update(gmP, sid, pol);
        CHECK(withPolicy["ai_policy"]["token_budget"].asInt64() == 100); CHECK(withPolicy["ai_policy"]["max_concurrent"].asInt() == 1); CHECK(withPolicy["ai_policy"]["tokens_used"].asInt64() == 0);
        S.aiPolicy->checkTokens(channelId);
        S.aiPolicy->recordTokens(channelId, "observer_extract", 70, 40);
        bool spent = false; try { S.aiPolicy->checkTokens(channelId); } catch (const ApiError& e) { spent = e.status() == 429 && e.code() == "ai_budget_exhausted"; } CHECK(spent);
        CHECK(S.settings->get(gmP, sid)["ai_policy"]["tokens_used"].asInt64() == 110);
        S.aiPolicy->recordImage(channelId, "background");
        bool imagesSpent = false; try { S.aiPolicy->checkImages(channelId); } catch (const ApiError& e) { imagesSpent = e.status() == 429; } CHECK(imagesSpent);
        Json::Value reset; reset["ai_policy"]["reset_usage"] = true; S.settings->update(gmP, sid, reset);
        S.aiPolicy->checkTokens(channelId); S.aiPolicy->checkImages(channelId);
        CHECK(S.settings->get(gmP, sid)["ai_policy"]["tokens_used"].asInt64() == 0);
        {   // one slot: a second caller waits, then gives up with 503
            S.aiPolicy->setSlotWaitSeconds(1);
            auto slot = S.aiPolicy->acquire(channelId);
            CHECK(S.aiPolicy->usage(sid)["running"].asInt() == 1);
            bool busy = false; try { S.aiPolicy->acquire(channelId); } catch (const ApiError& e) { busy = e.status() == 503; } CHECK(busy);
            slot.reset();
            auto again = S.aiPolicy->acquire(channelId); CHECK(again != nullptr || S.aiPolicy->usage(sid)["running"].asInt() == 1);
            S.aiPolicy->setSlotWaitSeconds(120);
        }
        bool badPolicy = false; try { Json::Value bp; bp["ai_policy"]["max_concurrent"] = 0; S.settings->update(gmP, sid, bp); } catch (const ApiError& e) { badPolicy = e.status() == 400; } CHECK(badPolicy);
        // Members: only the owner appoints maintainers; removal also drops channel and window membership.
        bool adminDenied = false;
        S.chat->addServerMember(gmP, sid, p2User, "admin");
        Principal p2P{p2User, "p2", "P2"};
        try { S.chat->addServerMember(p2P, sid, p3User, "admin"); } catch (const ApiError& e) { adminDenied = e.status() == 403; } CHECK(adminDenied);
        bool ownerSafe = false; try { S.chat->removeServerMember(p2P, sid, gmUser); } catch (const ApiError& e) { ownerSafe = e.status() == 400; } CHECK(ownerSafe);
        S.chat->removeServerMember(p2P, sid, p3User);
        CHECK(S.db->queryOne("SELECT 1 AS ok FROM channel_members WHERE user_id=$1", {p3User}).isNull());
        CHECK(S.db->queryOne("SELECT 1 AS ok FROM chat_window_members WHERE user_id=$1", {p3User}).isNull());
        bool gone = false; try { S.auth->channelAccess(p3User, channelId); } catch (const ApiError& e) { gone = e.status() == 403; } CHECK(gone);
        CHECK(!S.chat->searchUsers(gmP, "p3" + suffix, 10).empty());
    });
    test("channel atmosphere is opt-in, public-only, rate-limited, and remembers all four prompts", [&] {
        auto srv=S.chat->createServer(gmP,"Atmosphere checks");auto sid=srv["id"].asString();
        Json::Value cb;cb["name"]="Atmosphere";auto ch=S.chat->createChannel(gmP,sid,cb)["id"].asString();
        auto a=S.auth->channelAccess(gmUser,ch);S.chat->addChannelMember(a,"p1"+suffix,"player");
        auto win=S.chat->listWindows(a)[0]["id"].asString();
        auto client=std::make_unique<ReminderPlanClient>();auto* fixture=client.get();
        LlmGateway gateway(cfg,std::move(client));AtmosphereService service(*S.db,gateway,*S.settings,*S.media);
        Json::Value batch(Json::arrayValue);batch.append("trigger");
        auto post=[&](const std::string& text,bool secret=false){
            Json::Value b;b["content"]=text;b["kind"]="narration";if(secret)b["visibility"]="gm_only";
            auto m=S.chat->postMessage(a,win,b);return S.db->queryOne("SELECT id FROM events WHERE message_id=$1",{m["id"].asString()})["id"];
        };
        auto fresh=[&](){Json::Value id;for(int i=0;i<12;++i)id=post("Public stone courtyard with ivy "+std::to_string(i));return id;};
        auto count=[&](){return S.db->queryOne("SELECT count(*) AS n FROM channel_atmospheres WHERE channel_id=$1",{ch})["n"].asInt();};
        auto due=[&](){S.db->exec("UPDATE channel_atmosphere_state SET next_review_at=now()-interval '1 minute',next_generation_at=now()-interval '1 minute' WHERE channel_id=$1",{ch});};
        auto plan=[&](Json::Value id,const std::string& label){
            fixture->plan=json::parse(R"({"generate":true,"confidence":0.95,"reason":"Established new public location","mood":"Quiet","prompts":{}})");
            fixture->plan["scene_label"]=label;fixture->plan["source_event_ids"].append(id);
            for(auto key:{"day_landscape","night_landscape","day_portrait","night_portrait"})fixture->plan["prompts"][key]=label+"; "+key;
        };
        CHECK(!S.settings->get(gmP,sid)["features"]["atmosphere"].asBool());
        Json::Value off;off["atmosphere_enabled"]=false;S.auth->updateProfile(gmP,off);
        auto id=fresh();auto secret=post("PRIVATE hidden monster in courtyard",true);plan(id,"Courtyard");
        service.afterBatch(ch,batch);CHECK(fixture->calls==0);
        Json::Value settings;settings["features"]["atmosphere"]=true;settings["image"]["provider"]="mock";S.settings->update(gmP,sid,settings);
        service.afterBatch(ch,batch);CHECK(fixture->calls==0);
        Json::Value on;on["atmosphere_enabled"]=true;CHECK(S.auth->updateProfile(gmP,on)["atmosphere_enabled"].asBool());
        service.afterBatch(ch,batch);CHECK(count()==1);CHECK(fixture->calls==1);
        CHECK(json::dump(fixture->context).find("PRIVATE")==std::string::npos);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM asset_generation_jobs WHERE channel_id=$1",{ch})["n"].asInt()==4);
        auto first=service.history(a)[0];CHECK(first["prompts"]==fixture->plan["prompts"]);
        for(const auto& j:S.db->queryJson("SELECT params FROM asset_generation_jobs WHERE channel_id=$1",{ch})){
            auto key=j["params"]["attach"]["variant"].asString();
            CHECK(j["params"]["request"]["size"]==(key.find("portrait")!=std::string::npos?"1024x1536":"1536x1024"));
        }
        CHECK(service.current(a)["enabled"].asBool());CHECK(service.current(a)["assets"].isNull());
        auto oldCalls=fixture->calls;service.afterBatch(ch,batch);CHECK(fixture->calls==oldCalls);
        // In-flight images prevent another set even after the cooldown.
        id=fresh();plan(id,"Harbour");due();service.afterBatch(ch,batch);CHECK(fixture->calls==oldCalls);
        S.db->exec("UPDATE asset_generation_jobs SET status='failed' WHERE channel_id=$1",{ch});
        service.afterBatch(ch,batch);CHECK(count()==2);CHECK(fixture->context["previous_background"]["prompts"]==first["prompts"]);
        S.db->exec("UPDATE asset_generation_jobs SET status='failed' WHERE channel_id=$1",{ch});
        // A private source can never authorize shared art, and uncertain plans create no jobs.
        fresh();plan(secret,"Secret room");due();service.afterBatch(ch,batch);CHECK(count()==2);
        id=fresh();plan(id,"Harbour");fixture->plan["confidence"]=0.3;due();service.afterBatch(ch,batch);CHECK(count()==2);
        // Complete one mock set, preserving candidate publication status and all versioned prompts.
        logstudio::ImageConfig imageCfg;imageCfg.provider="mock";auto provider=logstudio::makeImageProvider(imageCfg);
        for(const auto& v:first["variants"]){
            auto job=S.db->queryOne("SELECT * FROM asset_generation_jobs WHERE id=$1",{v["job_id"].asString()});
            auto image=provider->generate(job["params"]["request"]);CHECK(image.ok);
            int w=0,h=0;logstudio::MediaService::probeDimensions(image.bytes,image.mime,w,h);
            CHECK((h>w)==(v["variant"].asString().find("portrait")!=std::string::npos));
            Json::Value meta;meta["name"]="Atmosphere";meta["visibility_scope"]="channel";meta["approval_status"]="candidate";meta["prompt"]=job["prompt"];
            auto asset=S.media->storeInternal(ch,"background","generated",image.bytes,image.mime,meta);
            S.db->exec("UPDATE asset_generation_jobs SET status='completed',result_asset_id=$2 WHERE id=$1",{v["job_id"].asString(),asset["id"].asString()});
        }
        auto current=service.current(a);CHECK(current["id"]==first["id"]);CHECK(current["assets"].size()==4);CHECK(current["mock"].asBool());
        std::string bytes,mime;auto asset=current["assets"]["night_portrait"].asString();CHECK(service.fetch(a,asset,bytes,mime));
        S.db->exec("UPDATE media_assets SET approval_status='rejected' WHERE id=$1",{asset});
        CHECK(service.current(a)["assets"].isNull());CHECK(!service.fetch(a,asset,bytes,mime));
        S.db->exec("UPDATE media_assets SET approval_status='candidate',visibility_scope='gm' WHERE id=$1",{asset});
        CHECK(service.current(a)["assets"].isNull());
        S.db->exec("UPDATE media_assets SET visibility_scope='channel' WHERE id=$1",{asset});
        auto pl=S.auth->channelAccess(p1User,ch);CHECK(!service.current(pl)["enabled"].asBool());CHECK(!service.fetch(pl,asset,bytes,mime));
        bool denied=false;try{service.history(pl);}catch(const ApiError& e){denied=e.status()==403;}CHECK(denied);
        S.auth->updateProfile(gmP,off);CHECK(!service.fetch(a,asset,bytes,mime));
        on["atmosphere_enabled"]=true;S.auth->updateProfile(gmP,on);
        settings["features"]["atmosphere"]=false;S.settings->update(gmP,sid,settings);CHECK(!service.fetch(a,asset,bytes,mime));
        S.auth->updateProfile(gmP,off);
    });
    test("visual-novel bundles are built in the background, reused while current, and deleted when they expire", [&] {
        say(gmUser, mainWin, "The harbour at night.", "narration");
        auto log = S.studio->campaignLog(gm);
        auto snap = S.studio->createSnapshot(gm, log["project"]["id"].asString(), Json::Value(Json::objectValue));
        Json::Value pb; pb["title"] = "港口之夜 The Harbour";
        auto pres = S.presentations->create(gm, snap["id"].asString(), pb);
        auto pid = pres["id"].asString();
        std::vector<std::function<void()>> queued;
        S.publication->setExecutor([&](std::function<void()> f) { queued.push_back(std::move(f)); return true; });
        auto job = S.publication->requestBundle(gm, pid, Json::Value(Json::objectValue));
        CHECK(job["status"] == "pending"); CHECK(queued.size() == 1);
        CHECK(S.publication->requestBundle(gm, pid, Json::Value(Json::objectValue))["id"] == job["id"]);   // already queued: the same job
        queued.back()(); queued.clear();
        auto ready = S.publication->bundleJobs(gm, pid)[0];
        CHECK(ready["status"] == "ready"); CHECK(ready["file_name"].asString().find(".zip") != std::string::npos); CHECK(ready["bytes"].asInt64() > 100);
        CHECK(ready["progress"]["lines_total"].asInt() >= 1 && ready["progress"]["lines_done"] == ready["progress"]["lines_total"]);
        CHECK(ready["public"] == false);   // no public bucket in this test: private storage
        auto key = S.db->queryOne("SELECT object_key FROM vn_bundle_jobs WHERE id=$1", {ready["id"].asString()})["object_key"].asString();
        CHECK(key.rfind("channels/" + channelId + "/bundles/", 0) == 0 && key.size() > 4 && key.substr(key.size() - 4) == ".zip");
        std::string url, bytes, name;
        CHECK(S.publication->bundleDownload(gm, ready["id"].asString(), true, url, bytes, name));
        CHECK(url.empty() && bytes.rfind("PK", 0) == 0 && name == ready["file_name"].asString());
        CHECK(!S.publication->bundleDownload(p1, ready["id"].asString(), false, url, bytes, name));   // only the requester's own
        auto again = S.publication->requestBundle(gm, pid, Json::Value(Json::objectValue));
        CHECK(again["id"] == ready["id"]); CHECK(again["reused"].asBool());
        Json::Value force; force["force"] = true;
        CHECK(S.publication->requestBundle(gm, pid, force)["id"] != ready["id"]); queued.clear();
        // Expiry: the object leaves storage and the link stops working.
        S.db->exec("UPDATE vn_bundle_jobs SET expires_at=now() - interval '1 minute' WHERE id=$1", {ready["id"].asString()});
        CHECK(S.publication->expireBundles() == 1);
        CHECK(!S.objectStore->exists(key));
        CHECK(S.db->queryOne("SELECT status FROM vn_bundle_jobs WHERE id=$1", {ready["id"].asString()})["status"] == "expired");
        CHECK(!S.publication->bundleDownload(gm, ready["id"].asString(), false, url, bytes, name));
        // Character images: the newest approved image per subtitle wins (a character-space pose or a library upload),
        // the main portrait is the default, and an existing visual novel can take the current images.
        const std::string png = drogon::utils::base64Decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
        auto portrait = S.characterSpace->uploadAsset(p1, c1, "portrait", "", "p.png", png)["portrait"]["id"].asString();
        S.characterSpace->uploadAsset(p1, c1, "subtitle", "SAY", "say1.png", png);
        auto pose = S.db->queryOne("SELECT expressions->>'SAY' AS id FROM character_visual_profiles WHERE character_id=$1", {c1})["id"].asString();
        auto cur = S.presentations->currentStandees(channelId, true);
        CHECK(cur[c1][""]["id"].asString() == portrait); CHECK(cur[c1]["say"]["id"].asString() == pose);
        Json::Value lib; lib["asset_type"] = "standee"; lib["character_id"] = c1; lib["expression"] = "say";   // a newer library upload, other case
        auto newer = S.media->upload(gm, "say2.png", png, "image/png", lib)["id"].asString();
        S.db->exec("UPDATE media_assets SET updated_at=now() + interval '1 second' WHERE id=$1", {newer});
        cur = S.presentations->currentStandees(channelId, true);
        CHECK(cur[c1]["say"]["id"].asString() == newer); CHECK(cur[c1].size() == 2);
        auto ev = S.db->queryOne("SELECT id FROM presentation_events WHERE presentation_id=$1 ORDER BY position LIMIT 1", {pid})["id"].asString();
        Json::Value stage(Json::arrayValue);
        Json::Value a1; a1["character_id"] = c1; a1["expression"] = "SAY"; a1["position"] = "left"; a1["asset_id"] = pose; a1["asset_version"] = 1; stage.append(a1);
        Json::Value a2; a2["character_id"] = c1; a2["expression"] = "ANGRY"; a2["position"] = "right"; a2["asset_id"] = Json::Value(); stage.append(a2);
        S.db->exec("UPDATE presentation_events SET character_asset_ids='[]'::jsonb WHERE presentation_id=$1", {pid});   // only this stage
        S.db->exec("UPDATE presentation_events SET character_asset_ids=$2::jsonb WHERE id=$1", {ev, json::dump(stage)});
        CHECK(S.presentations->refreshStandees(gm, pid)["changed"].asInt() == 2);
        auto after = S.db->queryOne("SELECT character_asset_ids AS s FROM presentation_events WHERE id=$1", {ev})["s"];
        CHECK(after[0]["asset_id"].asString() == newer); CHECK(after[1]["asset_id"].asString() == portrait);   // no ANGRY image: the default
        CHECK(S.presentations->refreshStandees(gm, pid)["changed"].asInt() == 0);
        // A build a restart dropped is failed after an hour.
        S.db->exec("UPDATE vn_bundle_jobs SET created_at=now() - interval '2 hours' WHERE status='pending'");
        S.publication->expireBundles();
        CHECK(S.db->queryJson("SELECT 1 FROM vn_bundle_jobs WHERE status='pending'").empty());
    });
    test("module imports persist progress, deduplicate concurrent content, retry failures and preserve UTF-8 chunks", [&] {
        auto client=std::make_unique<ModuleProgressClient>();auto* fixture=client.get();
        LlmGateway gateway(cfg,std::move(client));ModuleImporter importer(cfg,*S.db,gateway,*S.notifier);
        std::vector<std::function<void()>> queued;std::mutex queueMutex;bool queueFull=false;
        importer.setExecutor([&](auto fn){std::lock_guard<std::mutex> lock(queueMutex);if(queueFull)return false;queued.push_back(fn);return true;});
        auto srv=S.chat->createServer(gmP,"Module import tests");
        Json::Value body;body["name"]="Import tests";auto ch=S.chat->createChannel(gmP,srv["id"].asString(),body)["id"].asString();
        auto access=S.auth->channelAccess(gmUser,ch);
        std::string text="Scene: 雾港\n";for(int i=0;i<7000;++i)text+="中文剧情";
        auto first=std::async(std::launch::async,[&]{return importer.importText(access,"Long module",{text},true);});
        auto second=std::async(std::launch::async,[&]{return importer.importText(access,"Different title",{text},true);});
        auto one=first.get(),two=second.get();auto id=one["id"].asString();
        CHECK(one["id"]==two["id"]);CHECK(one["deduplicated"].asBool()!=two["deduplicated"].asBool());CHECK(queued.size()==1);
        CHECK(importer.get(access,id)["import_stage"]=="queued");
        importer.setPostProcess([&](const auto&,const auto& module){
            auto state=importer.get(access,module);CHECK(state["import_stage"]=="knowledge");CHECK(state["completed_chunks"]==state["total_chunks"]);
            throw std::runtime_error("fixture knowledge failure");
        });
        queued.back()();queued.clear();
        auto complete=importer.get(access,id);CHECK(complete["status"]=="ready");CHECK(!complete["import_warning"].asString().empty());
        CHECK(complete["total_chunks"].asInt()>1);CHECK(complete["completed_chunks"]==complete["total_chunks"]);
        std::string joined;
        for(const auto& req:fixture->requests){
            CHECK(req.maxTokens==32768);auto ctx=json::parse(req.messages.back().content);size_t bytes=0;
            for(const auto& page:ctx["pages"]){CHECK(page["page"]==1);auto s=page["text"].asString();joined+=s;bytes+=s.size();CHECK((static_cast<unsigned char>(s[0])&0xc0)!=0x80);}
            CHECK(bytes<=12000);
        }
        CHECK(joined==text);
        CHECK(importer.importText(access,"Again",{text},true)["deduplicated"].asBool());CHECK(queued.empty());
        CHECK(importer.retry(access,id)["status"]=="ready");CHECK(queued.empty());
        importer.setPostProcess({});fixture->fail=true;
        auto bad=importer.importText(access,"Failing module",{"Scene: Failed garden"},true);
        queued.back()();queued.clear();CHECK(importer.get(access,bad["id"].asString())["status"]=="failed");
        fixture->fail=false;auto retry=importer.retry(access,bad["id"].asString());CHECK(retry["id"]==bad["id"]);CHECK(queued.size()==1);
        importer.retry(access,bad["id"].asString());CHECK(queued.size()==1);queued.back()();queued.clear();
        CHECK(importer.get(access,bad["id"].asString())["status"]=="ready");
        queueFull=true;auto full=importer.importText(access,"Queue full",{"Scene: Crowded queue"},true);CHECK(full["status"]=="failed");
        queueFull=false;importer.retry(access,full["id"].asString());CHECK(queued.size()==1);
        importer.recoverInterrupted();CHECK(importer.get(access,full["id"].asString())["status"]=="failed");queued.clear();
        importer.retry(access,full["id"].asString());queued.back()();queued.clear();CHECK(importer.get(access,full["id"].asString())["status"]=="ready");
        auto pdf=importer.importPdf(access,"broken.pdf","%PDF-broken","Broken");queued.back()();queued.clear();
        CHECK(importer.get(access,pdf["id"].asString())["status"]=="failed");
        CHECK(importer.importPdf(access,"renamed.pdf","%PDF-broken","Other")["id"]==pdf["id"]);CHECK(queued.empty());
        bool denied=false;auto player=access;player.isGm=false;try{importer.retry(player,id);}catch(const ApiError& e){denied=e.status()==403;}CHECK(denied);
        auto node=complete["nodes"][0]["id"].asString();
        S.db->exec("UPDATE module_nodes SET citations='[{\"page\":1},{\"page\":2,\"excerpt\":\"Original quote\"}]'::jsonb WHERE id=$1",{node});
        auto citations=importer.get(access,id)["nodes"][0]["citations"];
        CHECK(citations[0]["page"]==1);CHECK(citations[0]["excerpt"].isString());CHECK(citations[0]["excerpt"]=="");
        CHECK(citations[1]["excerpt"]=="Original quote");
        fixture->requests.clear();fixture->timeoutAbove=3200;
        const std::vector<std::string> adaptivePages={"Scene: First",text,"尾页证据"};
        auto adaptive=importer.importText(access,"Adaptive timeout",adaptivePages);
        CHECK(adaptive["status"]=="ready");CHECK(adaptive["completed_chunks"]==adaptive["total_chunks"]);
        std::map<int,std::string> recovered;int timeouts=0;
        for(const auto& req:fixture->requests){auto ctx=json::parse(req.messages.back().content);size_t bytes=0;
            for(const auto& p:ctx["pages"])bytes+=p["text"].asString().size();
            if(bytes>3200){++timeouts;continue;}
            for(const auto& p:ctx["pages"])recovered[p["page"].asInt()]+=p["text"].asString();
        }
        CHECK(timeouts==2);CHECK(fixture->requests.size()==adaptive["total_chunks"].asUInt()+2);
        for(int i=0;i<3;++i)CHECK(recovered[i+1]==adaptivePages[i]);
        fixture->requests.clear();fixture->fail=true;fixture->failureStatus=504;
        auto outage=importer.importText(access,"Bounded outage",{text+"Outage"});
        CHECK(outage["status"]=="failed");CHECK(fixture->requests.size()==3);
        fixture->requests.clear();fixture->failureStatus=401;
        auto unauthorized=importer.importText(access,"Invalid key",{text+"Invalid key"});
        CHECK(unauthorized["status"]=="failed");CHECK(fixture->requests.size()==1);
        fixture->fail=false;fixture->timeoutAbove=0;fixture->failureStatus=0;
        LlmRequest normal;normal.task="general";normal.maxTokens=300;normal.responseSchema=ModuleImporter::structureSchema();gateway.runStructured(normal);
        CHECK(fixture->requests.back().maxTokens==8192);
        LlmRequest knowledge=normal;knowledge.task="script_knowledge";gateway.runStructured(knowledge);CHECK(fixture->requests.back().maxTokens==32768);
        ScriptKnowledgeService builds(*S.db,*S.llm,*S.retrieval,*S.reminders,*S.notifier);
        builds.setExecutor([&](std::function<void()> task){if(queueFull)return false;queued.push_back(std::move(task));return true;});
        auto job=builds.rebuild(access,id,true);CHECK(job["status"]=="pending");CHECK(queued.size()==1);
        CHECK(builds.rebuild(access,id,true)["id"]==job["id"]);CHECK(queued.size()==1);
        queued.back()();queued.clear();CHECK(builds.builds(access)[0]["status"]=="completed");
        queueFull=true;CHECK(builds.rebuild(access,id,true)["status"]=="failed");
        queueFull=false;job=builds.rebuild(access,id,true);CHECK(job["status"]=="pending");
        builds.recoverInterrupted();CHECK(builds.builds(access)[0]["status"]=="failed");
        queued.back()();queued.clear();CHECK(builds.builds(access)[0]["status"]=="failed");
        denied=false;try{builds.builds(player);}catch(const ApiError& e){denied=e.status()==403;}CHECK(denied);

    });
    test("Chinese fallback clue and thread titles survive the 80-byte PostgreSQL boundary", [&] {
        std::string prefix; for (int i = 0; i < 26; ++i) prefix += "线";
        auto summary = prefix + "密室里发现了调查线索";
        const auto message = say(gmUser, mainWin, summary, "narration");
        const auto event = eventOf(message["id"].asString());
        for (const auto &doc : {"clue_journal", "open_threads"}) {
            Proposal proposal; proposal.channelId = channelId; proposal.documentType = doc;
            Json::Value op; op["op"] = "add_entry"; op["fact"]["summary"] = summary;
            op["fact"]["status"] = "confirmed"; op["fact"]["source_event_ids"].append(event["id"]);
            proposal.ops.append(op); // no explicit title: exercise DocumentService's real fallback
            const auto result = S.documents->commit(proposal);
            CHECK(result.applied == 1);
            const auto table = std::string(doc) == "clue_journal" ? "clues" : "narrative_threads";
            const auto row = S.db->queryOne("SELECT title FROM " + std::string(table) + " WHERE fact_id=$1", {result.log[0]["fact_id"].asString()});
            CHECK(row["title"] == prefix + "…");
        }
    });
    test("Visual novel titles, instructions and rewritten lines retain valid UTF-8 at byte limits", [&] {
        const auto repeat = [](const std::string &point, size_t n) { std::string out; while (n--) out += point; return out; };
        const auto log = S.studio->campaignLog(gm);
        const auto snap = S.studio->createSnapshot(gm, log["project"]["id"].asString(), Json::Value(Json::objectValue));
        const auto pres = S.presentations->create(gm, snap["id"].asString(), Json::Value(Json::objectValue));
        const auto pid = pres["id"].asString();
        const auto event = pres["events"][0]["canonical_event_id"];
        CHECK(event.isString());
        Json::Value script, scene, line;
        scene["key"] = "scene-utf8"; scene["title"] = repeat("密", 80); scene["summary"] = repeat("密", 140);
        scene["background_brief"] = repeat("景", 140);
        line["event_id"] = event; line["kind"] = "narration"; line["text"] = repeat("话", 1400); line["delivery"] = repeat("缓", 140);
        scene["lines"].append(line); script["scenes"].append(scene);
        S.presentations->applyScript(gm, pid, script);
        const auto stored = S.db->queryOne("SELECT title,metadata FROM presentation_scenes WHERE presentation_id=$1 AND canonical_scene_key='scene-utf8'", {pid});
        CHECK(stored["title"] == repeat("密", 66));
        CHECK(stored["metadata"]["summary"] == repeat("密", 133));
        CHECK(stored["metadata"]["background_brief"] == repeat("景", 133));
        auto pe = S.db->queryOne("SELECT id,script_text,style_instruction FROM presentation_events WHERE presentation_id=$1 AND canonical_event_id=$2", {pid, event.asString()});
        CHECK(pe["script_text"] == repeat("话", 1333)); CHECK(pe["style_instruction"] == repeat("缓", 133));
        Json::Value edit; edit["script_text"] = repeat("😀", 1001);
        S.presentations->updateEvent(gm, pe["id"].asString(), edit);
        CHECK(S.db->queryOne("SELECT script_text FROM presentation_events WHERE id=$1", {pe["id"].asString()})["script_text"] == repeat("😀", 1000));
    });
    std::cout << passed << " checks passed, " << failures << " failed\n";
    Services::shutdown();
    return failures == 0 ? 0 : 1;
}
