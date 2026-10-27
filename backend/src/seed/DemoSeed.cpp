#include "DemoSeed.h"
#include "../auth/AuthService.h"
#include "../chat/ChatService.h"
#include "../scenes/SceneManager.h"
#include "../observer/ObserverScheduler.h"
#include "../modules/ModuleImporter.h"
#include "../core/Json.h"
#include "../core/Log.h"

namespace acerciae {

std::vector<std::string> DemoSeed::demoModulePages() {
    return {
R"(THE LANTERN OF BLACKWATER COVE
An introductory scenario for Call of Cthulhu / Basic Roleplaying

Introduction
In the autumn of 1925 the fishing town of Blackwater Cove, Massachusetts, is troubled by lights seen on the water at night and by the disappearance of the lighthouse keeper, Elias Thorne. The investigators are hired by his sister, Mrs. Agnes Hale, to find out what became of him.

Keeper's Information
The truth is that Elias Thorne discovered a drowned idol in the shoals and brought it to the lighthouse. The idol calls to the Deep Ones at every new moon. Elias is not dead: he is held in the sea cave beneath the lighthouse, kept alive by the cult that calls itself the Lantern Society. The Sheriff, Amos Dunmore, is a member of the Lantern Society and will mislead the investigators while appearing helpful.
)",
R"(Chapter One: Arrival in Blackwater Cove

Scene: The Sheriff's Office
Sheriff Amos Dunmore receives the investigators politely. He claims the lighthouse was locked after Elias vanished and that he has the only key. If the investigators ask for the key, he promises to look for it and bring it to them later; he never intends to do so. A tarnished badge lies on his desk, bearing a lantern sigil rather than the county seal. A successful Spot Hidden notices the lantern sigil.

NPC: Sheriff Amos Dunmore
A heavy-set man of fifty with a careful smile. STR 70 CON 65 DEX 45 POW 60 SAN 40. Skills: Persuade 60%, Firearms 55%, Law 40%. He is secretly a member of the Lantern Society and reports the investigators' movements to the Society.

Scene: Hale Boarding House
Mrs. Agnes Hale offers rooms. She gives the investigators a letter from Elias, dated three weeks ago, that mentions "the lights that answer when I signal". Handout 1: Elias's Letter.
)",
R"(Chapter Two: The Town

Location: Blackwater Gazette Office
The newspaper office holds back issues. If the investigators search the archive (Library Use), they find a 1911 clipping about a shipwreck at the shoals and a photograph of a brass lantern recovered from the wreck. Secret documents in the editor's safe list payments from the Lantern Society to the Sheriff.

Location: Blackwater Docks
At night a mysterious figure in oilskins watches the water. If approached, he introduces himself as Jonah Pike and warns the investigators to stay off the water at the new moon. He drops a tarnished badge with the lantern sigil when he leaves.

Item: The Brass Lantern
A heavy brass lantern recovered from the 1911 wreck. When lit at the shoals, it summons the Deep Ones.

Item: The Lighthouse Key
An iron key. The Sheriff holds it. Only if the investigators obtain the key or break in can they reach the lighthouse interior.
)",
R"(Chapter Three: The Lighthouse

Condition: Entering the lighthouse requires the key, a successful Locksmith roll, or breaking the door (STR roll).
Scene: The Lighthouse Interior
The lamp room holds the drowned idol. A trapdoor leads to the sea cave.
Twist: The Sheriff's Betrayal
If the investigators show the Sheriff the secret documents, he attempts to have them arrested; otherwise he follows them to the lighthouse with two Society members.
Ending: Dawn at the Cove
If the idol is cast back into the sea, Elias is released and the lights cease. If the lantern is lit at the shoals, the Deep Ones rise and the town is lost.
)"};
}

static std::string ensureUser(Services& s, const std::string& username, const std::string& display) {
    auto r = s.db->queryOne("SELECT id FROM users WHERE username=$1", {username});
    if (!r.isNull()) return r["id"].asString();
    return s.auth->registerUser(username, "password", display)["id"].asString();
}

bool DemoSeed::run(Services& s, bool force) {
    auto existing = s.db->queryOne("SELECT c.id FROM channels c WHERE c.name=$1", {std::string("The Lantern of Blackwater Cove")});
    if (!existing.isNull() && !force) { ALOG_INFO << "demo campaign already present; skipping seed"; return false; }
    if (!existing.isNull() && force) { s.db->exec("DELETE FROM channels WHERE id=$1", {existing["id"].asString()}); }
    ALOG_INFO << "seeding demonstration campaign…";
    auto keeperId = ensureUser(s, "keeper", "The Keeper");
    auto aliceId = ensureUser(s, "alice", "Alice");
    auto bobId = ensureUser(s, "bob", "Bob");
    auto carolId = ensureUser(s, "carol", "Carol");
    Principal keeper{keeperId, "keeper", "The Keeper"};
    auto servers = s.chat->listServers(keeper);
    std::string serverId;
    for (auto& sv : servers) if (sv["name"].asString() == "Arkham Table") serverId = sv["id"].asString();
    if (serverId.empty()) serverId = s.chat->createServer(keeper, "Arkham Table")["id"].asString();
    Json::Value chBody; chBody["name"] = "The Lantern of Blackwater Cove"; chBody["description"] = "Demo campaign — 1925, a Massachusetts fishing town, a missing lighthouse keeper."; chBody["knowledge_mode"] = "isolated";
    auto channel = s.chat->createChannel(keeper, serverId, chBody);
    auto channelId = channel["id"].asString();
    auto gm = s.auth->channelAccess(keeperId, channelId);
    for (auto& u : {"alice", "bob", "carol"}) s.chat->addChannelMember(gm, u, "player");
    auto mkChar = [&](const std::string& userId, const std::string& name, const std::string& style, const std::string& desc) {
        auto acc = s.auth->channelAccess(userId, channelId);
        Json::Value b; b["name"] = name; b["kind"] = "pc"; b["speaking_style"] = style; b["description"] = desc;
        Json::Value sheet; sheet["occupation"] = desc; sheet["STR"] = 55; sheet["CON"] = 60; sheet["DEX"] = 50; sheet["POW"] = 65; sheet["SAN"] = 65; sheet["skills"]["Spot Hidden"] = 55; sheet["skills"]["Library Use"] = 60; sheet["skills"]["Persuade"] = 45;
        b["sheet"] = sheet;
        return s.chat->createCharacter(acc, b)["id"].asString();
    };
    auto harvey = mkChar(aliceId, "Harvey Walters", "dry, formal, a touch pedantic", "Professor of antiquities");
    auto nora = mkChar(bobId, "Nora Blake", "quick, blunt, streetwise", "Journalist");
    auto thomas = mkChar(carolId, "Thomas Reed", "quiet, watchful, terse", "Ex-sailor");
    Json::Value npcB; npcB["name"] = "Sheriff Amos Dunmore"; npcB["kind"] = "npc"; npcB["description"] = "Sheriff of Blackwater Cove"; s.chat->createCharacter(gm, npcB);
    npcB["name"] = "Mrs. Agnes Hale"; npcB["description"] = "Sister of the missing keeper"; s.chat->createCharacter(gm, npcB);
    npcB["name"] = "Jonah Pike"; npcB["description"] = "A watcher at the docks"; s.chat->createCharacter(gm, npcB);

    // Module (GM layer) — imported through the same structuring pipeline.
    try { s.modules->importText(gm, "The Lantern of Blackwater Cove", demoModulePages()); } catch (const std::exception& e) { ALOG_WARN << "module seed failed: " << e.what(); }

    // Scenes
    auto mkScene = [&](const std::string& title, const std::string& loc, const std::string& when) { Json::Value b; b["title"] = title; b["location"] = loc; b["narrative_time"] = when; return s.scenes->create(gm, b)["id"].asString(); };
    auto sceneOffice = mkScene("Session 1 — The Sheriff's Office", "Sheriff's Office", "Tuesday, 14 October 1925, morning");
    auto sceneSplit = mkScene("Session 2 — Split party: Gazette and Docks", "Blackwater Gazette Office; Blackwater Docks", "Wednesday, 15 October 1925, afternoon and night");
    auto sceneReunion = mkScene("Session 3 — Hale Boarding House", "Hale Boarding House", "Thursday, 16 October 1925, morning");

    // Windows
    auto windows = s.chat->listWindows(gm);
    std::string mainWin = windows[0]["id"].asString();
    auto mkWin = [&](const std::string& name, const std::string& kind, std::initializer_list<std::pair<std::string, std::string>> members) {
        Json::Value b; b["name"] = name; b["kind"] = kind; b["members"] = Json::Value(Json::arrayValue);
        for (auto& [u, c] : members) { Json::Value m; m["user_id"] = u; m["character_id"] = c; b["members"].append(m); }
        return s.chat->createWindow(gm, b)["id"].asString();
    };
    auto winGazette = mkWin("Investigation: Gazette Office", "group", {{aliceId, harvey}, {bobId, nora}});
    auto winDocks = mkWin("Solo: The Docks", "private", {{carolId, thomas}});
    // Scenarios are campaign-wide: the Keeper opens each session for every window; the previous one closes.
    s.scenes->enterScene(gm, sceneOffice);

    auto say = [&](const std::string& userId, const std::string& win, const std::string& content, const std::string& kind = "ic") {
        auto acc = s.auth->channelAccess(userId, channelId);
        Json::Value b; b["content"] = content; b["kind"] = kind; return s.chat->postMessage(acc, win, b)["id"].asString();
    };
    auto observe = [&] { s.observer->observeChannel(channelId, true); };

    // --- Session 1: main chat, everyone present ---
    say(keeperId, mainWin, "The investigators arrive at the Sheriff's Office on a grey Tuesday morning. Sheriff Amos Dunmore rises from behind his desk with a careful smile. \"Mrs. Hale said you'd be coming. Terrible business about Elias.\"", "narration");
    say(aliceId, mainWin, "I remove my hat and offer my hand. \"Harvey Walters, Sheriff. We'd like to see the lighthouse. We understand it has been locked since Mr. Thorne vanished.\"");
    say(keeperId, mainWin, "Dunmore nods slowly. \"Locked it myself. I've got the only key — somewhere in this mess.\" He waves at the piles of papers. \"I promise I'll look for it and bring it to you at the boarding house.\"", "narration");
    say(bobId, mainWin, "I look around the office while they talk. Is there anything on the desk? I try to read the papers upside down.");
    say(keeperId, mainWin, "Nora, with a successful Spot Hidden you notice a tarnished badge on the desk, half under a ledger. It bears a lantern sigil instead of the county seal.", "narration");
    say(carolId, mainWin, "I stay by the door and watch the Sheriff's hands. \"Who else has been out to the lighthouse since Elias went missing, Sheriff?\"");
    say(keeperId, mainWin, "\"Nobody,\" Dunmore says, a shade too quickly. \"Nobody goes out there now.\"", "narration");
    say(bobId, mainWin, "Maybe the Sheriff is hiding something. That badge isn't a county badge.");
    observe();

    // --- Session 2: split party ---
    s.scenes->enterScene(gm, sceneSplit);
    say(keeperId, winGazette, "The Blackwater Gazette office smells of ink and damp. The editor is out; the archive room is unlocked. Harvey, Nora — where do you start?", "narration");
    say(aliceId, winGazette, "I search the archive for anything about the shoals or the lighthouse. Library Use.");
    say(keeperId, winGazette, "Harvey succeeds. You find a 1911 clipping about a shipwreck at the shoals and a photograph of a brass lantern recovered from the wreck.", "narration");
    say(bobId, winGazette, "While Harvey reads, I try the editor's safe. I pick the lock.");
    say(keeperId, winGazette, "The safe clicks open. Inside, Nora discovers secret documents: a ledger of payments from something called the Lantern Society to Sheriff Dunmore.", "narration");
    say(bobId, winGazette, "\"Harvey. Look at this. The Sheriff's on somebody's payroll.\" I promise myself we keep this quiet until we know who else is involved.");
    say(keeperId, winDocks, "Thomas, the docks at night. Fog on the water. A figure in oilskins stands at the end of the pier, watching the sea.", "narration");
    say(carolId, winDocks, "I approach slowly, hands visible. \"Evening. You waiting on a boat?\"");
    say(keeperId, winDocks, "The man turns. \"Jonah Pike,\" he says. \"Stay off the water at the new moon, sailor. The lights answer when they're called.\" He walks past you into the fog, and you notice he dropped a tarnished badge with a lantern sigil on the planks.", "narration");
    say(carolId, winDocks, "I pick up the badge and pocket it. I think this is the same kind of badge Nora saw on the Sheriff's desk.");
    observe();

    // --- Session 3: reunion (main chat) — return of historical foreshadowing ---
    s.scenes->enterScene(gm, sceneReunion);
    say(keeperId, mainWin, "Thursday morning at the Hale Boarding House. Mrs. Agnes Hale sets down a pot of coffee. The three of you are together again for the first time since yesterday.", "narration");
    say(carolId, mainWin, "I put the tarnished badge on the table between us. \"A man named Jonah Pike dropped this at the docks last night. Lantern sigil.\"");
    say(aliceId, mainWin, "\"Then we have two of them,\" I say. \"And the Sheriff still has not brought us the key he promised.\"");
    say(keeperId, mainWin, "Mrs. Hale goes pale at the sight of the badge. \"Elias had one of those. He said the Society gave it to him.\" She hands you a letter from Elias, dated three weeks ago.", "narration");
    observe();
    try { s.observer->consolidateChannel(channelId); } catch (...) {}
    ALOG_INFO << "demo campaign seeded: channel " << channelId;
    return true;
}

} // namespace acerciae
