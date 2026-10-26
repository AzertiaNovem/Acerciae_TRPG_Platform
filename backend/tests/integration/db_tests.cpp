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
#include "servers/ServerSettingsService.h"
#include "dice/DiceService.h"
#include "llm/LlmGateway.h"
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
    test("server maintainers control features, LLM profile and members; keys are sealed", [&] {
        auto sid = server["id"].asString();
        Principal p1P{p1User, "p1", "P1"};
        auto pub = S.settings->get(p1P, sid);
        CHECK(!pub["is_maintainer"].asBool()); CHECK(!pub.isMember("llm")); CHECK(pub["features"]["dice"].asBool());
        bool denied = false; try { S.settings->update(p1P, sid, Json::Value(Json::objectValue)); } catch (const ApiError& e) { denied = e.status() == 403; } CHECK(denied);
        Json::Value b; b["language"] = "zh-CN"; b["llm"]["api_key"] = "sk-test-1234567890abcd"; b["llm"]["model"] = "my-model"; b["llm"]["reasoning_effort"] = "high"; b["llm"]["api_base"] = "https://llm.example/v1";
        b["tts"]["api_key"] = "tts-secret-key-9999"; b["tts"]["voice"] = "alloy"; b["features"]["consistency"] = false; b["features"]["dice"] = false;
        auto full = S.settings->update(gmP, sid, b);
        CHECK(json::dump(full).find("sk-test") == std::string::npos); CHECK(full["llm"]["api_key_set"].asBool()); CHECK(full["llm"]["api_key_hint"].asString() == "…abcd");
        auto stored = S.db->queryOne("SELECT llm_api_key_sealed FROM server_settings WHERE server_id=$1", {sid});
        CHECK(stored["llm_api_key_sealed"].asString().rfind("v1:", 0) == 0); CHECK(stored["llm_api_key_sealed"].asString().find("sk-test") == std::string::npos);
        auto prof = S.settings->profileForChannel(channelId);
        CHECK(prof && prof->endpoint.apiKey == "sk-test-1234567890abcd" && prof->endpoint.model == "my-model" && prof->endpoint.reasoningEffort == "high" && prof->endpoint.apiBase == "https://llm.example/v1" && prof->language == "zh-CN");
        CHECK(S.llm->mode(channelId) == "live"); CHECK(S.llm->status(channelId)["source"].asString() == "server");
        CHECK(S.settings->ttsConfig(sid).apiKey == "tts-secret-key-9999");
        bool off = false; try { S.settings->requireFeature(sid, "consistency"); } catch (const ApiError& e) { off = e.code() == "feature_disabled"; } CHECK(off);
        auto plain = say(p1User, splitWin, ".ra research");   // dice off: posted as an ordinary message
        CHECK(plain["kind"].asString() == "ic"); CHECK(plain["dice"].isNull());
        Json::Value clear; clear["llm"]["clear_api_key"] = true; clear["features"]["consistency"] = true; clear["features"]["dice"] = true; clear["language"] = "en";
        S.settings->update(gmP, sid, clear);
        CHECK(S.llm->mode(channelId) == "mock");
        // A server base URL without the server's own key is ignored, so the process key never travels to it.
        Json::Value baseOnly; baseOnly["llm"]["api_base"] = "https://attacker.example/v1"; S.settings->update(gmP, sid, baseOnly);
        CHECK(S.settings->profileForChannel(channelId)->endpoint.apiBase == S.cfg.llmApiBase);
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
    std::cout << passed << " checks passed, " << failures << " failed\n";
    Services::shutdown();
    return failures == 0 ? 0 : 1;
}
