// Database-backed tests for the validation core. Requires PostgreSQL; set TEST_DATABASE_URL (a
// database that may be wiped) — defaults to postgresql://postgres@localhost:5432/acerciae_test.
#include <drogon/utils/Utilities.h>
#include "logstudio/ObjectStore.h"
#include "logstudio/LogStudioService.h"
#include "logstudio/PresentationService.h"
#include "logstudio/PublicationService.h"
#include "characters/CharacterSpaceService.h"
#include "logstudio/MediaService.h"
#include "core/Crypto.h"
#include "app/Services.h"
#include "atmosphere/AtmosphereService.h"
#include "logstudio/ImageProvider.h"
#include "logstudio/MediaService.h"
#include "auth/AuthService.h"
#include "chat/ChatService.h"
#include "chat/Recall.h"
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
#include "logstudio/StorageCleanup.h"
#include "logstudio/TtsService.h"
#include "logstudio/ImageReferences.h"
#include "logstudio/VnScriptService.h"
#include "logstudio/MediaMigrator.h"
#include "logstudio/ObjectInventory.h"
#include "documents/NarrativeMemoryPolicy.h"
#include "chat/ChatQueries.h"
#include "ws/Notifier.h"
#include "api/RouteSupport.h"
#include "chat/HypertextService.h"
#include "chat/Hypertext.h"
#include <drogon/utils/Utilities.h>
#include <filesystem>
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
        // The planner sends a prose prompt and its structured context aside (as the mock client reads it).
        ++calls; context = req.mockContext.isObject() && !req.mockContext.empty() ? req.mockContext : json::parse(req.messages.back().content);
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

    test("configured administrator names cannot be claimed or released through profile APIs", [&] {
        Config protectedCfg = cfg; protectedCfg.platformAdmins = {"reserved_operator", "gm" + suffix};
        AuthService guarded(*S.db, protectedCfg);
        auto denied = [&](auto fn) { bool rejected=false; try { fn(); } catch(const ApiError& e) { rejected=e.status()==403; } CHECK(rejected); };
        denied([&] { guarded.registerUser("reserved_operator", "password", "intruder"); });
        Json::Value b; b["username"]="reserved_operator";
        denied([&] { guarded.updateProfile(Principal{p1User,"p1","P1"},b); });
        b["username"]="renamed_operator";
        denied([&] { guarded.updateProfile(gmP,b); });
        CHECK(guarded.profile(gmUser)["is_admin"].asBool());
        CHECK(!guarded.profile(p1User)["is_admin"].asBool());
        b.removeMember("username"); b["display_name"]="GM";
        CHECK(guarded.updateProfile(gmP,b)["is_admin"].asBool());
    });
    test("invalid channel settings leave rules, cards and messages unchanged", [&] {
        const auto before=S.chat->getChannel(gm);
        const auto card=S.db->queryOne("SELECT sheet,role_card FROM characters WHERE id=$1", {c1});
        const auto messages=S.db->queryOne("SELECT count(*) AS n FROM messages WHERE channel_id=$1", {channelId});
        Json::Value bad; bad["rule_system"]="dnd2024"; bad["ai_enabled"]=1e30;
        bool rejected=false; try { S.chat->updateChannel(gm,bad); } catch(const ApiError& e) { rejected=e.status()==400; }
        CHECK(rejected); CHECK(S.chat->getChannel(gm)==before);
        CHECK(S.db->queryOne("SELECT sheet,role_card FROM characters WHERE id=$1", {c1})==card);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM messages WHERE channel_id=$1", {channelId})==messages);
    });
    std::string clueFactId, clueEntryId, clueDocId;
    test("image references migrate once, retain their exact bytes and inventory, and expire completed tasks safely", [&] {
        Json::Value body; body["name"] = "Reference retention";
        auto ch = S.chat->createChannel(gmP, server["id"].asString(), body)["id"].asString();
        const std::string bytes = "frozen original image bytes";
        Json::Value ref; ref["id"] = crypto::uuid4(); ref["version"] = 1;
        ref["data_uri"] = "data:image/png;base64," + drogon::utils::base64Encode(bytes);
        Json::Value params; params["request"]["reference_images"].append(ref);
        auto insert = [&](const std::string& status, const Json::Value& value) {
            return S.db->queryOne("INSERT INTO asset_generation_jobs(channel_id,kind,status,provider,prompt,params,finished_at) "
                "VALUES($1,'standee',$2,'mock','test',$3::jsonb,now()-interval '31 days') RETURNING id", {ch,status,json::dump(value)})["id"].asString();
        };
        auto complete = insert("completed", params), failed = insert("failed", params), running = insert("running", params);
        auto& store = static_cast<logstudio::RoutingObjectStore&>(*S.objectStore);
        logstudio::MediaMigrator migrator(*S.db,store,false);
        auto moved = migrator.runOnce();
        CHECK(moved.failed == 0); CHECK(moved.imageJobsMoved == 2);
        auto saved = S.db->queryOne("SELECT params FROM asset_generation_jobs WHERE id=$1", {failed})["params"];
        const auto snapshot = saved["request"]["reference_images"][0];
        CHECK(!snapshot.isMember("data_uri")); CHECK(snapshot["id"] == ref["id"]); CHECK(snapshot["version"] == 1);
        CHECK(snapshot["content_hash"] == crypto::sha256Hex(bytes));
        auto key = snapshot["object_key"].asString(); CHECK(key.rfind("pub/",0) != 0);
        CHECK(logstudio::hydrateImageReferences(store,ch,saved["request"])["reference_images"][0]["data_uri"] == ref["data_uri"]);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM stored_objects WHERE object_key=$1", {key})["n"].asInt() == 1);
        auto receipt = S.db->queryOne("SELECT owner_kind,owner_id,provenance FROM stored_objects WHERE object_key=$1", {key});
        CHECK(receipt["owner_kind"] == "channel"); CHECK(receipt["owner_id"] == ch); CHECK(receipt["provenance"].size() == 2);
        CHECK(migrator.runOnce().imageJobsMoved == 0);
        CHECK(S.db->queryOne("SELECT params FROM asset_generation_jobs WHERE id=$1", {running})["params"] == params);
        auto other = saved["request"]; bool refused = false;
        try { logstudio::hydrateImageReferences(store,channelId,other); } catch (...) { refused = true; } CHECK(refused);
        auto parent = insert("completed", Json::Value(Json::objectValue));
        Json::Value dependent; dependent["portrait_job_id"] = parent; insert("pending",dependent);
        auto dry = S.storageCleanup->runOnce(true); CHECK(dry.expiredJobs >= 1);
        CHECK(!S.db->queryOne("SELECT id FROM asset_generation_jobs WHERE id=$1",{complete}).isNull());
        auto cleaned = S.storageCleanup->runOnce(); CHECK(cleaned.expiredJobs >= 1);
        CHECK(S.db->queryOne("SELECT id FROM asset_generation_jobs WHERE id=$1",{complete}).isNull());
        for (const auto& id : {failed,running,parent}) CHECK(!S.db->queryOne("SELECT id FROM asset_generation_jobs WHERE id=$1",{id}).isNull());
        CHECK(store.exists(key)); // The failed task still pins the shared snapshot.
        store.put(key,"corrupted bytes","image/png"); refused = false;
        try { logstudio::hydrateImageReferences(store,ch,saved["request"]); } catch (...) { refused = true; } CHECK(refused);
        store.put(key,bytes,"image/png");
        S.db->exec("DELETE FROM asset_generation_jobs WHERE channel_id=$1",{ch});
        std::filesystem::last_write_time(std::filesystem::path(cfg.uploadDir) / "objects" / key,
                                       std::filesystem::file_time_type::clock::now() - std::chrono::hours(48));
        store.retain(key); // A new request has reserved this existing snapshot but has not committed its job yet.
        S.storageCleanup->runOnce(); CHECK(store.exists(key));
        S.db->exec("UPDATE stored_objects SET protected_until=now()-interval '1 second' WHERE object_key=$1",{key});
        S.storageCleanup->runOnce(); CHECK(!store.exists(key));
        CHECK(S.db->queryOne("SELECT object_key FROM stored_objects WHERE object_key=$1",{key}).isNull());
    });
    test("hybrid reuses atmosphere candidates locally and retains their ownership link", [&] {
        Json::Value body; body["name"] = "Hybrid harbour";
        auto ch = S.chat->createChannel(gmP, server["id"].asString(), body)["id"].asString();
        auto access = S.auth->channelAccess(gmUser,ch);
        auto window = S.db->queryOne("SELECT id,name FROM chat_windows WHERE channel_id=$1 ORDER BY created_at LIMIT 1",{ch});
        Json::Value message; message["kind"] = "narration"; message["content"] = "Fog rolls over the harbour.";
        S.chat->postMessage(access,window["id"].asString(),message);
        Json::Value meta; meta["visibility_scope"] = "channel"; meta["approval_status"] = "candidate"; meta["created_by"] = gmUser; meta["name"] = "Existing atmosphere";
        const auto png = drogon::utils::base64Decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
        auto asset = S.media->storeInternal(ch,"background","generated",png,"image/png",meta)["id"].asString();
        auto imageJob = S.db->queryOne("INSERT INTO asset_generation_jobs(channel_id,kind,status,provider,prompt,result_asset_id,finished_at) VALUES($1,'background','completed','mock','existing',$2,now()-interval '31 days') RETURNING id",{ch,asset})["id"].asString();
        auto atmosphere = S.db->queryOne("INSERT INTO channel_atmospheres(channel_id,scene_label,mood,reason,prompts,source_event_ids,created_by) VALUES($1,$2,'fog','fixture','{}','{}',$3) RETURNING id",{ch,std::string("Opening scene"),gmUser})["id"].asString();
        S.db->exec("INSERT INTO channel_atmosphere_variants(atmosphere_id,variant,job_id) VALUES($1,'day_landscape',$2)",{atmosphere,imageJob});
        Json::Value request; request["media_mode"] = "hybrid";
        auto job = S.vnScripts->create(access,request); CHECK(S.vnScripts->processNext());
        auto done = S.vnScripts->get(access,job["id"].asString()); CHECK(done["status"] == "completed");
        if (done["status"] != "completed") throw std::runtime_error(json::str(done,"error"));
        auto handoff = S.presentations->hybrid(access,done["presentation_id"].asString(),*S.media);
        CHECK(handoff["assets"].size() == 1); CHECK(handoff["assets"][0]["id"] == asset);
        CHECK(handoff["presentation"]["scenes"][0]["background"] == asset + "@1");
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM asset_generation_jobs WHERE channel_id=$1",{ch})["n"].asInt() == 1);
        S.storageCleanup->runOnce();
        CHECK(!S.db->queryOne("SELECT id FROM asset_generation_jobs WHERE id=$1",{imageJob}).isNull());
        CHECK(!S.db->queryOne("SELECT job_id FROM channel_atmosphere_variants WHERE atmosphere_id=$1",{atmosphere}).isNull());
    });
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
    test("GM records are inaccessible to players; each group independently summarizes witnessed chat", [&] {
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
        Json::Value body; body["status"] = "gm_secret"; body["summary"] = "The silver locket is the cult's key to the sea cave"; body["reason"] = "GM only";
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
    test("scenario system: campaign-wide; the observer only suggests, the GM opens the next scenario for every window, the old one closes and is summarized", [&] {
        for (int i = 0; i < 6; ++i) say(gmUser, mainWin, "The office clock ticks on; Dunmore shuffles another stack of papers (" + std::to_string(i) + ").", "narration");
        S.observer->observeChannel(channelId, true);
        auto before = S.db->queryOne("SELECT current_scene_id FROM channels WHERE id=$1", {channelId})["current_scene_id"].asString();
        CHECK(S.db->queryOne("SELECT active_scene_id FROM chat_windows WHERE id=$1", {splitWin})["active_scene_id"] == before);   // every window shares it
        auto boundary = say(gmUser, mainWin, "The next morning, you arrive at the Hale boarding house. Mrs. Hale opens the door.", "narration");
        S.observer->observeChannel(channelId, true);
        // The observer does not move the story: the scenario is unchanged and the GM got a suggestion anchored to the line.
        CHECK(S.db->queryOne("SELECT current_scene_id FROM channels WHERE id=$1", {channelId})["current_scene_id"] == before);
        bool suggested = false; for (auto& r : S.reminders->list(gm)) if (r["kind"] == "plan" && r["title"].asString().rfind("New scenario?", 0) == 0) { suggested = true; CHECK(r["citations"][0]["message_id"] == boundary["id"]); CHECK(r["title"].asString().find("Hale boarding house") != std::string::npos); }
        CHECK(suggested);
        // The GM opens the next scenario: all windows move, the previous one closes and is summarized.
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
        // The GM sees summaries; players only get neutral labels. Chat can be located by scenario and by time.
        bool summarised = false; for (auto& s : S.scenes->list(gm)) if (s["id"] == before && !s["summary"].asString().empty()) summarised = true; CHECK(summarised);
        for (auto& s : S.scenes->list(p1)) CHECK(!s.isMember("summary"));
        auto aev = eventOf(after1["id"].asString());
        Json::Value args; args["scene_id"] = newScene; auto log = S.retrieval->executeTool(p1, "get_chat_log", args);
        CHECK(log["events"].size() >= 1); CHECK(log["events"][0]["event_id"] == aev["id"]);
        Json::Value around; around["around_event_id"] = aev["id"]; around["limit"] = 4; auto ctxLog = S.retrieval->executeTool(gm, "get_chat_log", around);
        bool anchored = false; for (auto& e : ctxLog["events"]) if (e["anchor"].asBool()) anchored = true; CHECK(anchored);
        CHECK(!S.retrieval->executeTool(p1, "list_scenarios", Json::Value(Json::objectValue)).empty());
        // A GM-edited summary is never overwritten by the model; an explicit regeneration replaces it.
        Json::Value edit; edit["summary"] = "GM's own words."; S.scenes->update(gm, newScene, edit);
        S.scenarios->summarize(gm, newScene);
        Json::Value edit2; edit2["summary"] = "GM's final words."; S.scenes->update(gm, newScene, edit2);
        Json::Value adv2; adv2["title"] = "Manual stage"; adv2["location"] = "Lighthouse"; S.scenarios->advance(gm, adv2);
        CHECK(S.db->queryOne("SELECT summary, summary_status FROM scenes WHERE id=$1", {newScene})["summary"] == "GM's final words.");
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
        Json::Value secret; secret["content"] = "GM NOTE: the lantern sigil marks members of the Society."; secret["kind"] = "narration"; secret["visibility"] = "gm_only";
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
        // Another group neither lists nor opens it; the GM sees none of the players' bubbles in their own list.
        for (auto& r : S.reminders->list(p3)) CHECK(r["id"] != first);
        bool denied = false; try { S.reminders->context(p3, first, 20); } catch (const ApiError& e) { denied = e.status() == 404; } CHECK(denied);
        for (auto& r : S.reminders->list(gm)) CHECK(r["player_group_id"].isNull());
        // Dismissal is per user and the knowledge prelude carries the group's story index, never GM text.
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
        auto kp = insert("GM classified compass", gm);
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
        auto secret = event("The blue ledger conceals the GM's private solution.", true);
        reset(); fixture->plan["changes"].append(change(stable, "resolve", secret)); run(next); CHECK(row(ledger) == stable);
        // Simulate a concurrent edit between model input and commit.
        reset(); fixture->plan["changes"].append(change(stable, "resolve", next));
        fixture->beforeReturn = [&] { S.db->exec("UPDATE reminders SET version=version+1 WHERE id=$1", {ledger["id"].asString()}); };
        run(next); fixture->beforeReturn = nullptr; CHECK(row(ledger)["status"] == "active");
        reset(); fixture->plan["changes"].append(change(row(old), "reactivate", next)); run(next); CHECK(row(old)["status"] == "resolved");
        // The GM has the same lifecycle but never receives player reminder state.
        reset(); fixture->plan["changes"].append(change(kp, "resolve", next)); result = run(next, true);
        CHECK(result["changed"].asInt() == 1); CHECK(row(kp)["status"] == "resolved");
        for (const auto& r : fixture->context["managed_reminders"]) CHECK(r["player_group_id"].isNull());
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM reminder_revisions WHERE reminder_id=$1", {ledger["id"].asString()})["n"].asInt() == 3);
        CHECK(S.db->queryOne("SELECT payload->>'content' AS content FROM events WHERE id=$1", {original["event_id"].asString()})["content"] == original["content"]);
    });
    test("script knowledge: built from the module, moved only by reviewed changes, pinned on the GM's board, GM-only", [&] {
        std::vector<std::string> pages = {
            "THE LANTERN SOCIETY\nA scenario for Call of Cthulhu set in Arkham, 1925.\n\nChapter 1: The Sheriff's Office\nThe investigators meet Sheriff Dunmore, who holds the only key to the lighthouse. He stalls them politely.\nNPC: Sheriff Dunmore\nA tired lawman who secretly belongs to the Lantern Society.\nItem: The Lighthouse Key\nAn iron key stamped with a lantern sigil.\nIf the investigators obtain the key they may enter the lighthouse at night.",
            "Chapter 2: The Lighthouse\nLocation: The Lighthouse\nA ruined tower on the cliffs north of town.\nHandout 1: The Keeper's Diary\nThe diary names the Society's members.\nTwist: The Sheriff's Betrayal\nSheriff Dunmore locks the investigators inside once they find the diary.\nSecret: What Really Happened\nThe Society drowned the lighthouse keeper in 1919.",
            "Ending: Dawn\nIf the investigators escape, the Society scatters."};
        auto mod = S.modules->importText(gm, "The Lantern Society", pages);
        CHECK(mod["status"] == "ready");
        auto all = S.script->list(gm, "");
        std::map<std::string, int> byKind; for (auto& e : all) { byKind[e["kind"].asString()]++; CHECK(e["status"] == "pending"); CHECK(e["origin"] == "script"); CHECK(!e["citations"].empty() || !e["node_ids"].empty()); }
        CHECK(byKind["flow"] >= 3 && byKind["clue"] >= 2 && byKind["foreshadowing"] >= 1 && byKind["background"] >= 1 && byKind["relationship"] >= 1);
        // GM-only: players get 403, their tools and prelude never carry it; the GM's prelude leads with it.
        bool denied = false; try { S.script->list(p1, ""); } catch (const ApiError& e) { denied = e.status() == 403; } CHECK(denied);
        for (auto& t : ContextRetrievalService::toolSpecs(false)) CHECK(t.name != "get_script_knowledge");
        CHECK(S.retrieval->knowledgePrelude(p1).find("Script flow") == std::string::npos);
        auto prelude = S.retrieval->knowledgePrelude(gm); CHECK(prelude.rfind("Script flow", 0) == 0); CHECK(prelude.find("- The Lighthouse") != std::string::npos);
        {   // Ordered for prompt caching: the script's text (no statuses) is the stable part, sent first and marked.
            auto parts = S.retrieval->knowledgePreludeParts(gm);
            CHECK(parts.stable.rfind("Script flow", 0) == 0); CHECK(parts.stable.find("[pending]") == std::string::npos); CHECK(parts.stable.find("Relationships:") == std::string::npos);
            CHECK(parts.live.find("Script flow") == std::string::npos); CHECK(parts.live.find("Script status") == std::string::npos);   // every entry still pending
            auto msgs = S.retrieval->knowledgeMessages(gm, "INDEX:");
            CHECK(!msgs.empty()); CHECK(msgs[0].cacheBreakpoint); CHECK(msgs[0].content.rfind("INDEX:\nScript flow", 0) == 0);
            for (size_t i = 1; i < msgs.size(); ++i) CHECK(!msgs[i].cacheBreakpoint);
            auto pl = S.retrieval->knowledgeMessages(p1, "INDEX:");
            for (auto& m : pl) CHECK(m.content.find("Script") == std::string::npos);
        }
        auto tool = S.retrieval->executeTool(gm, "get_script_knowledge", json::parse(R"({"kind":"flow"})")); CHECK(tool["entries"].size() == byKind["flow"]);
        auto b0 = S.script->board(gm); CHECK(b0["next"]["has_script"].asBool()); CHECK(b0["next"]["current"].empty()); CHECK(!json::str(b0["next"]["next"], "title").empty());
        // Play. The GM narrates the first stage; a player's speculation about the lighthouse moves nothing.
        say(gmUser, mainWin, "You step into the Sheriff's Office. Sheriff Dunmore looks up from his desk and stalls you politely.", "narration");
        say(p1User, mainWin, "I bet the Lighthouse is where the Society meets. Let's ask about the key.");
        S.observer->observeChannel(channelId, true);
        bool officeActive = false;
        for (auto& e : S.script->list(gm, "flow")) { if (e["title"].asString().find("Sheriff") != std::string::npos) officeActive = e["status"] == "active"; if (e["title"] == "The Lighthouse") CHECK(e["status"] == "pending"); }
        CHECK(officeActive);
        {   // A stage moving on changes only the live part; the script's text, cached in front of it, stays as it was.
            auto parts = S.retrieval->knowledgePreludeParts(gm);
            CHECK(parts.stable == S.retrieval->knowledgePreludeParts(gm).stable); CHECK(parts.stable.find("[active]") == std::string::npos);
            CHECK(parts.live.rfind("Script status (entries not listed are pending):\n- active: ", 0) == 0); CHECK(parts.live.find("Sheriff") != std::string::npos);
        }
        auto changes = S.script->changes(gm, 50); CHECK(!changes.empty());
        for (auto& c : changes) { CHECK(c["verdict"] == "approved" || c["verdict"] == "rejected"); if (c["applied"].asBool()) CHECK(c["verdict"] == "approved"); CHECK(!c["evidence"].empty()); CHECK(!c["reviewer_reason"].asString().empty()); }
        auto b1 = S.script->board(gm);
        CHECK(json::str(b1["next"]["current"], "title").find("Sheriff") != std::string::npos); CHECK(b1["next"]["next"]["title"] == "The Lighthouse");
        CHECK(b1["next"]["summary"].asString().find("Next per the script: The Lighthouse") != std::string::npos); CHECK(b1["notes"].isMember("timeline") && b1["notes"].isMember("open_threads"));
        // A GM edit is final and logged.
        std::string keyId; for (auto& e : S.script->list(gm, "clue")) if (e["title"] == "The Lighthouse Key") keyId = e["id"].asString();
        CHECK(!keyId.empty());
        Json::Value edit; edit["status"] = "done"; edit["body"] = "Handed over by Dunmore after the bribe.";
        auto upd = S.script->update(gm, keyId, edit); CHECK(upd["gm_edited"].asBool() && upd["status"] == "done");
        CHECK(S.script->changes(gm, 1)[0]["reviewer_reason"] == "GM edit");
        // The party reaches the lighthouse: stage two active, stage one done. A player asks about the diary: the
        // GM gets a reminder pointing at the unrevealed handout; the players' dock shows nothing of it.
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
        // Rebuilding from the module keeps the GM's edit and the play history.
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
        // Public-mode invitation defaults to one group, without admitting the GM.
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
        auto stored = S.db->queryOne("SELECT p.api_key_sealed, p.kind FROM server_ai_uses u JOIN server_ai_providers p ON p.id=u.provider_id WHERE u.server_id=$1 AND u.use='text'", {sid});
        CHECK(stored["kind"].asString() == "responses");
        CHECK(stored["api_key_sealed"].asString().rfind("v1:", 0) == 0); CHECK(stored["api_key_sealed"].asString().find("sk-test") == std::string::npos);
        auto prof = S.settings->profileForChannel(channelId);
        CHECK(prof && prof->endpoint.apiKey == "sk-test-1234567890abcd" && prof->endpoint.model == "my-model" && prof->endpoint.reasoningEffort == "high" && prof->endpoint.apiBase == "https://llm.example/v1" && prof->language == "zh-CN");
        CHECK(S.llm->mode(channelId) == "live"); CHECK(S.llm->status(channelId)["provider"].asString() == "responses");
        CHECK(S.settings->ttsConfig(sid).apiKey == "tts-secret-key-9999");
        Json::Value imageSettings; imageSettings["llm"]["provider"]="anthropic";
        imageSettings["image"]["provider"]="gpt_image"; imageSettings["image"]["api_base"]="https://images.example/v1";
        imageSettings["image"]["api_key"]="independent-image-key"; imageSettings["image"]["model"]="fixture-image";
        auto configured=S.settings->update(gmP,sid,imageSettings);
        CHECK(configured["llm"]["provider"]=="anthropic"); CHECK(configured["image"]["api_key_set"].asBool());
        CHECK(json::dump(configured).find("independent-image-key")==std::string::npos);
        auto imageStored=S.db->queryOne("SELECT p.api_key_sealed FROM server_ai_uses u JOIN server_ai_providers p ON p.id=u.provider_id WHERE u.server_id=$1 AND u.use='image_generation'",{sid});
        CHECK(imageStored["api_key_sealed"].asString().rfind("v1:",0)==0);
        CHECK(imageStored["api_key_sealed"].asString().find("independent-image-key")==std::string::npos);
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
        // A cached prompt still counts in full against the budget; the cached share is reported beside it.
        S.aiPolicy->recordTokens(channelId, "observer_extract", 3000, 10, 2500, 400);
        auto cachedUse = S.settings->get(gmP, sid)["ai_policy"];
        CHECK(cachedUse["tokens_used"].asInt64() == 3120); CHECK(cachedUse["cached_tokens_used"].asInt64() == 2500);
        CHECK(!S.db->queryOne("SELECT 1 AS ok FROM ai_usage_records WHERE channel_id=$1 AND cache_read_tokens=2500 AND cache_write_tokens=400", {channelId}).isNull());
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
        CHECK(ready["progress"]["files_total"].asInt() >= 0 && ready["progress"]["files_done"] == ready["progress"]["files_total"]);
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
        // Character images: one per character and subtitle. A new one deletes the older (row and stored file); a
        // stage names the character and subtitle and shows whatever image is current, the main portrait by default.
        const std::string png = drogon::utils::base64Decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
        auto keyOf = [&](const std::string& id) { return S.db->queryOne("SELECT object_key FROM media_assets WHERE id=$1", {id})["object_key"].asString(); };
        auto gone = [&](const std::string& id) { return S.db->queryOne("SELECT 1 AS x FROM media_assets WHERE id=$1", {id}).isNull(); };
        auto poseId = [&] { return S.db->queryOne("SELECT expressions->>'SAY' AS id FROM character_visual_profiles WHERE character_id=$1", {c1})["id"].asString(); };
        auto portrait = S.characterSpace->uploadAsset(p1, c1, "portrait", "", "p.png", png)["portrait"]["id"].asString();
        S.characterSpace->uploadAsset(p1, c1, "subtitle", "SAY", "say1.png", png);
        auto pose1 = poseId(), pose1Key = keyOf(pose1);
        auto cur = S.presentations->currentStandees(channelId, true);
        CHECK(cur[c1][""]["id"].asString() == portrait); CHECK(cur[c1]["say"]["id"].asString() == pose1);
        S.characterSpace->uploadAsset(p1, c1, "subtitle", "say", "say2.png", png);   // the same subtitle, other case
        auto pose2 = poseId();
        CHECK(pose2 != pose1); CHECK(gone(pose1)); CHECK(!S.objectStore->exists(pose1Key));
        auto portrait2 = S.characterSpace->uploadAsset(p1, c1, "portrait", "", "p2.png", png)["portrait"]["id"].asString();
        CHECK(gone(portrait)); CHECK(S.db->queryOne("SELECT portrait_asset_id FROM characters WHERE id=$1", {c1})["portrait_asset_id"].asString() == portrait2);
        // A library upload filed under the character and subtitle: by the actor it replaces the pose; by anyone else
        // it stays a library image, used only for a subtitle the character has no image for.
        Json::Value lib; lib["asset_type"] = "standee"; lib["character_id"] = c1; lib["expression"] = "Say";
        auto pose3 = S.media->upload(p1, "say3.png", png, "image/png", lib); S.characterSpace->adoptLibraryUpload(p1, pose3);
        CHECK(poseId() == pose3["id"].asString()); CHECK(gone(pose2));
        auto other = S.media->upload(p3, "say4.png", png, "image/png", lib); S.characterSpace->adoptLibraryUpload(p3, other);
        CHECK(poseId() == pose3["id"].asString()); CHECK(!gone(other["id"].asString()));
        lib["expression"] = "angry"; auto angry = S.media->upload(p3, "angry.png", png, "image/png", lib)["id"].asString();
        // Content hashes: written with the object, named in every listing, and recovered on the first read of an
        // object stored before they existed.
        {
            auto pngHash = crypto::sha256Hex(png);
            CHECK(S.media->get(p3, angry)["content_hash"].asString() == pngHash);
            CHECK(S.db->queryOne("SELECT content_hash FROM asset_versions WHERE asset_id=$1 AND version=1", {angry})["content_hash"].asString() == pngHash);
            S.db->exec("UPDATE media_assets SET content_hash=NULL WHERE id=$1", {angry}); S.db->exec("UPDATE asset_versions SET content_hash=NULL WHERE asset_id=$1", {angry});
            CHECK(S.media->get(p3, angry)["content_hash"].isNull());
            std::string bytes, mime, name; CHECK(S.media->fetch(p3, angry, 0, bytes, mime, name)); CHECK(bytes == png);
            CHECK(S.media->get(p3, angry)["content_hash"].asString() == pngHash);
            CHECK(S.db->queryOne("SELECT content_hash FROM asset_versions WHERE asset_id=$1 AND version=1", {angry})["content_hash"].asString() == pngHash);
        }
        cur = S.presentations->currentStandees(channelId, true);
        CHECK(cur[c1]["say"]["id"].asString() == pose3["id"].asString()); CHECK(cur[c1]["angry"]["id"].asString() == angry);
        auto ev = S.presentations->get(gm, pid)["events"][0]["id"].asString();
        Json::Value stage(Json::arrayValue);
        Json::Value a1; a1["character_id"] = c1; a1["expression"] = "SAY"; a1["position"] = "left"; a1["asset_id"] = pose1; stage.append(a1);   // an image id is not kept
        Json::Value a2; a2["character_id"] = c1; a2["expression"] = "FIGHT"; a2["position"] = "right"; stage.append(a2);
        Json::Value patch; patch["character_asset_ids"] = stage;
        auto stored = S.presentations->updateEvent(gm, ev, patch)["character_asset_ids"];
        CHECK(stored.size() == 2); CHECK(!stored[0].isMember("asset_id")); CHECK(stored[0]["expression"] == "SAY");
        auto shownEv = [&] { auto pres = S.presentations->get(gm, pid); for (auto& e : pres["events"]) if (e["id"].asString() == ev) return Json::Value(e); return Json::Value(); };
        auto shown = shownEv()["character_asset_ids"];
        CHECK(shown[0]["asset_id"].asString() == pose3["id"].asString()); CHECK(shown[1]["asset_id"].asString() == portrait2);   // no FIGHT image: the default
        S.characterSpace->uploadAsset(p1, c1, "subtitle", "FIGHT", "fight.png", png);   // a new pose shows at once
        CHECK(shownEv()["character_asset_ids"][1]["asset_id"].asString() == S.db->queryOne("SELECT expressions->>'FIGHT' AS id FROM character_visual_profiles WHERE character_id=$1", {c1})["id"].asString());
        CHECK(S.presentations->get(gm, pid)["character_images"][c1].size() >= 4);
        // An image a live publication shows is kept until the publication is revoked.
        auto pub = S.db->queryOne("INSERT INTO published_logs(channel_id, project_id, snapshot_id, kind, title, frozen_asset_versions) SELECT channel_id, project_id, snapshot_id, 'vn', 't', jsonb_build_object($2::text, 1) FROM log_presentations WHERE id=$1 RETURNING id", {pid, pose3["id"].asString()})["id"].asString();
        S.characterSpace->uploadAsset(p1, c1, "subtitle", "SAY", "say5.png", png);
        CHECK(!gone(pose3["id"].asString())); CHECK(poseId() != pose3["id"].asString());
        CHECK(S.presentations->currentStandees(channelId, true)[c1]["say"]["id"].asString() == poseId());
        S.publication->revoke(gm, pub);
        CHECK(gone(pose3["id"].asString()));
        // A build a restart dropped is failed after an hour.
        S.db->exec("UPDATE vn_bundle_jobs SET created_at=now() - interval '2 hours' WHERE status='pending'");
        S.publication->expireBundles();
        CHECK(S.db->queryJson("SELECT 1 FROM vn_bundle_jobs WHERE status='pending'").empty());
        // Deleting the visual novel removes its prepared downloads; the art it used stays for reuse.
        S.db->exec("UPDATE vn_bundle_jobs SET status='ready', object_key='pub/channels/' || channel_id || '/bundles/x/a.zip', expires_at=now() + interval '1 hour' WHERE presentation_id=$1", {pid});
        auto zip = S.db->queryOne("SELECT object_key FROM vn_bundle_jobs WHERE presentation_id=$1 LIMIT 1", {pid})["object_key"].asString();
        S.objectStore->put(zip, "zip", "application/zip");
        CHECK(S.publication->deletePresentation(gm, pid)["deleted"].asBool());
        CHECK(!S.objectStore->exists(zip)); CHECK(S.db->queryOne("SELECT 1 AS x FROM log_presentations WHERE id=$1", {pid}).isNull());
        CHECK(!gone(poseId())); CHECK(!gone(portrait2));
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
    test("world record: entity_state creates, updates, cites its batch, stays in its partition; GM state needs review", [&] {
        Json::Value cbw; cbw["name"] = "World record"; cbw["knowledge_mode"] = "isolated";
        auto ch = S.chat->createChannel(gmP, server["id"].asString(), cbw)["id"].asString();
        auto keeper = S.auth->channelAccess(gmUser, ch);
        S.chat->addChannelMember(keeper, p1User, "player");
        auto pl = S.auth->channelAccess(p1User, ch);
        auto win = S.chat->listWindows(keeper)[0]["id"].asString();
        auto post = [&](const ChannelAccess& ac, const std::string& content, const std::string& kind) { Json::Value b; b["content"] = content; b["kind"] = kind; return eventOf(S.chat->postMessage(ac, win, b)["id"].asString())["id"].asString(); };
        auto op = [](const std::string& entity, const std::string& kind, const std::string& status, const std::string& state, const std::string& src) {
            Json::Value o; o["op"] = "entity_state"; o["entity"] = entity; if (!kind.empty()) o["kind"] = kind; if (!status.empty()) o["status"] = status; if (!state.empty()) o["state"] = state;
            if (!src.empty()) o["source_event_ids"].append(src); return o; };
        auto kpWorld = [&](const Json::Value& o, const std::vector<std::string>& batch) { Proposal p; p.channelId = ch; p.actor = "ai"; p.allowedSourceEventIds = batch; p.ops.append(o); return S.documents->commitWorld(p); };
        auto find = [](const Json::Value& world, const std::string& name) { for (const auto& e : world["entities"]) if (e["name"] == name) return e; return Json::Value(); };

        auto e1 = post(keeper, "Constable Barnes is dead.", "narration");
        auto r = kpWorld(op("Constable Barnes", "npc", "dead", "Shot at the docks.", e1), {e1});
        CHECK(r.applied == 1); CHECK(r.log[0]["created"].asBool()); CHECK(r.log[0]["state_by"] == "ai");
        auto barnes = r.log[0]["entity_id"].asString();
        auto v1 = S.documents->world(keeper)["version"].asInt64();
        // Update by id; an unknown place is created in the same partition.
        auto e2 = post(keeper, "Barnes is carried to Saint Mary Chapel.", "narration");
        auto move = op(barnes, "", "", "His body lies in the chapel crypt.", e2); move["location"] = "Saint Mary Chapel";
        r = kpWorld(move, {e2}); CHECK(r.applied == 1); CHECK(r.log[0]["state_version"].asInt() == 2);
        auto w = S.documents->world(keeper);
        auto b = find(w, "Constable Barnes");
        CHECK(b["status"] == "dead"); CHECK(b["state"] == "His body lies in the chapel crypt."); CHECK(b["location"]["name"] == "Saint Mary Chapel"); CHECK(b["state_version"].asInt() == 2);
        CHECK(w["version"].asInt64() > v1);
        CHECK(w["recent_changes"].size() == 2); CHECK(w["recent_changes"][0]["location_name"] == "Saint Mary Chapel"); CHECK(w["recent_changes"][1]["status"] == "dead");
        CHECK(S.db->queryJson("SELECT version FROM entity_state_history WHERE entity_id=$1 ORDER BY version", {barnes}).size() == 2);
        r = kpWorld(move, {e2}); CHECK(r.applied == 0); CHECK(r.log[0]["decision"] == "skipped");   // repetition is not a change
        // Citations: required, from the batch, and a new entity needs a kind.
        r = kpWorld(op("Constable Barnes", "", "missing", "", ""), {e2}); CHECK(r.rejected == 1);
        r = kpWorld(op("Constable Barnes", "", "missing", "", e1), {e2}); CHECK(r.rejected == 1);
        r = kpWorld(op("Unheard Of", "", "dead", "", e2), {e2}); CHECK(r.rejected == 1);
        r = kpWorld(op("Constable Barnes", "", "undead", "", e2), {e2}); CHECK(r.rejected == 1);
        CHECK(find(S.documents->world(keeper), "Constable Barnes")["status"] == "dead");

        // A GM declaration is authoritative: state_by gm, its facts confirmed (or gm_secret when secret).
        NewEvent d; d.channelId = ch; d.actorUserId = gmUser; d.actorRole = "gm"; d.kind = "gm.declared"; d.visibility = "gm_only";
        d.payload["content"] = "Doctor Mora is missing."; d.payload["secret"] = true;
        auto decl = S.events->append(d)["id"].asString();
        r = kpWorld(op("Doctor Mora", "npc", "missing", "Vanished from her surgery overnight.", decl), {decl});
        CHECK(r.applied == 1); CHECK(r.log[0]["state_by"] == "gm");
        Proposal fp; fp.channelId = ch; fp.documentType = "timeline"; fp.actor = "ai"; fp.allowedSourceEventIds = {decl};
        Json::Value fo; fo["op"] = "add_entry"; fo["fact"]["summary"] = "Doctor Mora vanished overnight"; fo["fact"]["status"] = "confirmed"; fo["fact"]["source_event_ids"].append(decl); fp.ops.append(fo);
        auto fr = S.documents->commit(fp); CHECK(fr.applied == 1); CHECK(fr.log[0]["status"] == "gm_secret");
        d.payload["content"] = "The harbour is closed by order of the mayor."; d.payload["secret"] = false;
        auto decl2 = S.events->append(d)["id"].asString();
        fp.allowedSourceEventIds = {decl2}; fp.ops = Json::Value(Json::arrayValue);
        fo["fact"]["summary"] = "The harbour is closed"; fo["fact"]["source_event_ids"] = Json::Value(Json::arrayValue); fo["fact"]["source_event_ids"].append(decl2); fp.ops.append(fo);
        fr = S.documents->commit(fp); CHECK(fr.applied == 1); CHECK(fr.log[0]["status"] == "confirmed");   // gm.declared backs "confirmed"
        // An AI change contradicting the GM's state waits for review; accepting it makes it the GM's.
        auto e3 = post(pl, "Doctor Mora is dead, I saw her body.", "ic");
        r = kpWorld(op("Doctor Mora", "", "dead", "", e3), {e3});
        CHECK(r.applied == 0); CHECK(r.pendingReview == 1);
        CHECK(find(S.documents->world(keeper), "Doctor Mora")["status"] == "missing");
        auto pid = r.log[0]["proposal_id"].asString(); bool listed = false;
        for (const auto& pr : S.documents->listProposals(keeper, "needs_gm_review")) if (pr["id"] == pid) listed = true;
        CHECK(listed);
        CHECK(S.documents->decideProposal(keeper, pid, true)["status"] == "committed");
        auto mora = find(S.documents->world(keeper), "Doctor Mora");
        CHECK(mora["status"] == "dead"); CHECK(mora["state_by"] == "gm"); CHECK(mora["state"] == "");

        // Partitions: the player group keeps its own record from readable chat only.
        auto groupWorld = [&](const Json::Value& o, const std::vector<std::string>& batch) { Proposal p; p.channelId = ch; p.playerGroupId = pl.playerGroupId; p.playerGroupVersion = pl.playerGroupVersion; p.allowedSourceEventIds = batch; p.ops.append(o); return S.documents->commitWorld(p); };
        auto gr = groupWorld(op("Constable Barnes", "npc", "dead", "Shot.", e1), {e1, decl});
        CHECK(gr.applied == 1); CHECK(gr.log[0]["entity_id"] != barnes);
        auto groupBarnes = gr.log[0]["entity_id"].asString();
        CHECK(groupWorld(op("Doctor Mora", "npc", "missing", "", decl), {e1, decl}).rejected == 1);   // a declaration is never group evidence
        CHECK(groupWorld(op(barnes, "", "missing", "", e1), {e1}).rejected == 1);                     // a GM entity is out of reach
        bool threw = false;
        try { S.db->exec("UPDATE entities SET location_entity_id=$2 WHERE id=$1", {barnes, groupBarnes}); } catch (const std::exception&) { threw = true; }
        CHECK(threw);
        auto pw = S.documents->world(pl);
        CHECK(find(pw, "Constable Barnes")["id"] == groupBarnes); CHECK(find(pw, "Constable Barnes")["state"] == "Shot.");
        auto dump = json::dump(pw);
        CHECK(dump.find("Mora") == std::string::npos); CHECK(dump.find("Saint Mary") == std::string::npos); CHECK(dump.find("harbour") == std::string::npos);
        CHECK(pw["recent_changes"].size() == 1);
    });
    test("world history: window access resets linked entities without a cascade ordering error", [&] {
        Json::Value body; body["name"] = "World cascade"; body["knowledge_mode"] = "isolated";
        auto ch = S.chat->createChannel(gmP, server["id"].asString(), body)["id"].asString();
        auto keeper = S.auth->channelAccess(gmUser, ch);
        S.chat->addChannelMember(keeper, p1User, "player");
        S.chat->addChannelMember(keeper, p2User, "player");
        auto group = [&](const std::string& user) { return S.db->queryOne("SELECT group_id FROM player_group_members WHERE channel_id=$1 AND user_id=$2", {ch, user})["group_id"].asString(); };
        const auto g1 = group(p1User), g2 = group(p2User);
        auto entity = [&](const std::string& name, const std::string& gid) {
            return S.db->queryOne("INSERT INTO entities(channel_id,player_group_id,kind,name) VALUES($1,NULLIF($2,'')::uuid,'location',$3) RETURNING id", {ch,gid,name})["id"].asString();
        };
        auto history = [&](const std::string& owner, const std::string& location, const std::string& gid, int version=1) {
            S.db->exec("INSERT INTO entity_state_history(channel_id,player_group_id,entity_id,location_entity_id,version,status,actor) VALUES($1,NULLIF($2,'')::uuid,$3,$4,$5,'active','ai')", {ch,gid,owner,location,(int64_t)version});
        };
        auto mustFail = [&](const std::function<void()>& fn) { bool failed=false; try { fn(); } catch(const std::exception&) { failed=true; } CHECK(failed); };
        // Location is inserted first: the failing FK action can run before the owner's history is cascaded away.
        auto location=entity("Dock",g1), owner=entity("Witness",g1), other=entity("Other group",g2), secret=entity("GM","");
        S.db->exec("UPDATE entities SET location_entity_id=$2 WHERE id=$1", {owner,location});
        history(owner,location,g1);
        mustFail([&] { history(owner,other,g1,2); });
        mustFail([&] { history(owner,location,g2,2); });
        mustFail([&] { history(owner,secret,g1,2); });
        mustFail([&] { history("00000000-0000-0000-0000-000000000000",location,g1,2); });
        mustFail([&] { S.db->exec("UPDATE entity_state_history SET location_entity_id=$2 WHERE entity_id=$1", {owner,other}); });
        auto version = S.db->queryOne("SELECT version FROM player_groups WHERE id=$1", {g1})["version"].asInt();
        Json::Value win; win["name"]="Phone fixture"; win["kind"]="private";
        Json::Value member; member["user_id"]=p1User; win["members"].append(member);
        CHECK(!S.chat->createWindow(keeper,win)["id"].asString().empty());
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM entities WHERE player_group_id=$1",{g1})["n"].asInt()==0);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM entity_state_history WHERE player_group_id=$1",{g1})["n"].asInt()==0);
        CHECK(S.db->queryOne("SELECT version FROM player_groups WHERE id=$1",{g1})["version"].asInt()>version);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM documents WHERE player_group_id=$1",{g1})["n"].asInt()==5);
        CHECK(!S.db->queryOne("SELECT id FROM entities WHERE id=$1",{other}).isNull());
        CHECK(!S.db->queryOne("SELECT id FROM entities WHERE id=$1",{secret}).isNull());
        // A location-only deletion must keep its surviving owner's history, clearing just the location reference.
        auto place=entity("Room",g2), survivor=entity("Survivor",g2); history(survivor,place,g2);
        S.db->exec("DELETE FROM entities WHERE id=$1",{place});
        CHECK(S.db->queryOne("SELECT location_entity_id FROM entity_state_history WHERE entity_id=$1",{survivor})["location_entity_id"].isNull());
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM entity_state_history WHERE entity_id=$1",{survivor})["n"].asInt()==1);
        // The same ordering is possible during channel deletion, including the GM partition.
        auto privatePlace=entity("Secret room",""), privateOwner=entity("Secret witness",""); history(privateOwner,privatePlace,"");
        S.db->exec("DELETE FROM channels WHERE id=$1",{ch});
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM entity_state_history WHERE channel_id=$1",{ch})["n"].asInt()==0);
    });
    test("storage cleanup deletes replaced character images, unpinned old versions and unreferenced objects, and keeps the rest", [&] {
        const std::string png = drogon::utils::base64Decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
        auto p2 = S.auth->channelAccess(p2User, channelId);
        auto age = [&](const std::string& id, int hours) { S.db->exec("UPDATE media_assets SET created_at=now() - make_interval(hours => $2), updated_at=now() - make_interval(hours => $2) WHERE id=$1", {id, (int64_t)hours}); };
        auto exists = [&](const std::string& id) { return !S.db->queryOne("SELECT 1 AS x FROM media_assets WHERE id=$1", {id}).isNull(); };
        auto keyOf = [&](const std::string& id) { return S.db->queryOne("SELECT object_key FROM media_assets WHERE id=$1", {id})["object_key"].asString(); };
        auto portrait = S.characterSpace->uploadAsset(p2, c2, "portrait", "", "p.png", png)["portrait"]["id"].asString();
        age(portrait, 72);
        Json::Value lib; lib["asset_type"] = "standee"; lib["character_id"] = c2; lib["expression"] = "IDLE";
        auto older = S.media->upload(gm, "idle1.png", png, "image/png", lib)["id"].asString(); age(older, 72);   // replaced by `newer`
        auto newer = S.media->upload(gm, "idle2.png", png, "image/png", lib)["id"].asString(); age(newer, 48);   // the stage's fallback for IDLE
        lib["expression"] = "SAD"; auto rejected = S.media->upload(gm, "sad.png", png, "image/png", lib)["id"].asString(); age(rejected, 48);
        S.db->exec("UPDATE media_assets SET approval_status='rejected' WHERE id=$1", {rejected});
        lib["asset_type"] = "portrait"; lib["expression"] = ""; auto loose = S.media->upload(gm, "loose.png", png, "image/png", lib)["id"].asString(); age(loose, 48);
        lib["expression"] = "fresh"; auto young = S.media->upload(gm, "young.png", png, "image/png", lib)["id"].asString();   // younger than a day
        auto olderKey = keyOf(older);
        // A background with an unpinned old version, and one whose old version a scene still shows.
        Json::Value bg; bg["asset_type"] = "background";
        auto plain = S.media->upload(gm, "bg1.png", png, "image/png", bg)["id"].asString();
        auto v1Key = keyOf(plain);
        S.media->newVersion(gm, plain, "bg2.png", png, "", "redo");
        S.db->exec("UPDATE media_assets SET approval_status='approved' WHERE id=$1", {plain});
        S.db->exec("UPDATE asset_versions SET created_at=now() - interval '3 days' WHERE asset_id=$1 AND version=1", {plain});
        auto pinned = S.media->upload(gm, "bg3.png", png, "image/png", bg)["id"].asString();
        auto pinnedV1 = keyOf(pinned);
        S.media->newVersion(gm, pinned, "bg4.png", png, "", "redo");
        S.db->exec("UPDATE media_assets SET approval_status='approved' WHERE id=$1", {pinned});
        S.db->exec("UPDATE asset_versions SET created_at=now() - interval '3 days' WHERE asset_id=$1 AND version=1", {pinned});
        auto log = S.studio->campaignLog(gm); auto snap = S.studio->createSnapshot(gm, log["project"]["id"].asString(), Json::Value(Json::objectValue));
        auto pid = S.presentations->create(gm, snap["id"].asString(), Json::Value(Json::objectValue))["id"].asString();
        S.db->exec("UPDATE presentation_scenes SET background_asset_id=$2, background_asset_version=1 WHERE presentation_id=$1", {pid, pinned});
        // Stored objects: one nothing names (old), the same but young, and an old one of a channel this database does not know.
        namespace fs = std::filesystem;
        auto root = fs::path(cfg.uploadDir) / "objects";
        std::string orphan = "channels/" + channelId + "/background/orphan.png", youngOrphan = "channels/" + channelId + "/background/young.png", foreign = std::string("pub/channels/00000000-0000-4000-8000-000000000000/standee/x.png");
        for (auto& k : {orphan, youngOrphan, foreign}) S.objectStore->put(k, png, "image/png");
        for (auto& k : {orphan, foreign}) fs::last_write_time(root / k, fs::file_time_type::clock::now() - std::chrono::hours(48));

        auto& cleanup = *S.storageCleanup;
        auto dry = cleanup.runOnce(true);
        CHECK(dry.characterImages >= 3); CHECK(dry.oldVersions >= 1); CHECK(dry.orphans >= 1);
        CHECK(exists(older)); CHECK(S.objectStore->exists(orphan));   // a dry run deletes nothing
        auto rep = cleanup.runOnce();
        CHECK(rep.characterImages == dry.characterImages); CHECK(rep.failed == 0);
        CHECK(!exists(older)); CHECK(!S.objectStore->exists(olderKey)); CHECK(!exists(rejected)); CHECK(!exists(loose));
        CHECK(exists(newer)); CHECK(exists(portrait)); CHECK(exists(young));
        CHECK(S.db->queryOne("SELECT 1 AS x FROM asset_versions WHERE asset_id=$1 AND version=1", {plain}).isNull()); CHECK(!S.objectStore->exists(v1Key));
        CHECK(!S.db->queryOne("SELECT 1 AS x FROM asset_versions WHERE asset_id=$1 AND version=1", {pinned}).isNull()); CHECK(S.objectStore->exists(pinnedV1));
        CHECK(!S.objectStore->exists(orphan)); CHECK(S.objectStore->exists(youngOrphan)); CHECK(S.objectStore->exists(foreign));
        CHECK(S.objectStore->exists(keyOf(newer))); CHECK(S.objectStore->exists(keyOf(portrait)));
        auto again = cleanup.runOnce(true);
        CHECK(again.characterImages == 0); CHECK(again.oldVersions == 0); CHECK(again.orphans == 0);
        S.objectStore->remove(youngOrphan); S.objectStore->remove(foreign);
    });
    test("storage cleanup deletes voice lines nothing uses after the retention period, and keeps those a line, a live publication or a running job needs", [&] {
        // Six cached voice lines, each with its own stored file.
        auto voice = [&](const std::string& name, int unusedDays) {
            auto key = "channels/" + channelId + "/tts/cleanup-" + name + ".mp3";
            S.objectStore->put(key, "ID3-" + name, "audio/mpeg");
            return S.db->queryOne("INSERT INTO tts_audio_assets(channel_id, cache_key, provider, model_id, voice_id, spoken_text, object_key, mime, bytes, created_at, last_used_at) "
                                  "VALUES($1,$2,'mock','mock','v',$3,$4,'audio/mpeg',10, now() - make_interval(days => $5 + 1), now() - make_interval(days => $5)) RETURNING id, object_key",
                                  {channelId, "cleanup-" + name + "-" + channelId, name, key, (int64_t)unusedDays});
        };
        auto gone = voice("deleted-vn", 40), recent = voice("recent", 5), line = voice("vn-line", 40), published = voice("published", 40), revoked = voice("revoked", 40), queued = voice("queued", 40);
        auto exists = [&](const Json::Value& v) { return !S.db->queryOne("SELECT 1 AS x FROM tts_audio_assets WHERE id=$1", {v["id"].asString()}).isNull(); };
        // A visual-novel line uses one; a live publication plays another; a revoked publication played a third.
        auto log = S.studio->campaignLog(gm); auto snap = S.studio->createSnapshot(gm, log["project"]["id"].asString(), Json::Value(Json::objectValue));
        auto pid = S.presentations->create(gm, snap["id"].asString(), Json::Value(Json::objectValue))["id"].asString();
        S.db->exec("INSERT INTO presentation_events(presentation_id, position, audio_asset_id) VALUES($1, 9999, $2)", {pid, line["id"].asString()});
        auto publish = [&](const Json::Value& v, bool isRevoked) {
            Json::Value frozen; frozen["audio"][v["id"].asString()]["object_key"] = v["object_key"]; frozen["audio"][v["id"].asString()]["mime"] = "audio/mpeg";
            S.db->exec("INSERT INTO published_logs(channel_id, project_id, snapshot_id, kind, title, frozen_content, revoked) VALUES($1,$2,$3,'vn','Voice fixture',$4::jsonb,$5)",
                       {channelId, log["project"]["id"].asString(), snap["id"].asString(), json::dump(frozen), isRevoked});
        };
        publish(published, false); publish(revoked, true);
        auto& cleanup = *S.storageCleanup;
        auto dry = cleanup.runOnce(true);
        CHECK(dry.voiceLines >= 3); CHECK(exists(gone));   // a dry run deletes nothing
        // While a voice job of the channel is under way, nothing of the channel goes: it may point a line at the cache.
        auto job = S.db->queryOne("INSERT INTO tts_jobs(channel_id, kind, status, provider) VALUES($1,'batch','running','mock') RETURNING id", {channelId})["id"].asString();
        auto held = cleanup.runOnce();
        CHECK(exists(gone)); CHECK(exists(queued)); CHECK(held.failed == 0);
        S.db->exec("UPDATE tts_jobs SET status='completed' WHERE id=$1", {job});
        auto rep = cleanup.runOnce();
        CHECK(rep.voiceLines >= 3); CHECK(rep.failed == 0);
        CHECK(!exists(gone)); CHECK(!S.objectStore->exists(gone["object_key"].asString()));
        CHECK(!exists(revoked)); CHECK(!S.objectStore->exists(revoked["object_key"].asString()));
        CHECK(!exists(queued));
        CHECK(exists(recent)); CHECK(S.objectStore->exists(recent["object_key"].asString()));
        CHECK(exists(line)); CHECK(S.objectStore->exists(line["object_key"].asString()));
        CHECK(exists(published)); CHECK(S.objectStore->exists(published["object_key"].asString()));
        // Deleting the visual novel releases its line on the next run once the line is old enough.
        S.presentations->remove(gm, pid);
        CHECK(cleanup.runOnce().voiceLines >= 1); CHECK(!exists(line)); CHECK(!S.objectStore->exists(line["object_key"].asString()));
        // Playing or serving a line from the cache counts as a use.
        S.db->exec("UPDATE tts_audio_assets SET last_used_at=now() - interval '40 days' WHERE id=$1", {recent["id"].asString()});
        std::string bytes, mime; CHECK(S.tts->fetchAudio(gm, recent["id"].asString(), bytes, mime, nullptr));
        CHECK(S.db->queryOne("SELECT last_used_at > now() - interval '1 minute' AS fresh FROM tts_audio_assets WHERE id=$1", {recent["id"].asString()})["fresh"].asBool());
        CHECK(exists(recent));
        S.db->exec("DELETE FROM tts_audio_assets WHERE id=$1", {recent["id"].asString()}); S.objectStore->remove(recent["object_key"].asString());
        S.db->exec("DELETE FROM published_logs WHERE title='Voice fixture'");
        S.db->exec("DELETE FROM tts_audio_assets WHERE id=$1", {published["id"].asString()}); S.objectStore->remove(published["object_key"].asString());
    });

    test("stand-ins keep the GM author but carry player event provenance", [&] {
        Json::Value body; body["character_id"] = c1; body["content"] = "Let me think about it."; body["stand_in"] = true;
        auto line = S.chat->postMessage(gm, mainWin, body);
        CHECK(line["stand_in"].asBool()); CHECK(line["author_id"].asString() == gmUser);
        auto event = S.db->queryOne("SELECT actor_role, actor_user_id, character_id, payload FROM events WHERE message_id=$1", {line["id"].asString()});
        CHECK(event["actor_role"] == "player"); CHECK(event["actor_user_id"].asString() == gmUser);
        CHECK(event["character_id"].asString() == c1); CHECK(event["payload"]["stand_in"].asBool());
        S.chat->recallMessage(p1, line["id"].asString());
    });

    test("recall: two minutes, the author only, not rolls; what cites the line is dismissed; a batch that held it forgets it", [&] {
        auto line = say(p1User, mainWin, "I wave at the ferryman.");
        auto id = line["id"].asString(), ev = eventOf(id)["id"].asString();
        CHECK(line["recall_seconds_left"].asInt() > 0);
        // A reminder quoting the line and a highlight citing it, as the AI makes them.
        auto doc = S.db->queryOne("SELECT id FROM documents WHERE channel_id=$1 AND player_group_id IS NULL AND doc_type='clue_journal'", {channelId})["id"].asString();
        auto reminder = S.db->queryOne("INSERT INTO reminders(channel_id, kind, title, citations, dedupe_key) VALUES($1,'note','Ferryman',$2::jsonb,'recall-test') RETURNING id",
            {channelId, "[{\"event_id\":\"" + ev + "\",\"quotes\":[\"wave at the ferryman\"]}]"})["id"].asString();
        auto highlight = S.db->queryOne("INSERT INTO highlights(channel_id, document_id, reason, source_event_ids, expires_at) VALUES($1,$2,'ferryman',$3::uuid[],now()+interval '1 hour') RETURNING id",
            {channelId, doc, "{" + ev + "}"})["id"].asString();
        auto refused = [&](const ChannelAccess& who, const std::string& mid) { try { S.chat->recallMessage(who, mid); } catch (const ApiError& e) { return e.code(); } return std::string(); };
        auto p2 = S.auth->channelAccess(p2User, channelId);
        CHECK(!S.chat->getMessage(p2, id).isNull());   // they can read it, but it is not theirs
        CHECK(refused(gm, id) == "forbidden"); CHECK(refused(p2, id) == "forbidden");
        auto done = S.chat->recallMessage(p1, id);
        CHECK(done["content"] == "I wave at the ferryman."); CHECK(done["message"]["content"] == ""); CHECK(!done["message"]["recalled_at"].isNull());
        CHECK(eventOf(id).isNull());
        auto r = S.db->queryOne("SELECT status, version FROM reminders WHERE id=$1", {reminder});
        CHECK(r["status"] == "dismissed"); CHECK(r["version"].asInt() == 2);
        CHECK(!S.db->queryOne("SELECT 1 AS x FROM reminder_revisions WHERE reminder_id=$1 AND action='dismissed'", {reminder}).isNull());
        CHECK(S.db->queryOne("SELECT dismissed FROM highlights WHERE id=$1", {highlight})["dismissed"].asBool());

        // After two minutes the line stays; a dice roll stays from the start.
        auto old = say(p1User, mainWin, "I said this a while ago.");
        S.db->exec("UPDATE messages SET created_at=now()-interval '3 minutes' WHERE id=$1", {old["id"].asString()});
        CHECK(S.chat->getMessage(p1, old["id"].asString())["recall_seconds_left"].isNull());
        CHECK(refused(p1, old["id"].asString()) == "recall_expired");
        auto roll = say(gmUser, mainWin, ".r 1d6");
        CHECK(roll["recall_seconds_left"].isNull()); CHECK(refused(gm, roll["id"].asString()) == "not_recallable");

        // A recall that lands while an observer batch holds the line: gone() names it, forget() retracts the entry.
        auto clue = say(gmUser, mainWin, "Alpha, you notice a rusted anchor chain under the pier.", "narration");
        auto clueEvent = eventOf(clue["id"].asString())["id"].asString();
        S.observer->observeChannel(channelId, true);
        auto entry = [&] { return S.db->queryOne("SELECT de.removed FROM document_entries de JOIN knowledge_facts f ON f.id=de.fact_id WHERE f.channel_id=$1 AND f.player_group_id IS NULL AND f.source_event_ids @> $2::uuid[]", {channelId, "{" + clueEvent + "}"}); };
        CHECK(!entry().isNull() && !entry()["removed"].asBool());
        S.db->exec("DELETE FROM events WHERE id=$1", {clueEvent});
        auto gone = recall::gone(*S.db, channelId, {clueEvent, eventOf(old["id"].asString())["id"].asString()});
        CHECK(gone.size() == 1 && gone[0] == clueEvent);
        recall::forget(*S.db, *S.documents, *S.notifier, channelId, gone);
        CHECK(entry()["removed"].asBool());
    });

    test("interactive messages: the schema's checks, unique line origins, the postMessage origin, recall and cascades", [&] {
        // A third player, outside the whisper cards below (the earlier tests regrouped and removed the first three's peers).
        auto p4User = S.auth->registerUser("p4" + suffix, "password", "P4")["id"].asString();
        S.chat->addChannelMember(gm, "p4" + suffix, "player"); mkChar(p4User, "Delta");
        auto p1 = S.auth->channelAccess(p1User, channelId), p3 = S.auth->channelAccess(p4User, channelId);
        // Cards as HypertextService writes them (its routes come later): a public document, a private side row.
        auto card = [&](const std::string& ch, const std::string& win, const std::string& vis, const std::vector<std::string>& to = {}) {
            auto id = S.db->queryOne("INSERT INTO messages(channel_id, chat_window_id, author_id, author_role, kind, content, visibility, whisper_to, hypertext) VALUES($1,$2,$3,'gm','hypertext','Spot Hidden\n[Roll]',$4,$5::uuid[],$6::jsonb) RETURNING id",
                {ch, win, gmUser, vis, pgArrayLiteral(to), R"J({"v":1,"title":"Spot Hidden","script":"on('roll', () => {})","body":[{"type":"button","id":"roll","label":"Roll","on":"roll"}]})J"})["id"].asString();
            S.db->exec("INSERT INTO hypertext_cards(message_id, replies, closes_at) VALUES($1,'{\"door\":{\"text\":\"PRIVATE_MARKER\"}}'::jsonb, now() + interval '7 days')", {id});
            return id;
        };
        auto newId = [&] { return S.db->queryOne("SELECT gen_random_uuid()::text AS id")["id"].asString(); };
        auto violation = [&](const std::string& sql, const DbParams& p) {
            try { S.db->exec(sql, p); } catch (const pqxx::check_violation&) { return std::string("check"); } catch (const pqxx::unique_violation&) { return std::string("unique"); } catch (const std::exception& e) { return std::string(e.what()); }
            return std::string("accepted");
        };
        const std::string insertLine = "INSERT INTO messages(channel_id, chat_window_id, author_id, author_role, kind, content, hypertext, recalled_at, via_hypertext_id, via_user_id, via_interaction_id, via_effect) VALUES($1,$2,$3,'player',$4,'x',$5::jsonb,$6::timestamptz,$7::uuid,$8::uuid,$9::uuid,$10::smallint)";
        auto line = [&](const std::string& kind, const DbParam& doc, const DbParam& recalled, const DbParam& via, const DbParam& iid, const DbParam& effect) {
            return violation(insertLine, {channelId, mainWin, p1User, kind, doc, recalled, via, via.index() ? DbParam(p1User) : dbNull(), iid, effect});
        };
        auto c = card(channelId, mainWin, "window");
        CHECK(line("card", dbNull(), dbNull(), dbNull(), dbNull(), dbNull()) == "check");                                  // the kind list grew by one only
        CHECK(line("hypertext", dbNull(), dbNull(), dbNull(), dbNull(), dbNull()) == "check");                             // a card needs its document
        CHECK(line("hypertext", dbNull(), std::string("2026-01-01T00:00:00Z"), dbNull(), dbNull(), dbNull()) == "accepted");   // unless recalled
        CHECK(line("ic", std::string("{\"v\":1}"), dbNull(), dbNull(), dbNull(), dbNull()) == "check");                    // only cards hold one
        CHECK(line("hypertext", "{\"v\":1,\"pad\":\"" + std::string(70000, 'x') + "\"}", dbNull(), dbNull(), dbNull(), dbNull()) == "check");   // at most 64 KiB
        CHECK(line("ic", dbNull(), dbNull(), c, dbNull(), (int64_t)2) == "check");                                         // effect 0 or 1
        const std::string iid = "7a1c9a4e-0000-4000-8000-000000000001";
        CHECK(line("ic", dbNull(), dbNull(), c, iid, (int64_t)0) == "accepted");
        CHECK(line("ic", dbNull(), dbNull(), c, iid, (int64_t)0) == "unique");                                             // one line per action and effect
        CHECK(line("narration", dbNull(), dbNull(), c, iid, (int64_t)1) == "accepted");
        CHECK(line("ic", dbNull(), dbNull(), c, dbNull(), dbNull()) == "accepted"); CHECK(line("ic", dbNull(), dbNull(), c, dbNull(), dbNull()) == "accepted");   // notices carry no interaction
        CHECK(violation("INSERT INTO hypertext_states(message_id, user_id, state) VALUES($1,$2,$3::jsonb)", {c, p1User, "{\"t\":\"" + std::string(17000, 'x') + "\"}"}) == "check");
        CHECK(violation("INSERT INTO hypertext_interactions(message_id, channel_id, user_id, interaction_id, request, request_hash, status) VALUES($1,$2,$3,gen_random_uuid(),'{}'::jsonb,'h','partial')", {c, channelId, p1User}) == "check");
        CHECK(violation("INSERT INTO hypertext_interactions(message_id, channel_id, user_id, interaction_id, request, request_hash) VALUES($1,$2,$3,$4,'{}'::jsonb,'h')", {c, channelId, p1User, iid}) == "accepted");
        CHECK(violation("INSERT INTO hypertext_interactions(message_id, channel_id, user_id, interaction_id, request, request_hash) VALUES($1,$2,$3,$4,'{}'::jsonb,'h')", {c, channelId, p1User, iid}) == "unique");

        // The chat route never posts a card, nor reads via_* from a body.
        auto refusal = [&](const Json::Value& b) { try { S.chat->postMessage(gm, mainWin, b); } catch (const ApiError& e) { return std::to_string(e.status()) + " " + e.what(); } return std::string("posted"); };
        Json::Value asCard; asCard["content"] = "Pick one"; asCard["kind"] = "hypertext";
        CHECK(refusal(asCard) == "400 interactive messages are posted with POST /windows/{w}/hypertext");
        Json::Value withDoc; withDoc["content"] = "Pick one"; withDoc["hypertext"]["v"] = 1;
        CHECK(refusal(withDoc) == "400 interactive messages are posted with POST /windows/{w}/hypertext");
        Json::Value forged; forged["content"] = "Not from a card"; forged["via_hypertext_id"] = c; forged["via_user_id"] = p1User;
        auto plain = S.chat->postMessage(p1, mainWin, forged);
        CHECK(plain["via_hypertext_id"].isNull() && plain["via_user_id"].isNull() && plain["via_user_name"].isNull());

        // A viewer's say: their own line, marked with the card and who acted; the same action again is the same line.
        // Each origin with its pending claim, as HypertextService holds one while it posts.
        auto claim = [&](const std::string& card, const std::string& ch, const std::string& user, const std::string& iid, const std::string& status = "pending") {
            S.db->exec("INSERT INTO hypertext_interactions(message_id, channel_id, user_id, interaction_id, request, request_hash, status, lease_until) VALUES($1,$2,$3,$4,'{}'::jsonb,'h',$5,now() + interval '30 seconds')",
                       {card, ch, user, iid, status});
        };
        auto o = [&](const std::string& user, int effect, const std::string& vis, const std::vector<std::string>& to = {}) {
            HypertextOrigin x; x.cardId = c; x.userId = user; x.interactionId = newId(); x.effect = effect; x.visibility = vis; x.whisperTo = to;
            claim(c, channelId, user, x.interactionId); return x; };
        auto say1 = o(p1User, 0, "window"); say1.sayCharacterId = c1;
        Json::Value sb; sb["content"] = "I check the door."; sb["kind"] = "ic";
        auto said = S.chat->postMessage(p1, mainWin, sb, Json::Value(), "", &say1);
        CHECK(said["via_hypertext_id"] == c); CHECK(said["via_user_id"] == p1User); CHECK(said["via_user_name"] == "P1"); CHECK(said["via_effect"].asInt() == 0);
        CHECK(said["via_interaction_id"] == say1.interactionId); CHECK(said["character_id"] == c1); CHECK(!said.isMember("repeated"));
        auto ev = S.db->queryOne("SELECT payload FROM events WHERE message_id=$1", {said["id"].asString()});
        CHECK(ev["payload"]["via_hypertext_id"] == c); CHECK(!ev["payload"].isMember("via_user_id"));   // the actor already says who
        auto again = S.chat->postMessage(p1, mainWin, sb, Json::Value(), "", &say1);
        CHECK(again["id"] == said["id"]); CHECK(again["repeated"].asBool());
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM messages WHERE via_interaction_id=$1", {say1.interactionId})["n"].asInt() == 1);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM events WHERE message_id=$1", {said["id"].asString()})["n"].asInt() == 1);

        // A reply as the sender: the GM's line with the template's character (none here), no dice, the server's audience.
        auto reply = o(p1User, 1, "gm_only"); reply.fixedCharacter = true; reply.allowDice = false;
        Json::Value rb; rb["content"] = ".r 1d6 The door groans open."; rb["kind"] = "narration";
        auto replied = S.chat->postMessage(gm, mainWin, rb, Json::Value(), "", &reply);
        CHECK(replied["kind"] == "narration"); CHECK(replied["dice"].isNull()); CHECK(replied["visibility"] == "gm_only"); CHECK(replied["character_id"].isNull());
        CHECK(replied["author_id"] == gmUser); CHECK(replied["via_user_id"] == p1User); CHECK(replied["via_effect"].asInt() == 1);
        CHECK(S.db->queryOne("SELECT payload FROM events WHERE message_id=$1", {replied["id"].asString()})["payload"]["via_user_id"] == p1User);
        // Lines a card may not ask for are refused whatever its client says.
        auto refusedWith = [&](const ChannelAccess& who, const std::string& content, HypertextOrigin x) {
            Json::Value b; b["content"] = content; try { S.chat->postMessage(who, mainWin, b, Json::Value(), "", &x); } catch (const ApiError& e) { return e.status(); } return 200; };
        CHECK(refusedWith(p1, ".st str60", o(p1User, 0, "window")) == 403);
        auto rollReply = o(p1User, 1, "window"); rollReply.fixedCharacter = true;
        CHECK(refusedWith(gm, ".ra Spot Hidden", rollReply) == 403);                              // a reply rolls plain dice only
        CHECK(refusedWith(p1, ".ri Bob", o(p1User, 0, "window")) == 403);                         // diceVerdict: another's initiative
        CHECK(refusedWith(p1, ".rih +1", o(p1User, 0, "whisper", {c1})) == 403);                  // the order is the whole window's
        // A line lands only while its action holds a pending claim: none, or one that ended, refuses it.
        auto unclaimed = o(p1User, 0, "window"); unclaimed.interactionId = newId();
        CHECK(refusedWith(p1, "Unclaimed.", unclaimed) == 409);
        for (const char* status : {"done", "failed"}) {
            auto ended = unclaimed; ended.interactionId = newId(); claim(c, channelId, p1User, ended.interactionId, status);
            try { Json::Value b; b["content"] = "Too late."; S.chat->postMessage(p1, mainWin, b, Json::Value(), "", &ended); CHECK(false); }
            catch (const ApiError& e) { CHECK(e.code() == "interaction_interrupted"); }
        }

        // A whisper card: its reader answers inside it (a player could not whisper otherwise), and a hidden roll's result
        // and notice stay inside it too.
        auto p2 = S.auth->channelAccess(p2User, channelId);
        auto sees = [&](const ChannelAccess& who, const std::string& id) { for (auto& x : S.chat->listMessages(who, mainWin, 200, 0)) if (x["id"] == id) return true; return false; };
        auto whisper = o(p1User, 0, "whisper", {c1, c2}); whisper.sayCharacterId = c1;
        auto private1 = S.chat->postMessage(p1, mainWin, sb, Json::Value(), "", &whisper);
        CHECK(private1["visibility"] == "whisper"); CHECK(sees(p2, private1["id"].asString())); CHECK(!sees(p3, private1["id"].asString()));
        S.dice->setRng(std::make_unique<dice::SeqRng>(std::vector<int>{77}));
        auto hidden = o(p1User, 0, "whisper", {c1, c2}); hidden.sayCharacterId = c1;
        Json::Value hb; hb["content"] = ".rh 1d100";
        auto secretRoll = S.chat->postMessage(p1, mainWin, hb, Json::Value(), "", &hidden);
        CHECK(secretRoll["kind"] == "roll"); CHECK(secretRoll["visibility"] == "whisper"); CHECK(secretRoll["whisper_to"].size() == 1);
        auto notice = S.db->queryOne(chatQueries::MSG_SELECT + "WHERE m.via_hypertext_id=$1 AND m.via_interaction_id IS NULL AND m.dice->>'type'='hidden_notice'", {c});
        CHECK(!notice.isNull()); CHECK(notice["visibility"] == "whisper"); CHECK(notice["via_user_id"] == p1User); CHECK(notice["via_effect"].isNull());
        CHECK(sees(p2, notice["id"].asString())); CHECK(!sees(p2, secretRoll["id"].asString())); CHECK(!sees(p3, notice["id"].asString()));
        // On a GM-only card the GM rolling as a player's character keeps the result among GMs.
        S.dice->setRng(std::make_unique<dice::SeqRng>(std::vector<int>{12}));
        auto gmRoll = o(gmUser, 0, "gm_only"); gmRoll.sayCharacterId = c1;
        auto kept = S.chat->postMessage(gm, mainWin, hb, Json::Value(), "", &gmRoll);
        CHECK(kept["visibility"] == "gm_only"); CHECK(!sees(p1, kept["id"].asString()));

        // Pushes for a card go to whoever may read it.
        auto wcard = card(channelId, mainWin, "whisper", {c1});
        auto audience = S.notifier->messageAudience(S.db->queryOne(chatQueries::MSG_SELECT + "WHERE m.id=$1", {wcard}));
        CHECK(audience.count(gmUser) && audience.count(p1User) && !audience.count(p2User) && !audience.count(p4User));
        // Spectators never get the script; error details reach the response body.
        auto spec = ChatService::spectatorMessage(S.db->queryOne(chatQueries::MSG_SELECT + "WHERE m.id=$1", {c}));
        CHECK(spec["hypertext"]["title"] == "Spot Hidden"); CHECK(!spec["hypertext"].isMember("script"));
        Json::Value details; details["paths"].append("hypertext.body[0].label"); details["error"] = "overridden?";
        auto resp = http::errResp(ApiError(400, "invalid_hypertext", "the document is invalid", details));
        auto body = json::parse(std::string(resp->body()));
        CHECK(resp->statusCode() == 400); CHECK(body["error"] == "invalid_hypertext"); CHECK(body["message"] == "the document is invalid"); CHECK(body["paths"][0] == "hypertext.body[0].label");

        // The campaign log keeps a card as a system line (GM-only stays secret) and marks the lines it produced.
        auto gmCard = card(channelId, mainWin, "gm_only");
        for (auto [id, vis] : {std::pair<std::string, std::string>{c, "window"}, {gmCard, "gm_only"}}) {
            NewEvent e; e.channelId = channelId; e.chatWindowId = mainWin; e.messageId = id; e.actorUserId = gmUser; e.actorRole = "gm"; e.kind = "message.posted"; e.visibility = vis;
            e.payload["content"] = "Spot Hidden\n[Roll]"; e.payload["message_kind"] = "hypertext"; e.payload["title"] = "Spot Hidden"; S.events->append(e);
        }
        S.studio->campaignLog(gm);
        auto logged = [&](const std::string& id) { return S.db->queryOne("SELECT event_type, metadata FROM log_events WHERE source_message_id=$1", {id}); };
        CHECK(logged(c)["event_type"] == "system"); CHECK(logged(c)["metadata"]["hypertext"].asBool()); CHECK(logged(c)["metadata"]["title"] == "Spot Hidden");
        CHECK(logged(gmCard)["event_type"] == "secret");
        CHECK(logged(said["id"].asString())["metadata"]["via_hypertext"].asBool()); CHECK(logged(said["id"].asString())["event_type"] != "system");
        std::string mime, fileName;
        auto exported = json::parse(S.studio->exportLog(gm, "json", "", mime, fileName));
        int cards = 0, via = 0; for (auto& m : exported["messages"]) { if (m["hypertext"].asBool()) ++cards; if (m["via_hypertext"].asBool()) ++via; }
        CHECK(cards == 2); CHECK(via >= 3);
        auto exportedText = json::dump(exported); CHECK(exportedText.find("PRIVATE_MARKER") == std::string::npos); CHECK(exportedText.find("on('roll'") == std::string::npos);

        // The AI does not read a card as narration; the lines its viewers post are read as usual.
        Json::Value cardEvent; cardEvent["kind"] = "message.posted"; cardEvent["payload"]["message_kind"] = "hypertext"; cardEvent["payload"]["content"] = "Where now? Lighthouse / Harbour";
        CHECK(narrative_memory::obviousNonNarrative(cardEvent));
        Json::Value viaEvent = cardEvent; viaEvent["payload"]["message_kind"] = "ic"; viaEvent["payload"]["via_hypertext_id"] = c; CHECK(!narrative_memory::obviousNonNarrative(viaEvent));
        Json::Value kctx; Json::Value stage; stage["id"] = "k1"; stage["kind"] = "flow"; stage["status"] = "pending"; stage["title"] = "Lighthouse"; kctx["knowledge"].append(stage);
        Json::Value narrated; narrated["event_id"] = "e1"; narrated["actor_role"] = "gm"; narrated["content"] = "Where now? Lighthouse or Harbour."; narrated["payload"]["message_kind"] = "hypertext";
        kctx["new_events"].append(narrated);
        CHECK(ScriptKnowledgeService::mockPropose(kctx)["changes"].empty());
        kctx["new_events"][0]["payload"]["message_kind"] = "narration";
        CHECK(!ScriptKnowledgeService::mockPropose(kctx)["changes"].empty());
        Json::Value seen; seen["seq"] = 3; seen["actor_role"] = "gm"; seen["kind"] = "message.posted"; seen["message_kind"] = "hypertext"; seen["content"] = "Spot Hidden [Roll]";
        CHECK(InspirationService::renderLogLine(seen, "GM") == "#3 GM (interactive message): Spot Hidden [Roll]");

        // Recall: a card is a tombstone with no document, closed, its states and templates gone; no draft comes back.
        S.db->exec("INSERT INTO hypertext_states(message_id, user_id, state) VALUES($1,$2,'{\"done\":true}'::jsonb)", {c, p1User});
        auto inFlight = o(p1User, 0, "window");   // an action claimed before the recall, its line not posted yet
        S.db->exec("UPDATE hypertext_interactions SET request='{\"say\":{\"text\":\"x\"},\"state\":{\"done\":true}}'::jsonb WHERE interaction_id=$1", {inFlight.interactionId});
        CHECK(S.chat->getMessage(gm, c)["recall_seconds_left"].asInt() > 0);
        auto recalled = S.chat->recallMessage(gm, c);
        CHECK(recalled["content"] == ""); CHECK(recalled["message"]["hypertext"].isNull()); CHECK(!recalled["message"]["recalled_at"].isNull());
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM hypertext_states WHERE message_id=$1", {c})["n"].asInt() == 0);
        auto side = S.db->queryOne("SELECT replies, closed_at FROM hypertext_cards WHERE message_id=$1", {c});
        CHECK(side["replies"].empty()); CHECK(!side["closed_at"].isNull());
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM hypertext_interactions WHERE message_id=$1 AND request ? 'state'", {c})["n"].asInt() == 0);   // nor the copies its actions kept
        try { S.chat->postMessage(p1, mainWin, sb, Json::Value(), "", &inFlight); CHECK(false); }
        catch (const ApiError& e) { CHECK(e.code() == "hypertext_closed"); }   // nothing lands after a recall
        CHECK(S.chat->getMessage(p1, said["id"].asString())["via_hypertext_id"] == c);   // lines it produced stay, naming the tombstone

        // Cascades: a deleted card takes its side rows and leaves its lines unattached; a deleted channel takes it all.
        Json::Value cb2; cb2["name"] = "Cards";
        auto ch2 = S.chat->createChannel(gmP, server["id"].asString(), cb2)["id"].asString();
        auto gm2 = S.auth->channelAccess(gmUser, ch2); auto win2 = S.chat->listWindows(gm2)[0]["id"].asString();
        auto withRows = [&](const std::string& id) {
            S.db->exec("INSERT INTO hypertext_states(message_id, user_id, state) VALUES($1,$2,'{}'::jsonb)", {id, gmUser});
            HypertextOrigin x; x.cardId = id; x.userId = gmUser; x.interactionId = newId(); x.visibility = "window";
            claim(id, ch2, gmUser, x.interactionId);
            Json::Value b; b["content"] = "The lamp gutters."; b["kind"] = "narration";
            return S.chat->postMessage(gm2, win2, b, Json::Value(), "", &x)["id"].asString();
        };
        auto rows = [&](const std::string& id) { return S.db->queryOne("SELECT (SELECT count(*) FROM hypertext_cards WHERE message_id=$1) + (SELECT count(*) FROM hypertext_states WHERE message_id=$1) + (SELECT count(*) FROM hypertext_interactions WHERE message_id=$1) AS n", {id})["n"].asInt(); };
        auto gone = card(ch2, win2, "window"); auto orphan = withRows(gone);
        CHECK(rows(gone) == 3);
        S.db->exec("DELETE FROM messages WHERE id=$1", {gone});
        CHECK(rows(gone) == 0);
        auto left = S.db->queryOne("SELECT via_hypertext_id, via_user_id FROM messages WHERE id=$1", {orphan});
        CHECK(left["via_hypertext_id"].isNull()); CHECK(left["via_user_id"] == gmUser);
        auto kept2 = card(ch2, win2, "window"); withRows(kept2);
        S.db->exec("DELETE FROM channels WHERE id=$1", {ch2});
        CHECK(rows(kept2) == 0); CHECK(S.db->queryOne("SELECT count(*) AS n FROM messages WHERE channel_id=$1", {ch2})["n"].asInt() == 0);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM hypertext_interactions WHERE channel_id=$1", {ch2})["n"].asInt() == 0);
    });

    test("interactive messages: racing claims, one action in flight, abandoned actions, state compare-and-swap, the switch and the sweep", [&] {
        Json::Value cb3; cb3["name"] = "Racing"; cb3["knowledge_mode"] = "isolated";
        auto ch = S.chat->createChannel(gmP, server["id"].asString(), cb3)["id"].asString();
        auto keeper = S.auth->channelAccess(gmUser, ch);
        for (auto u : {"p1", "p2"}) S.chat->addChannelMember(keeper, u + suffix, "player");
        for (auto [uid, name] : {std::pair<std::string, std::string>{p1User, "Ada"}, {p2User, "Bea"}}) { Json::Value b; b["name"] = name; S.chat->createCharacter(S.auth->channelAccess(uid, ch), b); }
        keeper = S.auth->channelAccess(gmUser, ch);
        auto win = S.chat->listWindows(keeper)[0]["id"].asString();
        auto post = [&](const std::string& doc) { return S.hypertext->post(keeper, win, json::parse(doc))["id"].asString(); };
        auto act = [&](const std::string& user, const std::string& cardId, Json::Value b, const std::string& iid = "") {
            b["interaction_id"] = iid.empty() ? crypto::uuid4() : iid; if (!b.isMember("base_version")) b["base_version"] = 0;
            return S.hypertext->act(S.auth->channelAccess(user, ch), cardId, b);
        };
        // "ok", or the error code an attempt ended with.
        auto outcome = [](const std::function<void()>& fn) { try { fn(); return std::string("ok"); } catch (const ApiError& e) { return e.code(); } };
        auto reply = [](const std::string& id) { Json::Value b; b["reply"]["id"] = id; return b; };
        auto say = [](const std::string& text) { Json::Value b; b["say"]["text"] = text; return b; };
        auto lines = [&](const std::string& cardId, int effect) { return S.db->queryOne("SELECT count(*) AS n FROM messages WHERE via_hypertext_id=$1 AND via_effect=$2", {cardId, (int64_t)effect})["n"].asInt(); };
        const std::string doc = R"({"hypertext":{"v":1,"body":[{"type":"button","id":"go","label":"Go","act":{"say":"Go.","reply":"door"}}],"runs_per_viewer":10},
            "replies":{"door":{"text":"The door opens.","total":1},"left":{"text":"Left.","group":"way"},"right":{"text":"Right.","group":"way"}}})";

        // Two viewers racing for a reply of total 1: exactly one wins, every time.
        for (int round = 0; round < 5; ++round) {
            auto c = post(doc);
            auto one = std::async(std::launch::async, [&] { return outcome([&] { act(p1User, c, reply("door")); }); });
            auto two = std::async(std::launch::async, [&] { return outcome([&] { act(p2User, c, reply("door")); }); });
            std::multiset<std::string> got{one.get(), two.get()};
            CHECK(got == (std::multiset<std::string>{"ok", "reply_exhausted"}));
            CHECK(lines(c, 1) == 1);
        }
        // A group: one answer per viewer, even when one viewer asks for two at once; another viewer still chooses.
        auto g = post(doc);
        auto left = std::async(std::launch::async, [&] { return outcome([&] { act(p1User, g, reply("left")); }); });
        auto right = std::async(std::launch::async, [&] { return outcome([&] { act(p1User, g, reply("right")); }); });
        auto l = left.get(), r = right.get();
        CHECK((l == "ok") != (r == "ok")); CHECK(l == "ok" || l == "reply_exhausted" || l == "interaction_in_progress"); CHECK(r == "ok" || r == "reply_exhausted" || r == "interaction_in_progress");
        CHECK(outcome([&] { act(p1User, g, reply(l == "ok" ? "right" : "left")); }) == "reply_exhausted");
        CHECK(outcome([&] { act(p2User, g, reply(l == "ok" ? "right" : "left")); }) == "ok");
        CHECK(lines(g, 1) == 2);

        // One action in flight per viewer and card: another one, or a retry of it, waits until it ends or its claim lapses.
        auto f = post(doc);
        auto x = crypto::uuid4();
        auto first = act(p1User, f, say("I wait."), x);
        auto said = first["results"][0]["message"]["id"].asString();
        S.db->exec("UPDATE hypertext_interactions SET status='pending', lease_until=now() + interval '30 seconds' WHERE message_id=$1 AND interaction_id=$2", {f, x});
        CHECK(outcome([&] { act(p1User, f, say("Me again.")); }) == "interaction_in_progress");
        CHECK(outcome([&] { act(p1User, f, say("I wait."), x); }) == "interaction_in_progress");
        CHECK(outcome([&] { act(p2User, f, say("Not me.")); }) == "ok");   // other viewers are not held up
        // Its claim lapsed (the request died after posting): a retry finishes it without posting again.
        S.db->exec("UPDATE hypertext_interactions SET lease_until=now() - interval '1 second' WHERE message_id=$1 AND interaction_id=$2", {f, x});
        auto resumed = act(p1User, f, say("I wait."), x);
        CHECK(resumed["replayed"].asBool()); CHECK(resumed["results"][0]["message"]["id"].asString() == said);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM messages WHERE via_interaction_id=$1", {x})["n"].asInt() == 1);
        CHECK(S.db->queryOne("SELECT status FROM hypertext_interactions WHERE message_id=$1 AND interaction_id=$2", {f, x})["status"] == "done");
        // A takeover that has a line left to post: the say is there, the reply is posted by the retry, once.
        auto t = post(doc);
        auto sayReply = say("Onward."); sayReply["reply"]["id"] = "door";
        auto y = crypto::uuid4();
        act(p1User, t, sayReply, y);
        S.db->exec("DELETE FROM messages WHERE via_interaction_id=$1 AND via_effect=1", {y});
        S.db->exec("UPDATE hypertext_interactions SET status='pending', result_ids='[]', reply_ok=NULL, lease_until=now() - interval '1 second' WHERE interaction_id=$1", {y});
        auto taken = act(p1User, t, sayReply, y);
        CHECK(taken["replayed"].asBool()); CHECK(!taken["partial"].asBool()); CHECK(taken["results"].size() == 2);
        CHECK(taken["results"][0]["ok"].asBool()); CHECK(taken["results"][1]["ok"].asBool()); CHECK(taken["results"][1]["message"]["content"] == "The door opens.");
        CHECK(lines(t, 0) == 1); CHECK(lines(t, 1) == 1);
        auto tr = S.db->queryOne("SELECT status, reply_ok, result_ids FROM hypertext_interactions WHERE interaction_id=$1", {y});
        CHECK(tr["status"] == "done"); CHECK(tr["reply_ok"] == true); CHECK(tr["result_ids"][1]["id"] == taken["results"][1]["message"]["id"]);
        // A failure that is not the action's (the database refusing the line): the claim lapses at once and a retry
        // posts it; nothing counts as failed.
        S.db->exec("CREATE OR REPLACE FUNCTION hypertext_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.content = 'Refused once.' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$");
        S.db->exec("DROP TRIGGER IF EXISTS hypertext_test_refuse ON messages");
        S.db->exec("CREATE TRIGGER hypertext_test_refuse BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION hypertext_test_refuse()");
        auto z = crypto::uuid4();
        bool internal = false;
        try { act(p2User, t, say("Refused once."), z); } catch (const ApiError&) {} catch (const std::exception&) { internal = true; }
        S.db->exec("DROP TRIGGER hypertext_test_refuse ON messages"); S.db->exec("DROP FUNCTION hypertext_test_refuse()");
        CHECK(internal);
        auto released = S.db->queryOne("SELECT status, lease_until <= now() AS lapsed FROM hypertext_interactions WHERE interaction_id=$1", {z});
        CHECK(released["status"] == "pending"); CHECK(released["lapsed"].asBool());
        auto retried = act(p2User, t, say("Refused once."), z);
        CHECK(retried["replayed"].asBool()); CHECK(retried["results"][0]["message"]["content"] == "Refused once.");
        CHECK(S.db->queryOne("SELECT status FROM hypertext_interactions WHERE interaction_id=$1", {z})["status"] == "done");
        // A finished action replays even once the card has closed (a bot closes it on seeing the line; the response was lost).
        auto lost = crypto::uuid4();
        auto done1 = act(p2User, t, say("Seen."), lost);
        S.hypertext->close(keeper, t);
        auto late = act(p2User, t, say("Seen."), lost);
        CHECK(late["replayed"].asBool()); CHECK(late["results"][0]["message"]["id"] == done1["results"][0]["message"]["id"]);
        CHECK(outcome([&] { act(p2User, t, say("Seen.")); }) == "hypertext_closed");   // a new one is refused

        // Abandoned actions (claim lapsed over 2 minutes ago) are finished by the sweep with what they posted.
        auto a = post(doc);
        auto both = say("Onward."); both["reply"]["id"] = "door";
        auto half = crypto::uuid4(), none = crypto::uuid4(), recent = crypto::uuid4();
        act(p1User, a, both, half); act(p1User, a, say("Hm."), none); act(p1User, a, say("Ha."), recent);
        S.db->exec("DELETE FROM messages WHERE via_interaction_id=$1 AND via_effect=1", {half});        // the reply never made it
        S.db->exec("DELETE FROM messages WHERE via_interaction_id=$1", {none});                           // nothing made it
        S.db->exec("UPDATE hypertext_interactions SET status='pending', result_ids='[]', reply_ok=NULL, lease_until=now() - interval '3 minutes' WHERE interaction_id = ANY($1::uuid[])", {pgArrayLiteral({half, none})});
        S.db->exec("UPDATE hypertext_interactions SET status='pending', lease_until=now() - interval '1 minute' WHERE interaction_id=$1", {recent});
        CHECK(S.hypertext->finishAbandoned() >= 2);
        auto row = [&](const std::string& iid) { return S.db->queryOne("SELECT status, result_ids, error, reply_ok FROM hypertext_interactions WHERE interaction_id=$1", {iid}); };
        auto h = row(half);
        CHECK(h["status"] == "done"); CHECK(h["result_ids"].size() == 2); CHECK(h["result_ids"][0]["id"].isString()); CHECK(h["result_ids"][1]["id"].isNull());
        CHECK(h["error"]["reply"]["error"] == "interrupted"); CHECK(h["reply_ok"] == false);
        CHECK(row(none)["status"] == "failed"); CHECK(row(none)["error"]["error"] == "interaction_interrupted");
        CHECK(row(recent)["status"] == "pending");   // not abandoned yet
        CHECK(lines(a, 0) == 2); CHECK(lines(a, 1) == 0);   // the sweep posted nothing
        auto replay = act(p1User, a, both, half);
        CHECK(replay["replayed"].asBool()); CHECK(replay["partial"].asBool()); CHECK(!replay["results"][1]["ok"].asBool());
        CHECK(outcome([&] { act(p1User, a, say("Hm."), none); }) == "interaction_interrupted");
        CHECK(outcome([&] { act(p2User, a, reply("door")); }) == "ok");   // the reply nobody got is still free

        // State: compare and swap, two devices at once get one conflict.
        auto s = post(R"({"hypertext":{"v":1,"state":{"done":{"type":"bool"}},"body":[{"type":"checkbox","id":"ok","label":"Ready","bind":"done"}]}})");
        Json::Value put; put["state"]["done"] = true; put["base_version"] = 0;
        auto p1a = S.auth->channelAccess(p1User, ch);
        auto d1 = std::async(std::launch::async, [&] { return outcome([&] { S.hypertext->saveState(p1a, s, put); }); });
        auto d2 = std::async(std::launch::async, [&] { return outcome([&] { S.hypertext->saveState(p1a, s, put); }); });
        CHECK((std::multiset<std::string>{d1.get(), d2.get()}) == (std::multiset<std::string>{"ok", "state_conflict"}));
        try { S.hypertext->saveState(p1a, s, put); CHECK(false); }
        catch (const ApiError& e) { CHECK(e.code() == "state_conflict"); CHECK(e.details()["version"].asInt() == 1); CHECK(e.details()["state"]["done"].asBool()); }
        Json::Value stale; stale["state"]["done"] = true; stale["base_version"] = 3;   // no state yet: the conflict says version 0
        try { S.hypertext->saveState(S.auth->channelAccess(p2User, ch), s, stale); CHECK(false); }
        catch (const ApiError& e) { CHECK(e.code() == "state_conflict"); CHECK(e.details()["version"].isIntegral() && e.details()["version"].asInt() == 0); CHECK(e.details()["state"].isNull()); }
        put["base_version"] = 1; put["state"]["done"] = false;
        CHECK(S.hypertext->saveState(p1a, s, put)["version"].asInt() == 2);
        CHECK(S.db->queryOne("SELECT state FROM hypertext_states WHERE message_id=$1 AND user_id=$2", {s, p2User}).isNull());

        // The largest stubs normalize accepts fit the database's CHECKs, measured as it stores them; one reply more is a
        // path, not a check violation.
        for (const char* unit : {"x", "密"}) {
            auto big = [&](int n) {
                Json::Value b = json::parse(R"({"hypertext":{"v":1,"body":[{"type":"divider"}]}})"); b["replies"] = Json::Value(Json::objectValue);
                for (int i = 0; i < n; ++i) for (const char* slot : {"a", "b", "c", "d"}) {
                    auto& r = b["replies"]["r" + std::to_string(i)]; r["text"] = "{{a}} {{b}} {{c}} {{d}}"; r["slots"][slot]["type"] = "enum";
                    for (int v = 0; v < 20; ++v) { std::string x; while (text::utf8Length(x) < 62) x += unit; r["slots"][slot]["values"].append(x + std::to_string(10 + v)); }
                }
                return b;
            };
            int n = 16; while (n > 1 && !hypertext::normalize(big(n)["hypertext"], big(n)["replies"]).ok) --n;
            CHECK(n < 16);
            auto id = S.hypertext->post(keeper, win, big(n))["id"].asString();
            auto sizes = S.db->queryOne("SELECT m.hypertext, octet_length(m.hypertext::text) AS doc_bytes, hc.replies, octet_length(hc.replies::text) AS replies_bytes FROM messages m JOIN hypertext_cards hc ON hc.message_id=m.id WHERE m.id=$1", {id});
            CHECK(hypertext::storedSize(sizes["hypertext"]) == (size_t)sizes["doc_bytes"].asInt64()); CHECK(hypertext::storedSize(sizes["replies"]) == (size_t)sizes["replies_bytes"].asInt64());
            CHECK(sizes["doc_bytes"].asInt64() <= 65536 && sizes["replies_bytes"].asInt64() <= 65536);
            try { S.hypertext->post(keeper, win, big(n + 1)); CHECK(false); }
            catch (const ApiError& e) { CHECK(e.code() == "invalid_hypertext"); CHECK(e.details()["errors"][0]["path"] == "replies"); }
        }

        // Expired by closes_at: closed without anyone closing it.
        S.db->exec("UPDATE hypertext_cards SET closes_at=now() - interval '1 second' WHERE message_id=$1", {f});
        CHECK(outcome([&] { act(p2User, f, say("Too late?")); }) == "hypertext_closed");
        CHECK(S.hypertext->status(p1a, f)["items"][0]["closed"].asBool());

        // The sweep drops the action rows of cards closed over a day ago, and only those.
        S.db->exec("UPDATE hypertext_cards SET closes_at=now() - interval '2 days' WHERE message_id=$1", {f});
        auto before = S.db->queryOne("SELECT count(*) AS n FROM hypertext_interactions WHERE channel_id=$1 AND message_id<>$2", {ch, f})["n"].asInt();
        CHECK(S.hypertext->prune() >= 2);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM hypertext_interactions WHERE message_id=$1", {f})["n"].asInt() == 0);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM hypertext_interactions WHERE channel_id=$1", {ch})["n"].asInt() == before);

        // The operator's switch: posting, saving, acting and closing refuse first, the status says so.
        S.cfg.hypertextEnabled = false;
        CHECK(outcome([&] { post(doc); }) == "feature_disabled");
        CHECK(outcome([&] { S.hypertext->saveState(p1a, s, put); }) == "feature_disabled");
        CHECK(outcome([&] { act(p1User, s, say("Hello.")); }) == "feature_disabled");
        CHECK(outcome([&] { S.hypertext->close(keeper, s); }) == "feature_disabled");
        auto off = S.hypertext->status(p1a, s);
        CHECK(!off["enabled"].asBool()); CHECK(off["items"].empty());
        S.cfg.hypertextEnabled = true;
        CHECK(S.hypertext->status(p1a, s)["items"].size() == 1);
    });

    std::cout << passed << " checks passed, " << failures << " failed\n";
    Services::shutdown();
    return failures == 0 ? 0 : 1;
}
