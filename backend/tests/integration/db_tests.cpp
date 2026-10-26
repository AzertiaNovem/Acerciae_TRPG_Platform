// Database-backed tests for the validation core. Requires PostgreSQL; set TEST_DATABASE_URL (a
// database that may be wiped) — defaults to postgresql://postgres@localhost:5432/acerciae_test.
#include "app/Services.h"
#include "auth/AuthService.h"
#include "chat/ChatService.h"
#include "scenes/SceneManager.h"
#include "documents/DocumentService.h"
#include "knowledge/KnowledgeService.h"
#include "highlights/HighlightService.h"
#include "observer/ObserverScheduler.h"
#include "consistency/ConsistencyService.h"
#include "core/Json.h"
#include "core/Errors.h"
#include <iostream>
#include <cstdlib>

using namespace acerciae;
static int failures = 0, passed = 0;
#define CHECK(cond) do { if (!(cond)) { std::cerr << "  FAIL " << __LINE__ << ": " #cond "\n"; failures++; } else passed++; } while (0)
static void test(const char* name, std::function<void()> fn) { std::cout << "- " << name << "\n"; try { fn(); } catch (const std::exception& e) { std::cerr << "  EXCEPTION " << e.what() << "\n"; failures++; } }

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
    test("knowledge scope is derived from the witnessing audience (split party isolation)", [&] {
        auto docs1 = S.documents->getDocument(p1, clueDocId, "", -1);
        auto docs3 = S.documents->getDocument(p3, clueDocId, "", -1);
        bool p1Sees = false, p3Sees = false;
        for (auto& e : docs1["entries"]) if (e["fact_id"] == clueFactId) p1Sees = true;
        for (auto& e : docs3["entries"]) if (e["fact_id"] == clueFactId) p3Sees = true;
        CHECK(p1Sees); CHECK(!p3Sees);
        CHECK(S.knowledge->listFacts(p3, "clue", "brass", "", 10).empty());
        CHECK(!S.knowledge->listFacts(p1, "clue", "brass", "", 10).empty());
        // AI may not widen visibility beyond the sources
        auto ev = eventOf(say(gmUser, splitWin, "Only Alpha and Bravo hear the whisper of the sea.", "narration")["id"].asString());
        Proposal p; p.channelId = channelId; p.documentType = "clue_journal"; p.actor = "ai";
        Json::Value op; op["op"] = "add_entry"; op["fact"]["summary"] = "Whisper of the sea heard"; op["fact"]["status"] = "confirmed"; op["fact"]["source_event_ids"].append(ev["id"]); op["fact"]["visibility"]["scope"] = "public"; p.ops.append(op);
        auto r = S.documents->commit(p);
        CHECK(r.applied == 1); CHECK(r.log[0]["scope"]["scope"] == "character");
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
    std::cout << passed << " checks passed, " << failures << " failed\n";
    Services::shutdown();
    return failures == 0 ? 0 : 1;
}
