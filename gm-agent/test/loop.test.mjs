import { test } from "node:test";
import assert from "node:assert/strict";
import { Table } from "../src/loop.mjs";
import { Roster, markStyle } from "../src/roles/roster.mjs";
import { MockLlm } from "../src/llm/mock.mjs";
import { buildConfig } from "../src/config.mjs";
import { DND_RULES } from "./fixtures/dndRules.mjs";
import { PBTA_RULES } from "./fixtures/pbtaRules.mjs";

// An in-memory stand-in for the platform, as the GM account sees it (every line, every AI tip).
import { FakeApi } from "./fixtures/platform.mjs";

const SECRETS = ["SECRET-ONE", "SECRET-TWO", "SECRET-THREE", "SECRET-BOARD", "SECRET-REMINDER", "SECRET-SCRIPT", "SECRET-DOC"];

async function table({ llm = new MockLlm(), cfg: over = {}, extraCharacters = [], clock = { t: 1_700_000_000_000 }, bob = false, improv = null, casual = null, heal = false, rules = "coc7e", forks = true, before = null } = {}) {
  const api = new FakeApi();
  api.ruleSystem = rules;
  api.characters_.push(...extraCharacters);
  if (bob) {
    // A second player who stays in the Main Chat.
    api.characters_.push({ id: "c-bob", name: "Bob Price", kind: "pc", user_id: "u-bob", player_name: "bob", role_card: {} });
    api.windows_[0].members.push({ user_id: "u-bob", character_id: "c-bob", character_name: "Bob Price" });
    api.channelUsers.push("u-bob");
  }
  // The seeded lines are an hour old: a window nobody has spoken in for a while must not be revived by autonomy.
  const old = (m) => api.add({ created_at: new Date(clock.t - 60 * 60000).toISOString(), ...m });
  old({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "GM NOTE SECRET-ONE: the clock hides the key", visibility: "gm_only" });
  old({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "SECRET-TWO: you alone hear a whisper", visibility: "whisper", whisper_to: ["c-alice"] });
  old({ chat_window_id: "w-priv", author_id: "u-alice", author_role: "player", character_id: "c-alice", content: "SECRET-THREE in Alice's own window" });
  old({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "The study is cold and smells of pipe smoke." });
  before?.(api);   // more of the channel's past, before the table starts
  // The story planner is off unless a test turns it on (pcfg): with no date set, it would plan after the first line.
  const base = buildConfig({}, {});
  const cfg = { ...base, sceneForks: forks, debounceMs: 0, postDelayMs: 0, planner: { ...base.planner, enabled: false }, ...over };
  const t = await new Table({ api, llm, cfg, channelId: "ch", roster: new Roster(), improv, casual, sleep: async () => {}, now: () => clock.t, log: process.env.TEST_LOG ? console.log : () => {} }).init({ heal });
  return { t, api, llm, clock };
}
const playerSays = (t, api, content, w = t.primaryWindowId()) => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: w, author_id: "u-alice", author_role: "player", character_id: "c-alice", content }) });

test("co-players and real NPCs are told apart from the platform's characters", async () => {
  const { t } = await table();
  assert.deepEqual(t.roster.coplayers.map((c) => [c.name, c.seats]), [["Harriet Vance", [{ windowId: "w-main", fromSeq: 0, toSeq: null }]]]);
  assert.deepEqual(t.timelines.main().members.sort(), ["c-alice", "c-harriet"], "every investigator starts in the main timeline");
  assert.deepEqual(t.roster.npcs.map((c) => c.name), ["Mr. Grimsby"]);
});

test("a player's line starts one turn: the GM answers with the whole GM context, the co-player only with its chat log", async () => {
  const { t, api, llm } = await table();
  await playerSays(t, api, "I open the desk drawer.");
  const director = llm.calls.find((c) => c.purpose === "director");
  const gmPrompt = director.messages[0].content;
  for (const s of SECRETS) assert.ok(gmPrompt.includes(s), `the GM sees ${s}`);
  const coplayer = llm.calls.filter((c) => c.purpose === "coplayer_turn");
  assert.equal(coplayer.length, 1);
  const cpPrompt = coplayer[0].system + coplayer[0].messages.map((m) => m.content).join("\n");
  assert.ok(cpPrompt.includes("I open the desk drawer."), "the co-player reads the table");
  assert.ok(cpPrompt.includes("The study is cold"), "and the GM's public narration");
  for (const s of SECRETS) assert.ok(!cpPrompt.includes(s), `the co-player never sees ${s}`);
  assert.deepEqual(api.posts.map((p) => [p.kind, p.character_id ?? null]), [["narration", null], ["ic", "c-harriet"], ["narration", null]], "GM, co-player, then the GM's immediate answer to the co-player");
  const followup = llm.calls.filter((c) => c.purpose === "director")[1].messages[0].content;
  assert.ok(followup.includes("MODE: followup"), "the follow-up round is told the co-players just acted");
  assert.ok(followup.includes("NEWEST LINE: Harriet Vance"), "and sees their lines as the newest");
});

test("a recalled line leaves the table: no later prompt quotes it, even after a sync of the window", async () => {
  const { t, api, llm } = await table();
  await playerSays(t, api, "I whisper TYPO-WRONG-NAME to the butler.");
  const said = api.lines.find((m) => m.content.includes("TYPO-WRONG-NAME"));
  const tombstone = { ...said, content: "", recalled_at: "2026-11-07T00:00:00Z", recall_seconds_left: null };
  api.lines[api.lines.indexOf(said)] = tombstone;   // what the platform now returns for it
  t.onEvent({ stream: "chat", type: "message.recalled", channel_id: "ch", message: tombstone });
  llm.calls.length = 0;
  await playerSays(t, api, "I ask the butler about the clock.");
  const prompts = llm.calls.map((c) => (c.system ?? "") + c.messages.map((m) => m.content).join("\n")).join("\n");
  assert.ok(prompts.includes("about the clock"), "the next line is read");
  // (The mock GM's reply, posted before the recall, quotes the line; the line itself must be gone from every log.)
  assert.ok(!prompts.includes(`#${said.seq} `), "the recalled line is in no chat log");
  assert.ok(!t.history.lines(said.chat_window_id).some((m) => m.id === said.id));
});

test("a player's picture: with a caption it is a line the GM answers, reading the caption; without one it starts nothing", async () => {
  const { t, api, llm } = await table();
  const post = (over) => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch",
    message: api.add({ chat_window_id: t.primaryWindowId(), author_id: "u-alice", author_role: "player", character_id: "c-alice", ...over }) });
  // No caption: the table cannot see pictures, so there is nothing to answer; the line is still on the record.
  assert.equal(await post({ content: "🖼️", media_asset_id: "asset-1" }), undefined);
  assert.equal(t.turns, 0); assert.equal(llm.calls.length, 0);
  assert.ok(t.history.lines(t.primaryWindowId()).some((m) => m.media_asset_id === "asset-1"));
  // With a caption: a turn, and the GM's log says a picture was posted and what its caption says.
  await post({ content: "🖼️ The photograph from the drawer: a lighthouse at night.", media_asset_id: "asset-2" });
  assert.equal(t.turns, 1);
  const gmPrompt = llm.calls.find((c) => c.purpose === "director").messages[0].content;
  assert.ok(gmPrompt.includes("[posts a picture; you cannot see it, its caption says:] The photograph from the drawer: a lighthouse at night."));
  assert.ok(gmPrompt.includes("[posts a picture without a caption; you cannot see pictures]"), "the earlier picture is in the log as what it is");
});

test("lines the client posts never start a turn", async () => {
  const { t, api } = await table();
  await playerSays(t, api, "Hello?");
  const turns = t.turns;
  for (const m of api.lines.filter((x) => x.author_id === "u-bot")) assert.equal(t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: m }), undefined);
  assert.equal(t.turns, turns);
});

test("the GM voices and creates real NPCs, never co-players; rolls for its own characters go to the platform's dice", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => user.includes("NEWEST LINE") ? {
    actions: [
      { type: "new_npc", name: "Mrs. Pell", brief: "the landlady", text: "Wipe your feet." },
      { type: "npc", name: "Harriet Vance", text: "I, the GM, speak for Harriet." },
      { type: "npc", name: "Mr. Grimsby", text: "Sir rang?" },
      { type: "request_roll", who: "Harriet Vance", command: ".ra Spot Hidden", text: "Harriet, look around." },
      { type: "request_roll", who: "Alice Hale", command: ".ra Library Use", text: "Alice, the shelves." },
      { type: "whisper", to: "Alice Hale", text: "You feel watched." },
    ],
    coplayers_may_act: false,
  } : base(user);
  const { t, api } = await table({ llm });
  await playerSays(t, api, "I ring the bell.");
  assert.equal(api.created.length, 1);
  assert.equal(api.created[0].kind, "npc");
  assert.ok(t.roster.npcByName("Mrs. Pell"));
  assert.ok(llm.calls.some((c) => c.purpose === "npc_card"));
  const lines = api.posts.map((p) => `${p.character_id ?? "gm"}|${p.visibility ?? "window"}|${p.content}`);
  assert.deepEqual(lines, [
    "c-new0|window|Wipe your feet.",
    "c-butler|window|Sir rang?",
    "gm|window|Harriet, look around.",
    "c-harriet|window|.ra Spot Hidden",
    "gm|window|Alice, the shelves.\n→ Alice Hale: .ra Library Use",
    "gm|whisper|You feel watched.",
  ]);
  assert.deepEqual(api.posts.at(-1).whisper_to, ["c-alice"]);
  assert.ok(!lines.some((l) => l.includes("I, the GM, speak for Harriet")));
  assert.equal(llm.calls.filter((c) => c.purpose === "coplayer_turn").length, 0, "co-players wait when the GM says so");
});

test("NPC speech never creates an unknown character, and new_npc reuses an existing identity", async () => {
  const llm = new MockLlm();
  llm.director = () => ({ actions: [
    { type: "npc", name: "Invented Messenger", text: "A needless new contact." },
    { type: "new_npc", name: "Mr. Grimsby", brief: "do not replace his identity", text: "I remember your promise." },
    { type: "new_npc", name: "Mrs. Pell", brief: "a necessary new landlady", text: "Your room is ready." },
  ], coplayers_may_act: false });
  const { t, api } = await table({ llm });
  await playerSays(t, api, "I return to speak with Grimsby.");
  assert.deepEqual(api.created.map((c) => c.name), ["Mrs. Pell"]);
  assert.equal(llm.calls.filter((c) => c.purpose === "npc_card").length, 1);
  assert.equal(api.posts[0].visibility, "gm_only"); assert.match(api.posts[0].content, /^Not posted: Invented Messenger is not in the cast.*introduce them with new_npc/);
  assert.equal(api.posts[1].character_id, "c-butler");
  assert.equal(api.posts[1].content, "I remember your promise.");
  assert.ok(!api.posts.some((p) => p.content.includes("needless new contact")));
  assert.equal(t.roster.npcs.filter((c) => c.characterId === "c-butler").length, 1);
});

test("a turn posts at most MAX_ACTIONS_PER_TURN lines", async () => {
  const llm = new MockLlm();
  llm.director = () => ({ actions: Array.from({ length: 10 }, (_, i) => ({ type: "narrate", text: `line ${i}` })), coplayers_may_act: true });
  const { t, api } = await table({ llm, cfg: { maxActionsPerTurn: 3 } });
  await playerSays(t, api, "Go on.");
  assert.equal(api.posts.length, 3);
});

test("a co-player seated elsewhere does not act in this window", async () => {
  const { t, api, llm } = await table();
  await playerSays(t, api, "Alone, I search the room.", "w-priv");
  assert.equal(llm.calls.filter((c) => c.purpose === "coplayer_turn").length, 0);
  assert.equal(api.posts.length, 1);
});

test("--kickoff opens the session without waiting for a player", async () => {
  const { t, api, llm } = await table();
  await t.schedule("w-main", { kickoff: true, delay: 0 });
  assert.ok(llm.calls.find((c) => c.purpose === "director").messages[0].content.includes("KICKOFF: yes"));
  assert.equal(api.posts[0].kind, "narration");
});

test("lines in quick succession make one turn, and every caller learns when it ran", async () => {
  const { t, api, llm } = await table({ cfg: { debounceMs: 30 } });
  const a = playerSays(t, api, "First thought.");
  const b = playerSays(t, api, "Second thought.");
  await Promise.all([a, b]);
  assert.equal(t.turns, 1);
  assert.ok(llm.calls.find((c) => c.purpose === "director").messages[0].content.includes("NEWEST LINE: Alice Hale: Second thought."));
});

test("the investigators' basic details and backgrounds reach the GM and the co-players, real NPCs' details only the GM", async () => {
  const tomas = { id: "c-tomas", name: "Tomas Leclerc", kind: "pc", user_id: "u-bot", speaking_style: "eager", bio: "TOMAS-BIO: a reporter who owes Alice",
    role_card: { basic: { occupation: "TOMAS-JOB photographer" }, background: { traits: "TOMAS-TRAITS: never sits still" } } };
  const { t, api, llm } = await table({ extraCharacters: [tomas] });
  await playerSays(t, api, "Who here has been to the docks?");
  const gm = llm.calls.find((c) => c.purpose === "director").messages[0].content;
  for (const s of ["ALICE-BIO", "ALICE-JOB", "ALICE-TIES", "HARRIET-JOB", "HARRIET-IDEOLOGY", "TOMAS-BIO", "TOMAS-JOB", "TOMAS-TRAITS"]) assert.ok(gm.includes(s), `the GM reads ${s}`);
  const turns = llm.calls.filter((c) => c.purpose === "coplayer_turn");
  assert.equal(turns.length, 2);
  const prompt = (name) => turns.map((c) => c.messages[0].content).find((u) => u.startsWith(`YOU ARE: ${name}`));
  const harriet = prompt("Harriet Vance");
  const companions = (u) => u.slice(u.indexOf("THE OTHER INVESTIGATORS"), u.indexOf("CHAT LOG"));
  for (const s of ["ALICE-BIO", "ALICE-JOB", "ALICE-TIES", "TOMAS-BIO", "TOMAS-JOB", "TOMAS-TRAITS"]) assert.ok(companions(harriet).includes(s), `Harriet knows ${s}`);
  assert.ok(!companions(harriet).includes("HARRIET-"), "a co-player is not listed among its own companions");
  const tomasPrompt = prompt("Tomas Leclerc");
  for (const s of ["ALICE-TIES", "HARRIET-JOB", "HARRIET-IDEOLOGY"]) assert.ok(companions(tomasPrompt).includes(s), `Tomas knows ${s}`);
  for (const c of turns) {
    const text = c.system + c.messages.map((m) => m.content).join("\n");
    for (const s of [...SECRETS, "SECRET-NPC", "Mr. Grimsby", "knows where the key is"]) assert.ok(!text.includes(s), `no co-player reads ${s}`);
  }
});

// ---- timelines and autonomy
const MIN = 60000;
const splitPlan = { actions: [{ type: "split", name: "The docks", coplayers: ["Harriet Vance"], location: "Old Harbour", narrative_time: "Tuesday night", opening: "Fog hangs over the harbour." }], coplayers_may_act: false };
const quietDirector = (plan) => (user) => (user.includes("NEWEST LINE") || user.includes("MODE:") ? plan : { actions: [], coplayers_may_act: false });

test("TIMELINE_AUTO=false: split moves co-players into a window of their own on a new timeline; rejoin brings them back", async () => {
  const llm = new MockLlm();
  llm.director = quietDirector(splitPlan);
  const { t, api } = await table({ llm, cfg: { timelineAuto: false } });
  await t.post("w-main", { kind: "ic", character_id: "c-harriet", content: "I go to the Old Harbour." });
  await playerSays(t, api, "Harriet, go and watch the harbour tonight.");
  const side = api.windows_.find((w) => w.name === "Side: Old Harbour");
  assert.ok(side, "a side window was created"); assert.deepEqual(side.members.map((m) => m.user_id), ["u-bot"], "no human sits in it");
  const harriet = t.roster.coplayerByName("Harriet Vance");
  assert.deepEqual(harriet.seats.map((s) => [s.windowId, s.toSeq === null]), [["w-main", false], [side.id, true]], "the Main Chat seat closed, the side seat is open");
  const tl = t.timelines.byName("Old Harbour");
  assert.equal(tl.windowId, side.id); assert.deepEqual(tl.members, ["c-harriet"]); assert.equal(tl.location, "Old Harbour");
  assert.deepEqual(t.timelines.main().members, ["c-alice"]);
  assert.ok(api.posts.some(p => p.window === side.id && p.content === "Fog hangs over the harbour."));
  // Harriet no longer hears the Main Chat.
  api.add({ chat_window_id: "w-main", author_id: "u-alice", author_role: "player", character_id: "c-alice", content: "MAIN-WHILE-AWAY" });
  await t.post(side.id, { kind: "ic", character_id: "c-harriet", content: "I go back to the others." });
  llm.director = quietDirector({ actions: [{ type: "rejoin", timeline: "Old Harbour", text: "Harriet comes back soaked." }], coplayers_may_act: true });
  await playerSays(t, api, "Come back from the harbour."); await settle(t);
  await playerSays(t, api, "Any news from the harbour?");
  assert.equal(t.timelines.byName("Old Harbour").status, "merged");
  assert.deepEqual(t.timelines.main().members.sort(), ["c-alice", "c-harriet"]);
  assert.deepEqual(harriet.seats.at(-1), { windowId: t.primaryWindowId(), fromSeq: harriet.seats.at(-1).fromSeq, toSeq: null });
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.ok(cp.includes("Fog hangs over the harbour."), "Harriet remembers her side trip");
  assert.ok(!cp.includes("MAIN-WHILE-AWAY"), "and not what the Main Chat said while she was away");
  assert.ok(cp.includes("Any news from the harbour?"), "but hears the Main Chat again now");
  assert.ok(cp.includes("YOUR TIMELINE: Main story"));
  const gm = llm.calls.filter((c) => c.purpose === "director").at(-1).messages[0].content;
  assert.ok(gm.includes("## Timelines") && gm.includes("Old Harbour [merged into Main story]"), "the GM sees the timelines");
  assert.ok(/Fog hangs over the harbour\./.test(gm) && gm.includes("[timeline: Old Harbour]"), "side lines are tagged with their timeline");
});

test("a side timeline moves on its own clock, with no human line, and the GM answers the co-players at once", async () => {
  const llm = new MockLlm();
  llm.director = quietDirector(splitPlan);
  const { t, api, clock } = await table({ llm, cfg: { timelineAuto: false, autonomySideIntervalMs: 90000, autonomyQuietMs: 10 * MIN } });
  await t.post("w-main", { kind: "ic", character_id: "c-harriet", content: "I go to the Old Harbour." });
  await playerSays(t, api, "Harriet, go and watch the harbour tonight.");
  const side = api.windows_.find((w) => w.name === "Side: Old Harbour");
  await settle(t);
  llm.director = (user) => ({ actions: user.includes("MODE: side") ? [{ type: "narrate", text: "A boat creaks at the quay." }] : user.includes("MODE: followup") ? [{ type: "narrate", text: "The sailor turns to you." }] : [], coplayers_may_act: true });
  assert.equal(await t.tick(), null, "too soon after the opening line");
  clock.t += 91000;
  const before = api.posts.length;
  await t.tick();
  const posted = api.posts.slice(before);
  assert.deepEqual(posted.map((p) => [p.window, p.kind, p.character_id ?? null]), [[side.id, "narration", null], [side.id, "ic", "c-harriet"], [side.id, "narration", null]], "GM, co-player, GM's answer — all in the side window");
  const sideCall = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.ok(sideCall.includes("No human player is with you here"), "the co-player knows it leads this thread");
  assert.ok(sideCall.includes("YOUR TIMELINE: Old Harbour; time: Tuesday night; place: Old Harbour"));
  assert.equal(await t.tick(), null, "the side interval has not passed again");
  clock.t += 91000;
  assert.notEqual(await t.tick(), null);
  assert.equal(t.autonomousTurns.length, 2);
});

test("a quiet shared window moves on a little, at most AUTONOMY_QUIET_TURNS times, and a human line resets it", async () => {
  const llm = new MockLlm();
  llm.director = (user) => ({ actions: user.includes("MODE: quiet") ? [{ type: "narrate", text: "The clock strikes." }] : [], coplayers_may_act: false });
  const { t, api, clock } = await table({ llm, cfg: { autonomyQuietMs: 3 * MIN, autonomyQuietTurns: 2 } });
  await playerSays(t, api, "I wait.");
  assert.equal(await t.tick(), null, "humans have not been quiet long enough");
  clock.t += 3 * MIN + 1;
  await t.tick();
  assert.equal(api.posts.at(-1).content, "The clock strikes.");
  const quiet = llm.calls.filter((c) => c.purpose === "director").at(-1).messages[0].content;
  assert.ok(quiet.includes("MODE: quiet") && quiet.includes("silent for 3 minutes"));
  clock.t += 3 * MIN + 1;
  await t.tick();
  assert.equal(t.state("w-main").quietTurns, 2);
  clock.t += 3 * MIN + 1;
  assert.equal(await t.tick(), null, "after two quiet turns the table waits for a human");
  await playerSays(t, api, "Sorry, I was away.");
  assert.equal(t.state("w-main").quietTurns, 0, "a human line resets the count");
});

test("a human typing in the window holds its quiet turns and starts the silence over; a sent line is answered as always; co-players, NPCs and other windows hold nothing", async () => {
  const llm = new MockLlm();
  llm.director = (user) => ({ actions: [{ type: "narrate", text: user.includes("MODE: quiet") ? "The clock strikes." : "The butler nods." }], coplayers_may_act: false });
  const { t, api, clock } = await table({ llm, cfg: { autonomyQuietMs: 3 * MIN, autonomyQuietTurns: 2 } });
  const typing = (active, character_id = "c-alice", chat_window_id = "w-main") => t.onEvent({ stream: "chat", type: "typing.changed", channel_id: "ch", chat_window_id, character_id, active });
  await playerSays(t, api, "I wait."); await settle(t);
  clock.t += 3 * MIN + 1;
  typing(true);
  assert.equal(await t.tick(), null, "held while Alice types");
  clock.t += 2 * MIN;
  assert.equal(await t.tick(), null, "still held");
  // Her line is answered at once, as always (the composer lowers the flag as it sends); then she types on.
  typing(false);
  const before = api.posts.length;
  await playerSays(t, api, "I ask the butler about the clock."); await settle(t);
  assert.ok(api.posts.slice(before).some((p) => p.content === "The butler nods."), "the first reaction is not affected");
  typing(true);
  clock.t += 3 * MIN + 1;
  assert.equal(await t.tick(), null, "her next line is being written: no quiet turn");
  typing(false);
  assert.equal(await t.tick(), null, "she stopped just now: the silence starts over");
  clock.t += 3 * MIN + 1;
  assert.notEqual(await t.tick(), null, "quiet for long enough again: the scene moves on");
  await settle(t);
  assert.equal(api.posts.at(-1).content, "The clock strikes.");
  // A co-player this account casts, an NPC, or a human in another window: no hold on the Main Chat.
  clock.t += 3 * MIN + 1;
  typing(true, "c-harriet"); typing(true, "c-butler"); typing(true, "c-alice", "w-priv");
  assert.notEqual(await t.tick(), null, "nothing human is typing here");
  await settle(t);
  // A snapshot (after a reconnect) replaces what the table knew; a flag the platform never lowered goes stale.
  t.onEvent({ stream: "chat", type: "typing.snapshot", channel_id: "ch", typing: [{ chat_window_id: "w-main", character_id: "c-alice" }] });
  assert.deepEqual(t.humansTyping("w-main"), ["Alice Hale"]);
  clock.t += 10 * MIN + 1;
  assert.deepEqual(t.humansTyping("w-main"), [], "stale after ten minutes without the platform lowering it");
});

test("autonomy pauses when nobody has posted for AUTONOMY_IDLE_MINUTES, and stops at the hourly cap", async () => {
  const llm = new MockLlm();
  llm.director = () => ({ actions: [{ type: "narrate", text: "Wind." }], coplayers_may_act: false });
  const { t, api, clock } = await table({ llm, cfg: { autonomyQuietMs: MIN, autonomyQuietTurns: 99, autonomyIdleMinutes: 30, autonomyMaxTurnsPerHour: 2 } });
  await playerSays(t, api, "Hello?");
  clock.t += 31 * MIN;
  assert.equal(await t.tick(), null, "the table is idle");
  await playerSays(t, api, "Back.");
  clock.t += MIN + 1; assert.notEqual(await t.tick(), null);
  clock.t += MIN + 1; assert.notEqual(await t.tick(), null);
  clock.t += MIN + 1; assert.equal(await t.tick(), null, "two autonomous turns this hour is the cap");
  clock.t += 61 * MIN; await playerSays(t, api, "Still here."); clock.t += MIN + 1;
  assert.notEqual(await t.tick(), null, "the cap rolls over after an hour");
});

test("a human line outranks a queued autonomous turn, and autonomy never runs while a turn is pending", async () => {
  const llm = new MockLlm();
  llm.director = (user) => ({ actions: [{ type: "narrate", text: user.includes("MODE: quiet") ? "QUIET" : "HUMAN" }], coplayers_may_act: false });
  const { t, api, clock } = await table({ llm, cfg: { autonomyQuietMs: MIN, debounceMs: 20 } });
  await playerSays(t, api, "Hi.");
  clock.t += MIN + 1;
  const pending = playerSays(t, api, "One more thing.");       // waiting for its debounce
  assert.equal(await t.tick(), null, "a turn is pending");
  await pending;
  assert.equal(api.posts.at(-1).content, "HUMAN");
});

test("in a quiet turn the GM cannot speak or roll for a player character", async () => {
  const llm = new MockLlm();
  llm.director = (user) => ({ actions: user.includes("MODE: quiet") ? [
    { type: "npc", name: "Alice Hale", text: "I, the GM, decide for Alice." },
    { type: "request_roll", who: "Alice Hale", command: ".ra Listen", text: "Alice, something stirs." },
  ] : [], coplayers_may_act: false });
  const { t, api, clock } = await table({ llm, cfg: { autonomyQuietMs: MIN } });
  await playerSays(t, api, "…");
  clock.t += MIN + 1;
  await t.tick();
  assert.ok(!api.posts.some((p) => p.character_id === "c-alice"), "nothing is posted as Alice");
  assert.equal(api.created.length, 0, "no NPC named after a player character is created");
  assert.equal(api.posts.at(-1).kind, "narration"); assert.ok(api.posts.at(-1).content.includes("→ Alice Hale: .ra Listen"), "the roll is asked for, not made");
});

test("the timeline action keeps a thread's time, place and private notes; co-players never see the notes", async () => {
  const llm = new MockLlm();
  llm.director = quietDirector({ actions: [{ type: "timeline", timeline: "Main story", narrative_time: "Wednesday dawn", location: "Hale house", notes: "NOTES-SECRET: the butler lies" }], coplayers_may_act: true });
  const { t, api } = await table({ llm });
  await playerSays(t, api, "We rest until dawn.");
  const main = t.timelines.main();
  assert.equal(main.narrativeTime, "Wednesday dawn"); assert.equal(main.notes, "NOTES-SECRET: the butler lies");
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1);
  assert.ok((cp.system + cp.messages[0].content).includes("YOUR TIMELINE: Main story; time: Wednesday dawn; place: Hale house"));
  assert.ok(!(cp.system + cp.messages[0].content).includes("NOTES-SECRET"));
  const gm = llm.calls.filter((c) => c.purpose === "director").at(-1).messages[0].content;
  assert.ok(gm.includes("notes: NOTES-SECRET"));
});

// ---- proactive timelines and scenarios
const settle = async (t) => { for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 2)); await t.queue; } };
const directorCalls = (llm) => llm.calls.filter((c) => c.purpose === "director").map((c) => c.messages[0].content);
const alicePosts = (t, api, content, w) => playerSays(t, api, content, w);

test("a player who says they go elsewhere gets a window of their own with the GM, and its scene opens at once", async () => {
  const { t, api, llm } = await table({ bob: true });
  await alicePosts(t, api, "I go to the docks to look for the sailor.");
  await settle(t);
  const w = api.createdWindows[0];
  assert.ok(w, "a window was created"); assert.equal(w.name, "Scene: docks to look for the sailor");
  assert.deepEqual(w.members.map((m) => m.user_id), ["u-bot", "u-alice"], "exactly Alice (and the GM account)");
  assert.equal(api.membershipWrites, 2, "both parties receive restricted forks");
  const tl = t.timelines.of("c-alice");
  assert.equal(tl.windowId, w.id); assert.deepEqual(tl.members, ["c-alice"]); assert.equal(tl.span, "short");
  assert.deepEqual(t.timelines.main().members.sort(), ["c-bob", "c-harriet"], "Bob and Harriet stay where they are");
  assert.ok(api.posts.some((p) => p.window === "w-main" && p.visibility === "whisper" && p.whisper_to?.[0] === "c-alice" && p.content.includes(w.name)), "Alice is pointed to her window");
  assert.ok(api.posts.some((p) => p.window === w.id && p.content.startsWith("[mock GM] docks")), "the opening is posted there");
  assert.ok(directorCalls(llm).some((u) => u.includes("MODE: arrival") && u.includes("Alice Hale just arrived")), "an arrival turn opened the scene");
  assert.ok(api.posts.some((p) => p.window === w.id && p.kind === "narration" && /You consider/.test(p.content)), "the GM narrated in her window");
  assert.ok(tl.opened, "the thread is marked opened");
  assert.match(t.splitWarning, /knowledge mode is public/, "public knowledge mode is noticed (the CLI warns about it)");
});

test("only the player's own line moves them; a co-player follows after its own line, and its memory follows its seat", async () => {
  const llm = new MockLlm();
  const baseDirector = llm.director.bind(llm);
  llm.director = (user) => {
    if (user.includes("MODE: followup") && user.includes("I follow Alice")) return { actions: [{ type: "narrate", text: "Harriet hurries after her." }], coplayers_may_act: false, whereabouts: [{ who: ["Harriet Vance"], thread: "T1" }] };
    return baseDirector(user);
  };
  llm.coplayer = (user) => (user.includes("YOU ARE: Harriet") && user.includes("I go to the docks") && !user.includes("Harriet hurries") ? { action: "speak", kind: "ic", text: "I follow Alice." } : { action: "speak", kind: "ic", text: "[mock] I look around." });
  const { t, api } = await table({ llm, bob: true });
  await alicePosts(t, api, "Harriet, wait here. I go to the docks.");
  await settle(t);
  const alice = t.timelines.of("c-alice");
  assert.deepEqual(alice.members.sort(), ["c-alice", "c-harriet"], "Harriet followed, after her own line");
  const harriet = t.roster.coplayerByName("Harriet Vance");
  assert.deepEqual(harriet.seats.filter((x) => x.toSeq === null).map((x) => x.windowId), [alice.windowId], "her one open seat is Alice's window");
  api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "MAIN-AFTER-SHE-LEFT" });
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn" && c.messages[0].content.startsWith("YOU ARE: Harriet")).at(-1).messages[0].content;
  assert.ok(cp.includes("I go to the docks"), "she remembers the departure");
  assert.ok(cp.includes("WITH YOU HERE") && cp.indexOf("Alice Hale") > cp.indexOf("WITH YOU HERE"), "she knows Alice is with her");
  assert.equal(api.membershipWrites, 2, "a co-player joining adds no membership writes beyond the initial two forks");
});

test("coming back: the player's thread merges into the main story, the old window points to the Main Chat, the reunion is narrated", async () => {
  const { t, api, llm } = await table({ bob: true });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  const side = t.timelines.of("c-alice");
  await alicePosts(t, api, "Nothing here. I go back to the others.", side.windowId);
  await settle(t);
  assert.equal(t.timelines.of("c-alice").id, "main");
  assert.equal(t.timelines.get(side.id).status, "merged"); assert.ok(t.timelines.retired(side.windowId));
  assert.ok(api.posts.some((p) => p.window === side.windowId && p.visibility === "window" && p.content === `→ "${t.windowName(t.primaryWindowId())}"`), "the old window points back");
  assert.ok(directorCalls(llm).some((u) => u.includes("MODE: arrival") && u.includes("rejoined the others")), "the reunion gets its own scene opening");
  assert.equal(api.membershipWrites, 3, "the late human joins the existing primary scene");
  assert.equal(await t.tick(), null, "a retired window never gets autonomous turns");
});

test("a split-off player who writes in the Main Chat is answered in their own scene, with a pointer", async () => {
  const { t, api, llm } = await table({ bob: true });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  const home = t.timelines.of("c-alice").windowId;
  const before = api.posts.length;
  await alicePosts(t, api, "I search the crates for the badge.", "w-main");
  await settle(t);
  const after = api.posts.slice(before);
  assert.ok(after.some((p) => p.window === "w-main" && p.visibility === "whisper" && p.whisper_to?.[0] === "c-alice"), "pointer in the Main Chat");
  assert.ok(!after.some((p) => p.window === "w-main" && p.visibility === "window"), "nothing about the docks is narrated in the Main Chat");
  assert.ok(directorCalls(llm).some((u) => u.includes("MODE: relay") && u.includes("I search the crates")), "the relay turn quotes her line");
  assert.ok(after.some((p) => p.window === home && p.kind === "narration"), "the answer lands in her window");
});

test("a reported move that is not allowed is noted for the GM and changes nothing", async () => {
  // Alice speaks; the GM also reports Bob leaving, but only Bob's own player can move Bob.
  const llm = new MockLlm();
  llm.director = (user) => (!/^MODE: /m.test(user) ? { actions: [{ type: "narrate", text: "ok" }], coplayers_may_act: false, whereabouts: [{ who: ["Bob Price"], thread: "new", place: "Attic", own_scene: true }] } : { actions: [], coplayers_may_act: false });
  const { t, api } = await table({ llm, bob: true });
  await alicePosts(t, api, "Bob, go and look upstairs.");
  await settle(t);
  assert.equal(api.createAttempts ?? 0, 0, "no window");
  assert.equal(t.timelines.of("c-bob").id, "main");
  const note = api.posts.find((p) => p.visibility === "gm_only" && p.content.startsWith("Whereabouts not applied"));
  assert.ok(note && /Bob Price/.test(note.content), note?.content);
});

const bobSays = (t, api, content, w = "w-main") => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: w, author_id: "u-bob", author_role: "player", character_id: "c-bob", content }) });
const twoWays = () => {
  const llm = new MockLlm();
  llm.director = (user) => (!/^MODE: /m.test(user) && user.includes("Mill")
    ? { actions: [{ type: "narrate", text: "They part." }], coplayers_may_act: false, whereabouts: [{ who: ["Alice Hale"], thread: "new", place: "Docks", own_scene: true }, { who: ["Bob Price"], thread: "new", place: "Mill", own_scene: true }] }
    : { actions: [], coplayers_may_act: false });
  return llm;
};

test("a platform failure creating the window changes nothing locally and the window is reused on retry", async () => {
  const { t, api } = await table({ llm: twoWays(), bob: true, cfg: { debounceMs: 20 } });
  api.failAfter = 1;                                   // Alice's window is created, Bob's fails
  await Promise.all([alicePosts(t, api, "I go to the docks."), bobSays(t, api, "And I go to the Mill.")]);
  await settle(t);
  assert.equal(api.createdWindows.length, 1);
  assert.equal(t.timelines.active().length, 1, "no thread without its window");
  assert.equal(t.journal.phase, "A");
  assert.equal(t.journal.created[0].windowId, api.createdWindows[0].id, "the persisted request retains the first fork");
  api.failAfter = undefined;
  await Promise.all([alicePosts(t, api, "I go to the docks."), bobSays(t, api, "And I go to the Mill.")]);
  await settle(t);
  assert.equal(api.createdWindows.length, 3, "retry reuses Alice’s fork and creates Bob’s and the stayers’ forks");
  assert.equal(t.timelines.of("c-alice").windowId, api.createdWindows[0].id, "Alice's earlier window is reused");
  assert.deepEqual(t.guard.spare, []);
});

test("a failed scene plan stays recoverable and never falls back to public narration", async () => {
  const { t, api } = await table({ bob: true });
  api.failCreate = true;
  for (let i = 0; i < 3; i++) { await alicePosts(t, api, "I go to the docks."); await settle(t); }
  assert.equal(t.journal.phase, "A");
  assert.equal(t.timelines.of("c-alice").id, "main");
  assert.ok(!api.posts.some(p => p.visibility === "window"));
  api.failCreate = false;
  await t.heal(); await settle(t);
  assert.notEqual(t.windowOf(t.timelines.of("c-alice")), "w-main");
  assert.notEqual(t.primaryWindowId(), "w-main");
});

test("an interrupted split is finished on restart with the window it had already made, and its scene still gets an opening turn", async () => {
  const { t, api, llm } = await table({ bob: true });
  const made = await api.createWindow("ch", { name: "Scene: Docks", kind: "group", members: [{ user_id: "u-alice", character_id: "c-alice" }] });
  const ops = [{ op: "split", ids: ["c-alice"], place: "Docks", time: "", span: "short", opening: "Fog.", fromTimeline: "main", replaces: null }];
  const journal = { opId: "x", ops, changed: ["c-alice"], windowId: "w-main", created: [{ windowId: made.id, placeKey: "docks", users: ["u-alice"] }], phase: "A" };
  const t2 = new Table({ api, llm, cfg: t.cfg, channelId: "ch", roster: new Roster(), journal, sleep: async () => {} });
  await t2.init({ heal: true });
  await settle(t2);
  assert.equal(api.createdWindows.length, 2, "the existing window is retained and the stayers get their restricted fork");
  assert.equal(t2.timelines.of("c-alice").windowId, made.id);
  assert.equal(t2.timelines.of("c-alice").location, "Docks");
  assert.equal(t2.journal, null);
  assert.ok(directorCalls(llm).some((u) => u.includes("MODE: arrival")), "the opening turn ran");
});

test("a CLI command applied without a run process leaves its arrival for run", async () => {
  const { t, api } = await table();
  t.deferArrivals = true;
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Lighthouse", span: "long" });
  assert.equal(t.owedArrivals.length, 2);
  assert.equal(t.timelines.of("c-harriet").span, "long");
  assert.equal(api.createdWindows[0].name, "Side: Lighthouse");
  await t.command({ cmd: "rejoin", timeline: "Lighthouse" });
  assert.equal(t.timelines.of("c-harriet").id, "main");
});

test("an interrupted presence regroup resumes without narrating a second arrival", async () => {
  const { t, api, llm } = await table({ bob: true });
  const made = await api.createWindow("ch", { name: "Scene: 507", kind: "group", members: [{ user_id: "u-alice", character_id: "c-alice" }] });
  const journal = { mode: "presence", opId: "reunion", phase: "A", windowId: "w-main", changed: ["c-alice", "c-harriet"],
    ops: [{ op: "split", ids: ["c-alice", "c-harriet"], place: "507", time: "", span: "short", opening: "", fromTimeline: "main", replaces: null }],
    created: [{ windowId: made.id, placeKey: "507", users: ["u-alice"] }] };
  const t2 = new Table({ api, llm, cfg: t.cfg, channelId: "ch", roster: new Roster(), journal, sleep: async () => {} });
  await t2.init({ heal: true }); await settle(t2);
  assert.equal(api.createdWindows.length, 2);
  assert.equal(t2.timelines.of("c-alice").id, t2.timelines.of("c-harriet").id);
  assert.equal(t2.timelines.of("c-alice").opened, true);
  assert.equal(t2.journal, null);
  assert.ok(!directorCalls(llm).some(u => u.includes("MODE: arrival")));
});

test("an arrival riding on a pending human turn keeps its note and never shortens the human's wait", async () => {
  const { t, api, llm } = await table({ cfg: { debounceMs: 30 } });
  const human = alicePosts(t, api, "Anyone?");
  t.schedule("w-main", { mode: "arrival", delay: 0, arrival: { names: ["Harriet Vance"], reunion: true } });
  await human; await settle(t);
  const u = directorCalls(llm).at(-1) ?? "";
  assert.ok(directorCalls(llm).some((x) => x.includes("Harriet Vance just rejoined")), "the arrival note rode along");
  assert.equal(t.turns, 1, "one turn, not two");
  void u;
});

test("arrivals are capped per hour", async () => {
  const { t } = await table({ cfg: { timelineMaxArrivalsPerHour: 1 } });
  assert.notEqual(t.scheduleArrival("w-main", { names: ["x"] }), null);
  assert.equal(t.scheduleArrival("w-main", { names: ["y"] }), null);
  await settle(t);
});

test("stale refreshes never overwrite newer ones", async () => {
  const { t, api } = await table();
  const realWindows = api.windows.bind(api);
  let first = true;
  api.windows = async () => { const snapshot = await realWindows(); if (first) { first = false; await new Promise((r) => setTimeout(r, 20)); } return snapshot; };
  const slow = t.refresh();
  api.windows_.push({ id: "w-late", name: "Late", kind: "group", members: [{ user_id: "u-bot" }] });
  await t.refresh();
  await slow;
  assert.ok(t.windows.some((w) => w.id === "w-late"), "the newer list stays");
});

test("scenarios: the GM may advance only from the Main Chat, after the minimums, never during a short split or an autonomous turn", async () => {
  const { t, api, clock } = await table({ cfg: { scenarioMinMinutes: 20, scenarioMinLines: 30, autonomyQuietMs: MIN } });
  const note = () => api.posts.filter((p) => p.visibility === "gm_only" && p.content.startsWith("Scenario change refused")).at(-1)?.content ?? "";
  t.scenario = { id: "sc1", since: clock.t };
  await alicePosts(t, api, "We sleep. The next morning we go out.");
  await settle(t);
  assert.equal(api.advanced.length, 0); assert.match(note(), /began 0 min ago/);
  clock.t += 21 * MIN;
  await alicePosts(t, api, "The next morning, then.");
  await settle(t);
  assert.equal(api.advanced.length, 0); assert.match(note(), /only 5 lines/);
  api.scenes_[0].event_count = 40;
  // A short split blocks it.
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Cellar" });
  await settle(t);
  await alicePosts(t, api, "Next morning.");
  await settle(t);
  assert.equal(api.advanced.length, 0); assert.match(note(), /briefly split/);
  // A long split does not.
  t.timelines.update(t.timelines.of("c-harriet").id, { span: "long" });
  await alicePosts(t, api, "Next morning at last.");
  await settle(t);
  assert.equal(api.advanced.length, 1, "advanced"); assert.equal(api.currentScene, "sc2");
  assert.equal(t.scenario.id, "sc2"); assert.equal(t.timelines.main().narrativeTime, "next morning");
  // Never from another window, never in an autonomous turn.
  assert.equal((await t.scenarioVerdict(t.timelines.of("c-harriet").windowId, "human")).ok, false);
  assert.equal((await t.scenarioVerdict("w-main", "quiet")).ok, false);
  assert.equal((await t.scenarioVerdict("w-main", "arrival")).ok, false);
});

test("enter_scenario picks a prepared scenario by title", async () => {
  const llm = new MockLlm();
  llm.director = (user) => (user.includes("NEWEST LINE") && !user.includes("MODE:") ? { actions: [{ type: "enter_scenario", scenario: "The lighthouse", reason: "they sail out" }], coplayers_may_act: false } : { actions: [], coplayers_may_act: false });
  const { t, api, clock } = await table({ llm, cfg: { scenarioMinMinutes: 0, scenarioMinLines: 0 } });
  api.scenes_.push({ id: "sc-light", title: "The lighthouse", status: "active", event_count: 0 });
  t.scenario = { id: "sc1", since: clock.t - 1 };
  await alicePosts(t, api, "We sail out.");
  await settle(t);
  assert.deepEqual(api.advanced, [{ entered: "sc-light" }]);
});

test("a lone player who leaves keeps the Main Chat (it moves with them); the co-player left behind gets a side window", async () => {
  const { t, api } = await table();
  t.timelines.relocate("main", { location: "Hale House" });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  assert.equal(t.timelines.of("c-alice").id, "main", "Alice never has to change windows");
  assert.equal(t.timelines.main().location, "docks");
  const side = t.timelines.of("c-harriet");
  assert.notEqual(side.id, "main"); assert.equal(side.location, "Hale House");
  assert.equal(api.createdWindows[0].name, "Side: Hale House"); assert.equal(api.membershipWrites, 1, "the humans also get a private primary scene");
});

test("an autonomous turn's followup never changes the scenario", async () => {
  const llm = new MockLlm();
  llm.director = (user) => {
    const mode = (user.match(/^MODE: (\w+)/m) ?? [])[1] ?? "human";
    if (mode === "quiet") return { actions: [{ type: "narrate", text: "Time passes." }], coplayers_may_act: true };
    if (mode === "followup") return { actions: [{ type: "advance_scenario", title: "Dawn", narrative_time: "dawn", reason: "x" }], coplayers_may_act: false };
    return { actions: [{ type: "narrate", text: "ok" }], coplayers_may_act: false };
  };
  const { t, api, clock } = await table({ llm, cfg: { scenarioMinMinutes: 0, scenarioMinLines: 0, autonomyQuietMs: MIN } });
  await alicePosts(t, api, "Hm.");
  await settle(t);
  clock.t += MIN + 1;
  assert.notEqual(await t.tick(), null, "a quiet turn runs");
  await settle(t);
  assert.ok(directorCalls(llm).some((u) => u.startsWith("MODE: followup") || u.includes("\nMODE: followup")), "the co-players acted and the GM followed up");
  assert.deepEqual(api.advanced, []);
  assert.ok(api.posts.some((p) => p.visibility === "gm_only" && p.content.startsWith("Scenario change refused") && /autonomous/.test(p.content)));
});

test("a player's lines wait for the human turn even when an arrival turn runs first", async () => {
  // The GM reads Alice's line from the context (the arrival's narration is newer); the move counts only if her line
  // is still in the human turn's batch.
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (!/^MODE: /m.test(user) && user.includes("Alice Hale: I go to the docks.") ? { actions: [{ type: "narrate", text: "She leaves." }], coplayers_may_act: false, whereabouts: [{ who: ["Alice Hale"], thread: "new", place: "Docks", own_scene: true }] } : base(user));
  const { t, api } = await table({ llm, bob: true, cfg: { debounceMs: 30 } });
  const human = alicePosts(t, api, "I go to the docks.");
  await t.turn("w-main", { mode: "arrival", arrival: { names: ["Harriet Vance"], reunion: true } });
  await human; await settle(t);
  assert.ok(directorCalls(llm).some((u) => u.includes("Harriet Vance just rejoined")));
  assert.equal(api.createdWindows.length, 2, "her own line moved her and both parties were partitioned");
  assert.equal(t.timelines.of("c-alice").location, "Docks");
});

test("a player leaving a shared scene is paused; the co-player keeps the same window", async () => {
  const { t, api, llm } = await table({ bob: true });
  await t.command({ cmd: "split", who: ["Alice Hale", "Harriet Vance"], place: "Docks" });
  await settle(t);
  const docks = t.timelines.of("c-alice");
  const callsBefore = directorCalls(llm).length;
  await alicePosts(t, api, "Nothing here. I go back to the others.", docks.windowId);
  await settle(t);
  assert.equal(t.timelines.of("c-alice").id, "main");
  const harriet = t.timelines.of("c-harriet");
  assert.notEqual(harriet.id, "main"); assert.equal(harriet.windowId, docks.windowId, "stayers keep their scene");
  assert.ok(api.visibilityChanges.some(v => v.id === docks.windowId && v.user === "u-alice" && v.paused));
  assert.deepEqual(t.windowUsers(harriet.windowId), [], "Alice cannot read where Harriet stayed");
  const later = directorCalls(llm).slice(callsBefore);
  assert.ok(later.some((u) => u.includes("Alice Hale just rejoined")), "Alice's reunion is narrated");
  assert.ok(!later.some((u) => u.includes("Harriet Vance just rejoined")), "Harriet never 'rejoins' anyone");
});

test("a roll for someone in another scene is not requested here", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (user.includes("listen for her") ? { actions: [{ type: "request_roll", who: "Alice Hale", command: ".ra Listen", text: "Alice, something stirs." }], coplayers_may_act: false } : base(user));
  const { t, api } = await table({ llm, bob: true });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  await bobSays(t, api, "I listen for her.");
  await settle(t);
  assert.ok(!api.posts.some((p) => p.content.includes("→ Alice Hale: .ra Listen")), "no roll request for Alice");
  assert.ok(api.posts.some((p) => p.visibility === "gm_only" && p.content.startsWith("Roll request for Alice Hale not posted")));
});

test("relay never widens who reads a line: a scene with other readers gets only the pointer", async () => {
  const { t, api, llm } = await table({ bob: true });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  const home = t.timelines.of("c-alice").windowId;
  api.channelUsers.push("u-carol");
  api.windows_.find((w) => w.id === home).members.push({ user_id: "u-carol" });
  await t.refresh();
  const before = api.posts.length;
  await alicePosts(t, api, "I search the crates.", "w-main");
  await settle(t);
  assert.ok(!directorCalls(llm).some((u) => u.includes("MODE: relay") && u.includes("I search the crates")), "no relay into a window Carol reads");
  assert.ok(api.posts.slice(before).some((p) => p.window === "w-main" && p.visibility === "whisper"), "the pointer is still posted");
});

test("isolated channels warn only when players share a player group", async () => {
  const api = new FakeApi();
  api.knowledgeMode = "isolated";
  const t = await new Table({ api, llm: new MockLlm(), cfg: { ...buildConfig({}, {}), sceneForks: true, debounceMs: 0 }, channelId: "ch", roster: new Roster(), sleep: async () => {} }).init();
  assert.equal(t.splitWarning, null);
  api.groups = [{ id: "g1", name: "Party", members: [{ user_id: "u-alice" }, { user_id: "u-bob" }] }];
  const t2 = await new Table({ api, llm: new MockLlm(), cfg: { ...buildConfig({}, {}), sceneForks: true, debounceMs: 0 }, channelId: "ch", roster: new Roster(), sleep: async () => {} }).init();
  assert.match(t2.splitWarning, /share a player group \(Party\)/);
});

test("co-players are GM-cast PCs: every PC the GM account owns is one, older marked NPCs still are, and none is taken for a player", async () => {
  const legacy = { id: "c-old", name: "Old Ned", kind: "npc", user_id: null, speaking_style: markStyle("gruff"), bio: "An older co-player." };
  const { t } = await table({ extraCharacters: [legacy] });
  assert.ok(t.roster.isCoplayer("c-harriet"), "a PC the GM owns is a co-player");
  assert.ok(t.roster.isCoplayer("c-old"), "a marked NPC from an older version still is");
  assert.ok(t.roster.isNpc("c-butler"), "an unmarked NPC is a real NPC");
  assert.equal(t.isPc("c-harriet"), false, "a GM-cast PC is not a player character");
  assert.equal(t.isPc("c-alice"), true);
  const ctx = await t.gm.build({ windowId: "w-main", roster: t.roster, characters: t.characters, windows: t.windows, timelines: t.timelines, sceneOf: (w) => t.scene(w) });
  const cast = ctx.text.slice(ctx.text.indexOf("## Cast"));
  assert.ok(cast.indexOf("Harriet Vance") > cast.indexOf("Co-players"), "listed with the co-players, not the player characters");
});

// ---- improvisation mode
const IMPROV = { on: true, world: "WORLD-PUBLIC: Kingsport, 1923. A fog-bound port; the Harbour Guild runs the docks.", secrets: "WORLD-SECRET: the Guild master drowned the lighthouse keeper." };

test("improvisation: the world is posted once for the players, and the GM and co-players get it as a section of its own", async () => {
  const { t, api, llm } = await table({ improv: IMPROV, heal: true });
  const posted = api.posts.filter((p) => p.window === "w-main" && p.content.includes("WORLD-PUBLIC"));
  assert.equal(posted.length, 1, "posted in the Main Chat"); assert.equal(posted[0].visibility, "window"); assert.match(posted[0].content, /^World setting/);
  await t.publishWorld();
  assert.equal(api.posts.filter((p) => p.content.includes("WORLD-PUBLIC")).length, 1, "never posted twice for the same text");
  await alicePosts(t, api, "I look out over the harbour.");
  await settle(t);
  const director = llm.calls.find((c) => c.purpose === "director");
  const ctx = director.messages[0].content;
  assert.ok(ctx.includes("## World setting") && ctx.includes("WORLD-PUBLIC"));
  assert.ok(ctx.includes("## Hidden truths") && ctx.includes("WORLD-SECRET"), "the GM keeps the secrets");
  assert.equal(ctx.split("WORLD-PUBLIC").length - 1, 1, "the posted copy is left out of the chat");
  assert.ok(!ctx.includes("SECRET-SCRIPT"), "no module script knowledge");
  assert.match(director.system, /there is no module/); assert.match(director.system, /"type": "truth"/);
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.ok(cp.includes("THE WORLD") && cp.includes("WORLD-PUBLIC"), "the co-player knows the world");
  assert.equal(cp.split("WORLD-PUBLIC").length - 1, 1, "once, not again from the chat");
  assert.ok(!cp.includes("WORLD-SECRET"), "never the GM's secrets");
  assert.ok(cp.includes("PERSONA: A sharp antiquarian."), "and its own personality and background");
});

test("improvisation: a hidden truth the GM decides is kept for the GM and never reaches a co-player", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (user.includes("Who did it") ? { actions: [{ type: "truth", text: "TRUTH-X: the harbour master forged the manifest." }, { type: "narrate", text: "The clerk looks away." }], coplayers_may_act: true } : base(user));
  const { t, api } = await table({ llm, improv: IMPROV });
  await alicePosts(t, api, "Who did it?");
  await settle(t);
  assert.deepEqual(t.improv.truths.map((x) => x.text), ["TRUTH-X: the harbour master forged the manifest."]);
  assert.ok(!api.posts.some((p) => p.content.includes("TRUTH-X")), "nothing is posted");
  await alicePosts(t, api, "Anything else?");
  await settle(t);
  assert.ok(llm.calls.filter((c) => c.purpose === "director").at(-1).messages[0].content.includes("TRUTH-X"), "the GM keeps to it");
  assert.ok(!llm.calls.filter((c) => c.purpose === "coplayer_turn").some((c) => c.messages[0].content.includes("TRUTH-X")));
});

test("improvisation off: the module guides the GM, no world, and truth is not an action", async () => {
  const { t, api, llm } = await table();
  await alicePosts(t, api, "Hello.");
  await settle(t);
  const director = llm.calls.find((c) => c.purpose === "director");
  assert.ok(director.messages[0].content.includes("SECRET-SCRIPT")); assert.ok(!director.messages[0].content.includes("## World setting"));
  assert.ok(!/"type": "truth"/.test(director.system));
  assert.equal(t.improv.on, false);
});

test("the world command turns the mode on, posts a long setting in parts, and posts it again only when it changes", async () => {
  const { t, api } = await table();
  const long = Array.from({ length: 6 }, (_, i) => `PART-${i} ${"x".repeat(1500)}`).join("\n\n");
  await t.command({ cmd: "world", on: true, world: long, secrets: "S" });
  const parts = api.posts.filter((p) => p.content.startsWith("World setting ("));
  assert.ok(parts.length >= 3 && parts.every((p) => p.content.length <= 4100), `${parts.length} parts`);
  assert.ok(parts.at(-1).content.includes("PART-5"));
  await t.command({ cmd: "world", on: true, world: long });
  assert.equal(api.posts.filter((p) => p.content.startsWith("World setting (")).length, parts.length, "unchanged: not posted again");
  await t.command({ cmd: "world", world: "A new world." });
  assert.ok(api.posts.some((p) => p.content === "World setting\n\nA new world."));
  assert.equal(t.improv.secrets, "S", "secrets kept when not given");
});

// ---- long context: local history, compaction, co-player memory, cache layout, usage
const many = (api, n, { w = "w-main", text = (i) => `Line ${i}: the rain keeps falling over the harbour while we argue about the lighthouse keeper and his debts.` } = {}) => {
  for (let i = 0; i < n; i++) api.add({ chat_window_id: w, author_id: "u-alice", author_role: "player", character_id: "c-alice", content: text(i) });
};

test("history: a long window is copied once into the store, paging back past the first page", async () => {
  const api0 = new FakeApi();
  many(api0, 250);
  const { History } = await import("../src/memory.mjs");
  const { Store } = await import("../src/store.mjs");
  const store = new Store();
  const h = new History({ api: api0, store, channelId: "ch", pageSize: 100, backfill: 1000 });
  await h.sync("w-main");
  assert.equal(h.lines("w-main").length, 250);
  many(api0, 120);
  await h.sync("w-main");
  assert.equal(h.lines("w-main").length, 370, "the gap since the last sync is filled");
});

test("long context: old lines become a GM chapter, the newest stay word for word, and the GM keeps reading both", async () => {
  // Isolate compaction here; the recall test below explicitly verifies selected old evidence can return.
  const { t, api, llm } = await table({ cfg: { gmContextTokens: 4000, recallTokens: 0 } });
  many(api, 300);
  await alicePosts(t, api, "Where were we?");
  await settle(t); await t.memoryIdle();
  const chapters = t.store.chapters("gm", "w-main");
  assert.ok(chapters.length >= 1, "a chapter was written");
  const compact = llm.calls.find((c) => c.purpose === "compact");
  assert.ok(compact.messages[0].content.includes("LINES:") && compact.messages[0].content.includes("Line 0:"), "the oldest lines were summarised");
  await alicePosts(t, api, "And now?");
  await settle(t);
  const ctx = directorCalls(llm).at(-1);
  assert.ok(ctx.includes("## The story so far") && ctx.includes("[mock compact]"), "the chapter is in the GM's context");
  assert.ok(ctx.includes("And now?"), "the newest lines are word for word");
  assert.ok(!ctx.includes("Line 0: the rain"), "the compacted lines are not repeated");
});

test("co-player memory: its chapters come only from lines it witnessed, and it reads them in its turn", async () => {
  const { t, api, llm } = await table({ cfg: { coplayerContextTokens: 2500 } });
  for (let i = 0; i < 150; i++) {
    api.add({ chat_window_id: "w-main", author_id: "u-alice", author_role: "player", character_id: "c-alice", content: `Witnessed ${i}: we search the study for the ledger and find dust, letters and old receipts.` });
    if (i % 30 === 0) api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: `GM-ONLY-${i}: the ledger is in the clock`, visibility: "gm_only" });
  }
  await alicePosts(t, api, "Harriet, what do you think?");
  await settle(t); await t.memoryIdle();
  const mem = llm.calls.filter((c) => c.purpose === "coplayer_memory");
  assert.ok(mem.length >= 1, "a memory chapter was written");
  assert.ok(mem.every((c) => !c.messages[0].content.includes("GM-ONLY")), "never from GM-only lines");
  assert.match(mem[0].system, /You are Harriet Vance/);
  await alicePosts(t, api, "Harriet?");
  await settle(t);
  const turn = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.ok(turn.includes("WHAT YOU REMEMBER") && turn.includes("[mock coplayer_memory]"));
  assert.ok(!turn.includes("GM-ONLY"));
});

test("cache layout: the GM's prompt is stable-first, its cached parts unchanged between turns, the turn's details last", async () => {
  const { t, api, llm } = await table();
  await alicePosts(t, api, "Hello.");
  await settle(t);
  await alicePosts(t, api, "Hello again.");
  await settle(t);
  const calls = llm.calls.filter((c) => c.purpose === "director");
  const [first, second] = [calls.at(-2).parts[0], calls.at(-1).parts[0]];
  assert.ok(first[0].cache && first[0].text.includes("## Campaign") && first[0].text.includes("## Cast"));
  assert.ok(!first[0].text.includes("events so far"), "the per-turn event count is not in the cached prefix");
  assert.equal(first[0].text, second[0].text, "the campaign part is byte-identical across turns");
  assert.ok(!first.at(-1).cache && first.at(-1).text.includes("NEWEST LINE"), "the turn's details are last and uncached");
  assert.ok(first.filter((p) => p.cache).length <= 3, "at most three cache marks besides the system prompt");
  const cp = llm.calls.find((c) => c.purpose === "coplayer_turn").parts[0];
  assert.ok(cp[0].cache && cp[0].text.startsWith("YOU ARE: Harriet Vance"));
  assert.ok(cp.at(-1).text.includes("Your move?") && !cp.at(-1).cache);
});

test("usage is recorded per call, and the daily budget stops autonomous turns", async () => {
  const { t, api, clock } = await table({ cfg: { autonomyQuietMs: MIN } });
  await alicePosts(t, api, "Hm.");
  await settle(t);
  const u = t.store.usageSince(0);
  assert.ok(u.calls >= 2 && u.input > 0 && u.output > 0);
  t.cfg.dailyTokenBudget = 1;
  clock.t += MIN + 1;
  assert.equal(await t.tick(), null, "no quiet turn once the budget is spent");
  t.cfg.dailyTokenBudget = 0;
  assert.notEqual(await t.tick(), null);
  await settle(t);
});

test("GM documents keep their newest entries when they are too long", async () => {
  const { t, api } = await table({ cfg: { gmContextTokens: 16000 } });
  const entries = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, section: "Clues", content_md: `CLUE-${i}: ${"a long clue about the harbour ".repeat(6)}`, updated_version: i + 1 }));
  api.document = async () => ({ entries });
  await alicePosts(t, api, "Clues?");
  await settle(t);
  const docs = await t.gm.documents();
  assert.ok(docs[0].includes("CLUE-59") && !docs[0].includes("CLUE-0:"), "newest kept, oldest dropped");
  assert.match(docs[0], /\(\d+ older entries not shown\)/);
});

test("a scene that ends becomes a chapter of the GM's memory", async () => {
  const { t, api } = await table({ bob: true });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  const side = t.timelines.of("c-alice");
  await alicePosts(t, api, "Nothing here. I go back to the others.", side.windowId);
  await settle(t); await t.memoryIdle();
  assert.equal(t.store.chapters("gm", side.windowId).length, 1);
});

// ---- fragmented play: away mode, pace, returning players
test("away mode: with nobody around, a co-players-only thread still moves, rarely; shared windows wait", async () => {
  const { t, api, clock } = await table({ cfg: { autonomyIdleMinutes: 30, awaySideIntervalMs: 6 * 3600000, autonomySideIntervalMs: MIN, autonomyQuietMs: MIN } });
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Lighthouse", span: "long" });
  await settle(t);
  await alicePosts(t, api, "Back soon.");
  await settle(t);
  clock.t += 2 * 3600000;                                   // two hours: away
  assert.equal(await t.tick(), null, "away: the side thread waits for AWAY_SIDE_INTERVAL_MS");
  clock.t += 5 * 3600000;                                   // seven hours since anyone posted
  const before = t.turns;
  assert.notEqual(await t.tick(), null, "the side thread moves after the away interval");
  await settle(t);
  assert.equal(t.turns, before + 1);
  assert.equal(t.scene(api.createdWindows[0].id).members[0], "c-harriet");
  t.cfg.awaySideIntervalMs = 0;
  clock.t += 7 * 3600000;
  assert.equal(await t.tick(), null, "AWAY_SIDE_INTERVAL_MS=0: nothing moves while everyone is away");
});

test("pace: in a quiet turn a co-player who already answered the last human line stays quiet", async () => {
  const llm = new MockLlm();
  const { t, api, clock } = await table({ llm, cfg: { autonomyQuietMs: MIN, autonomyQuietTurns: 2 } });
  await alicePosts(t, api, "Harriet, the clock?");
  await settle(t);
  const turnsOf = () => llm.calls.filter((c) => c.purpose === "coplayer_turn").length;
  const afterHuman = turnsOf();
  assert.equal(afterHuman, 1, "she answers the human line");
  clock.t += MIN + 1;
  await t.tick(); await settle(t);
  assert.equal(turnsOf(), afterHuman, "not again in the quiet turn that follows");
  await alicePosts(t, api, "Well?");
  await settle(t);
  assert.equal(turnsOf(), afterHuman + 1, "a new human line gives her another go");
});

test("a player back after being away is welcomed back, and away players are marked for the GM", async () => {
  const llm = new MockLlm();
  const { t, api, clock } = await table({ llm, bob: true, cfg: { autonomyIdleMinutes: 30 } });
  await alicePosts(t, api, "I sit by the fire.");
  t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: "w-main", author_id: "u-bob", author_role: "player", character_id: "c-bob", content: "I read the paper." }) });
  await settle(t);
  clock.t += 9 * 3600000;
  await alicePosts(t, api, "Morning. Anything new?");
  await settle(t);
  const u = directorCalls(llm).find((x) => x.includes("Morning. Anything new?") && !/^MODE: /m.test(x));
  assert.match(u, /RETURNING: Alice Hale's player is back after 9 h away/);
  assert.match(u, /Bob Price \(player away 9 h\)/, "Bob, who has not posted, is marked away");
  assert.match(llm.calls.find((c) => c.purpose === "director").system, /player away/);
  const n = directorCalls(llm).length;
  await alicePosts(t, api, "Let's go.");
  await settle(t);
  assert.ok(!directorCalls(llm).slice(n).some((x) => x.includes("RETURNING")), "only once");
});

// ---- the platform's living world record
test("the world record is in the GM's context, never a co-player's, and world_change declares to the platform", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (user.includes("Meanwhile?") && !/^MODE: /m.test(user) ? { actions: [{ type: "world_change", text: "WORLD-CHANGE: the Guild closes the docks at night.", secret: true }, { type: "narrate", text: "Night falls." }], coplayers_may_act: true } : base(user));
  const { t, api } = await table({ llm });
  api.world_ = { version: 3, entities: [
    { id: "e1", kind: "npc", name: "Silas Mott", status: "dead", state: "RECORD-SILAS found drowned under the pier", location: null, state_by: "gm", state_updated_at: "2026-11-01T10:00:00Z" },
    { id: "e2", kind: "location", name: "Old Mill", status: "unknown", state: "", location: null },
  ], recent_changes: [{ entity_id: "e1", name: "Silas Mott", status: "dead", state: "RECORD-SILAS found drowned", actor: "gm" }] };
  await alicePosts(t, api, "Meanwhile?");
  await settle(t);
  const director = llm.calls.find((c) => c.purpose === "director");
  const ctx = director.messages[0].content;
  assert.match(ctx, /## The world now/); assert.match(ctx, /\[npc\] Silas Mott — dead: RECORD-SILAS found drowned under the pier \[set by you\]/);
  assert.ok(!ctx.includes("Old Mill"), "entities with nothing known are left out");
  assert.match(director.system, /"type": "world_change"/);
  assert.ok(!llm.calls.filter((c) => c.purpose === "coplayer_turn").some((c) => c.messages[0].content.includes("RECORD-SILAS")), "co-players never read the GM's record");
  assert.deepEqual(api.declared, [{ text: "WORLD-CHANGE: the Guild closes the docks at night.", secret: true }]);
  assert.ok(!api.posts.some((p) => p.content.includes("WORLD-CHANGE")), "a declaration is never a chat line");
});

test("improvisation: the world and secrets are handed to the platform's world record once per version, truths as secrets", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (user.includes("Who did it") ? { actions: [{ type: "truth", text: "TRUTH-Y: the clerk forged it." }], coplayers_may_act: false } : base(user));
  const { t, api } = await table({ llm, improv: IMPROV, heal: true });
  assert.deepEqual(api.declared.map((d) => [d.text.slice(0, 12), d.secret]), [["WORLD-PUBLIC", false], ["WORLD-SECRET", true]]);
  await t.publishWorld(); await t.seedWorld();
  assert.equal(api.declared.length, 2, "not again for the same texts");
  await t.command({ cmd: "world", secrets: "WORLD-SECRET-2: the keeper lives." });
  assert.equal(api.declared.at(-1).text, "WORLD-SECRET-2: the keeper lives."); assert.equal(api.declared.at(-1).secret, true);
  await alicePosts(t, api, "Who did it?");
  await settle(t);
  assert.deepEqual(api.declared.at(-1), { text: "TRUTH-Y: the clerk forged it.", secret: true });
});

test("a platform without the world record: declarations are dropped once, the table carries on", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (user.includes("Meanwhile?") ? { actions: [{ type: "world_change", text: "X" }, { type: "narrate", text: "Ok." }], coplayers_may_act: false } : base(user));
  const { t, api } = await table({ llm });
  api.noWorld = true;
  await alicePosts(t, api, "Meanwhile?");
  await settle(t);
  assert.equal(t.worldUnsupported, true);
  assert.ok(api.posts.some((p) => p.content === "Ok."), "the turn went on");
  assert.equal(await t.declare("Y"), false);
});

// ---- casual mode: phones
const isolated = async (opts = {}) => {
  const r = await table({ ...opts, bob: true, heal: false });
  r.api.knowledgeMode = "isolated";
  r.t.channel.knowledge_mode = "isolated"; r.t.publicSplits = false; r.t.splitWarning = null;
  await r.t.setCasual(true); await settle(r.t);
  await r.t.refresh();
  return r;
};
const phoneOf = (t, id) => t.casual.phones[id];
const texts = (t, api, id) => api.posts.filter((p) => p.window === phoneOf(t, id) && p.kind === "ic");
const textFrom = (t, api, who, content) => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: phoneOf(t, who), author_id: who === "c-bob" ? "u-bob" : "u-alice", author_role: "player", character_id: who, content }) });

test("casual mode is refused on a public channel: phones would not be private", async () => {
  const { t, api } = await table({ bob: true });
  await t.setCasual(true);
  assert.deepEqual(t.casual.phones, {}); assert.equal(api.createdWindows.length, 0);
  assert.equal(t.casualOn(), false);
});

test("casual: each player character gets a private phone; a phone line never starts a scene turn", async () => {
  const { t, api, llm } = await isolated();
  assert.deepEqual(Object.keys(t.casual.phones).sort(), ["c-alice", "c-bob"]);
  const alicePhone = api.createdWindows.find((w) => w.id === phoneOf(t, "c-alice"));
  assert.equal(alicePhone.name, "Phone: Alice Hale"); assert.equal(alicePhone.kind, "private");
  assert.deepEqual(alicePhone.members.map((m) => m.user_id), ["u-bot", "u-alice"], "only her player");
  const log = api.createdWindows.find((w) => w.id === t.casual.log);
  assert.equal(log.name, "Phone log (GM only)"); assert.deepEqual(log.members.map((m) => m.user_id), ["u-bot"], "the GM alone");
  await t.setCasual(true);
  assert.equal(api.createdWindows.length, 3, "two phones and the log, opened once");
  const before = directorCalls(llm).length;
  await textFrom(t, api, "c-alice", "@Bob Price meet me at the pier");
  await settle(t);
  assert.equal(directorCalls(llm).length, before, "no scene turn");
  assert.deepEqual(texts(t, api, "c-bob").map((p) => [p.content, p.character_id]), [["meet me at the pier", "c-alice"]], "relayed to Bob's phone at once, as Alice");
  await textFrom(t, api, "c-bob", "On my way.");
  await settle(t);
  assert.deepEqual(texts(t, api, "c-alice").map((p) => [p.content, p.character_id]), [["On my way.", "c-bob"]], "a reply without @ goes back to the sender");
  assert.equal(await t.tick(), null, "phones never get autonomous turns");
});

test("casual: an NPC answers a text through the GM after a believable delay, and nothing happens in any scene", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (/^MODE: phone/m.test(user) ? { actions: [{ type: "text", from: "Mr. Grimsby", to: "Alice Hale", text: "Under the clock, miss.", delay_minutes: 30 }, { type: "narrate", text: "NOT-IN-A-SCENE" }], coplayers_may_act: true } : base(user));
  const { t, api, clock } = await isolated({ llm });
  await textFrom(t, api, "c-alice", "@Mr. Grimsby where is the key?");
  await settle(t);
  const call = llm.calls.filter((c) => c.purpose === "director").at(-1);
  assert.match(call.messages[0].content, /MODE: phone — Alice Hale texted Mr\. Grimsby/);
  assert.match(call.system, /"type": "text"/); assert.match(call.system, /Casual mode/);
  assert.equal(texts(t, api, "c-alice").length, 0, "not yet");
  assert.ok(!api.posts.some((p) => p.content === "NOT-IN-A-SCENE"), "a phone turn narrates nothing");
  clock.t += 31 * MIN;
  assert.equal(await t.deliverDue(), 1);
  assert.deepEqual(texts(t, api, "c-alice").map((p) => [p.content, p.character_id]), [["Under the clock, miss.", "c-butler"]]);
  assert.deepEqual(t.store.thread("c-alice", "c-butler").map((r) => r.text), ["where is the key?", "Under the clock, miss."]);
});

test("casual: a co-player answers a text in character, knowing only its own messages", async () => {
  const { t, api, llm, clock } = await isolated();
  await textFrom(t, api, "c-alice", "@Harriet are you coming?");
  await settle(t);
  const call = llm.calls.find((c) => c.purpose === "coplayer_phone");
  assert.ok(call.messages[0].content.includes("are you coming?") && call.messages[0].content.startsWith("YOU ARE: Harriet Vance"));
  assert.ok(!SECRETS.some((s) => call.messages[0].content.includes(s)), "no GM secrets");
  clock.t += 6 * MIN;
  await t.deliverDue();
  assert.deepEqual(texts(t, api, "c-alice").map((p) => p.character_id), ["c-harriet"]);
});

test("casual: a co-player may text a player first; without casual mode the GM has no text action", async () => {
  const llm = new MockLlm();
  llm.coplayer = (user) => (user.includes("YOUR PHONE") || /casual/i.test(user) ? { action: "text", to: "Alice Hale", text: "psst, look at the clock" } : { action: "text", to: "Alice Hale", text: "psst, look at the clock" });
  const { t, api } = await isolated({ llm });
  await alicePosts(t, api, "Hm.");
  await settle(t);
  assert.ok(texts(t, api, "c-alice").some((p) => p.character_id === "c-harriet" && p.content === "psst, look at the clock"));
  const plain = await table();
  await alicePosts(plain.t, plain.api, "Hm.");
  await settle(plain.t);
  assert.ok(!/"type": "text"/.test(plain.llm.calls.find((c) => c.purpose === "director").system));
});

test("casual: a line naming no known contact gets a hint, and nobody is texted", async () => {
  const { t, api } = await isolated();
  await textFrom(t, api, "c-alice", "@Nobody Atall hello?");
  await settle(t);
  assert.ok(api.posts.some((p) => p.window === phoneOf(t, "c-alice") && p.content.startsWith("(No one by that name")));
  assert.equal(t.store.phoneOf("c-alice").length, 0);
});

test("casual: addressing picks the longest name, prefers a full name, and needs no separator after a CJK name", async () => {
  const { parseAddress } = await import("../src/casual.mjs");
  const c = [{ id: "a", name: "Silas Mott" }, { id: "b", name: "Silas" }, { id: "z", name: "张三" }, { id: "m", name: "Mr. Grimsby" }];
  assert.deepEqual(parseAddress("@Silas Mott where?", c), { to: "a", body: "where?", addressed: true });
  assert.equal(parseAddress("@Silas hi", c).to, "b");
  assert.deepEqual(parseAddress("@张三在吗", c), { to: "z", body: "在吗", addressed: true });
  assert.equal(parseAddress("@Mr. Grimsby key?", c).to, "m");
  assert.equal(parseAddress("@Silasx hi", c).to, null);
  assert.deepEqual(parseAddress("no at", c), { to: null, body: "no at", addressed: false });
});

test("a co-player in another timeline never learns what happens in the Main Chat meanwhile, nor after it returns", async () => {
  // A GM that does not quote the chat back (the mock's placeholder narration repeats the newest line, which would
  // put an old Main Chat line in front of her as something said after her return).
  const llm = new MockLlm();
  llm.director = () => ({ actions: [{ type: "narrate", text: "Time passes." }], coplayers_may_act: true });
  const { t, api, clock } = await table({ llm, bob: true, cfg: { autonomySideIntervalMs: MIN } });
  await alicePosts(t, api, "We search the study together.");
  await settle(t);
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Lighthouse", span: "long" });
  await settle(t);
  const side = t.timelines.of("c-harriet").windowId;
  // While she is away, Alice plays on in the Main Chat and the GM answers there.
  await alicePosts(t, api, "MAIN-WHILE-AWAY: I open the safe and find the ledger.");
  await settle(t);
  clock.t += MIN + 1;
  await t.tick(); await settle(t);                         // her side thread moves on its own
  const harriet = () => llm.calls.filter((c) => c.purpose === "coplayer_turn" && c.messages[0].content.startsWith("YOU ARE: Harriet")).at(-1).messages[0].content;
  const away = harriet();
  assert.ok(away.includes("We search the study together."), "she remembers what she saw before leaving");
  assert.ok(!away.includes("MAIN-WHILE-AWAY"), "she never sees the Main Chat while she is away");
  assert.ok(!llm.calls.some((c) => c.purpose === "coplayer_memory" && c.messages[0].content.includes("MAIN-WHILE-AWAY")));
  // She comes back: only what is said from then on reaches her.
  await t.command({ cmd: "rejoin", timeline: "Lighthouse" });
  await settle(t);
  await alicePosts(t, api, "Harriet, you're back! What did you find?");
  await settle(t);
  const back = harriet();
  assert.ok(back.includes("you're back"), "she hears the Main Chat again");
  assert.ok(!back.includes("MAIN-WHILE-AWAY"), "but not what happened there while she was away");
  assert.ok(side && t.timelines.retired(side));
});

// ---- the story planner
const pcfg = (over = {}) => ({ planner: { ...buildConfig({}, {}).planner, cooldownMs: 0, stallTurns: 1000, ...over } });
const plannerCalls = (llm) => llm.calls.filter((c) => c.purpose === "planner");
const stepOf = (c) => (c.messages.at(-1).content.match(/^STEP: (\w+)/m) ?? [])[1];
const planned = async (t, api, n = 10) => { for (let i = 0; i < n; i++) { await alicePosts(t, api, `Line ${i}: we ask around the harbour about the keeper.`); await settle(t); } await t.memoryIdle(); await settle(t); };

test("the first story plan: drafted, critiqued and revised in one cached conversation, adopted at the turn boundary, noted once", async () => {
  const { t, api, llm } = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  await planned(t, api);
  const arc = t.planner.arc;
  assert.ok(arc, "a plan was adopted"); assert.equal(arc.version, 1); assert.equal(arc.trigger, "first"); assert.equal(arc.mode, "full");
  assert.equal(arc.beat.title, "[mock beat] The present trouble"); assert.equal(arc.threads[0].id, "P1");
  const calls = plannerCalls(llm);
  assert.deepEqual(calls.map(stepOf), ["draft", "critique", "revise"], "three steps, in order");
  const recorded = t.store.usageCalls({ purpose: "planner" }).reverse();
  assert.deepEqual(recorded.map((r) => r.phase), ["draft", "critique", "revise"]);
  assert.ok(recorded.every((r) => r.output > 0 && r.usageKnown && r.estimated));
  assert.ok(calls[1].messages[0].content === calls[0].messages[0].content && calls[1].messages[1].role === "assistant", "the critique continues the draft's conversation");
  assert.ok(calls[0].parts[0][0].cache && calls[0].parts[0][0].text.includes("## Campaign") && calls[0].parts[0][0].text.includes("## Previous story plan"), "the context is one cached part");
  assert.ok(calls[2].parts.flat().filter((p) => p.cache).length <= 3, "at most three cache marks");
  assert.match(calls[0].system, /story planner/); assert.match(calls[0].system, /Be bold/);
  const notes = api.posts.filter((p) => p.visibility === "gm_only" && p.content.startsWith("Story plan v1"));
  assert.equal(notes.length, 1); assert.match(notes[0].content, /beat "\[mock beat\] The present trouble"/); assert.match(notes[0].content, /Impulse for Harriet Vance/);
  await t.adoptPlan();
  assert.equal(api.posts.filter((p) => p.content.startsWith("Story plan v1")).length, 1, "adoption is idempotent");
  assert.ok(t.store.latestPlan().record.draft && t.store.latestPlan().record.critique && t.store.latestPlan().record.final);
  // The GM reads the plan in part C only; a co-player reads its impulse, never the plan; the GM never reads the impulse.
  await alicePosts(t, api, "Harriet, what do you think?");
  await settle(t);
  const director = llm.calls.filter((c) => c.purpose === "director").at(-1);
  const parts = director.parts[0];
  assert.ok(!parts[0].text.includes("## Story plan"), "not in A");
  assert.ok(parts.slice(1, -1).some((p) => p.cache && p.text.includes("## Story plan") && p.text.includes("[mock twist]")), "in a cached middle part");
  assert.match(director.system, /Story plan: your private plan/); assert.match(director.system, /"type": "planner_note"/);
  assert.ok(!director.messages[0].content.includes("[mock impulse]"), "the GM never reads an impulse");
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn" && c.messages[0].content.startsWith("YOU ARE: Harriet")).at(-1).messages[0].content;
  assert.ok(cp.includes("SOMETHING ON YOUR MIND") && cp.includes("[mock impulse]"), "Harriet has her impulse");
  assert.ok(!cp.includes("[mock twist]") && !cp.includes("Story plan"), "and nothing of the plan");
  assert.deepEqual(require_(plannerStateRoundTrip(t)), require_(t.planner), "the state survives a save and reload");
});
import { plannerState as _plannerState } from "../src/planner.mjs";
const plannerStateRoundTrip = (t) => _plannerState(JSON.parse(JSON.stringify(t.planner)));
const require_ = (x) => JSON.parse(JSON.stringify(x));

test("the planner's MOVE ON lifts the scenario pace guard; the change closes the beat and spends the verdict", async () => {
  const llm = new MockLlm();
  const base = llm.planner.bind(llm);
  // Only the first plan says move on; the replan after the scenario change (trigger "scenario") goes back to "continue".
  llm.planner = (u) => { const r = base(u); if (r.verdict && u.includes("(none yet: this is the first plan)")) r.verdict = { move_on: true, why: "they have searched the same office for six turns" }; return r; };
  const { t, api, clock } = await table({ llm, improv: IMPROV, heal: true, cfg: { ...pcfg(), scenarioMinMinutes: 20, scenarioMinLines: 30 } });
  t.scenario = { id: "sc1", since: clock.t };
  await planned(t, api);
  assert.equal(t.planner.arc.verdict.moveOn, true);
  const v = await t.scenarioVerdict("w-main", "human");
  assert.equal(v.planner, true, JSON.stringify(v));
  assert.equal((await t.scenarioVerdict("w-main", "quiet")).ok, false, "still never in an autonomous turn");
  const before = api.advanced.length;
  await alicePosts(t, api, "We sleep. The next morning we set out.");
  await settle(t);
  assert.equal(api.advanced.length, before + 1, "advanced before the 20 minutes and 30 lines");
  assert.match(directorCalls(llm).find((u) => u.includes("The next morning we set out.") && !/^MODE: /m.test(u)), /PLANNER: the story planner judges the current event/);
  await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.version, 2); assert.equal(t.planner.arc.trigger, "scenario", "the change asked for a new plan");
  assert.equal(t.planner.arc.verdict.moveOn, false, "spent");
  assert.equal((await t.scenarioVerdict("w-main", "human")).ok, false, "the guard is back");
});

test("module-led campaign: the planner judges pace only", async () => {
  const { t, api, llm } = await table({ cfg: pcfg() });
  await planned(t, api);
  assert.equal(t.planner.arc.mode, "pace");
  assert.match(plannerCalls(llm)[0].system, /the module has the plots/); assert.doesNotMatch(plannerCalls(llm)[0].system, /Be bold/);
  assert.deepEqual([t.planner.arc.threads, t.planner.arc.next, t.planner.impulses], [[], [], []]);
  assert.match(t.storyPlanSection(), /^## Story plan \(pace only/);
  await alicePosts(t, api, "Harriet?"); await settle(t);
  assert.ok(!llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content.includes("SOMETHING ON YOUR MIND"));
});

test("a stalled story asks the planner again; a planner_note from the GM does too, and closes the beat", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (u) => (u.includes("I give up") && !/^MODE: /m.test(u) ? { actions: [{ type: "planner_note", text: "They skipped the warehouse entirely.", beat_done: true }, { type: "narrate", text: "Noted." }], coplayers_may_act: false } : base(u));
  const { t, api } = await table({ llm, improv: IMPROV, heal: true, cfg: pcfg({ intervalMs: 10 * 3600000, minLines: 100000 }) });
  await planned(t, api);
  assert.equal(t.planner.arc.version, 1);
  t.cfg.planner.stallTurns = 3;
  for (let i = 0; i < 4; i++) { await alicePosts(t, api, `Still here ${i}.`); await settle(t); }
  await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.version, 2); assert.equal(t.planner.arc.trigger, "stall");
  await alicePosts(t, api, "I give up on the office."); await settle(t);
  assert.ok(api.posts.some((p) => p.visibility === "gm_only" && p.content === "Planner note: They skipped the warehouse entirely."));
  await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.trigger, "asked"); assert.equal(t.planner.arc.version, 3);
  const briefing = plannerCalls(llm).at(-3).messages[0].content;
  assert.ok(briefing.includes('"They skipped the warehouse entirely." (beat done)'), "the note, and that the beat is done, reached the planner");
});

test("the planner stays quiet when off, over budget, or with the interval at 0; plan now still works", async () => {
  const off = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  await off.t.command({ cmd: "plan", action: "off" });
  await planned(off.t, off.api);
  assert.equal(off.t.planner.arc, null); assert.equal(plannerCalls(off.llm).length, 0); assert.equal(off.t.storyPlanSection(), "");
  const budget = await table({ improv: IMPROV, heal: true, cfg: { ...pcfg(), dailyTokenBudget: 1 } });
  await alicePosts(budget.t, budget.api, "Hm."); await settle(budget.t);
  await planned(budget.t, budget.api);
  assert.equal(budget.t.planner.arc, null);
  await assert.rejects(budget.t.command({ cmd: "plan", action: "now" }), /budget/);
  const manual = await table({ improv: IMPROV, heal: true, cfg: pcfg({ intervalMs: 0 }) });
  await planned(manual.t, manual.api);
  assert.equal(manual.t.planner.arc.version, 1, "a first plan still happens");
  await planned(manual.t, manual.api, 50);
  assert.equal(manual.t.planner.arc.version, 1, "then nothing automatic");
  await manual.t.command({ cmd: "plan", action: "now" });
  assert.equal(manual.t.planner.arc.version, 2); assert.equal(manual.t.planner.arc.trigger, "manual");
});

// ---- sessions, the final review, the calendar, and what everyone knows about each other
test("nobody online: an away side turn never starts the planner, even when a plan is due", async () => {
  const { t, api, llm, clock } = await table({ improv: IMPROV, heal: true, cfg: { ...pcfg(), autonomyIdleMinutes: 30, awaySideIntervalMs: 6 * 3600000, autonomySideIntervalMs: MIN } });
  await planned(t, api);
  const calls = plannerCalls(llm).length;
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Lighthouse", span: "long" });
  await settle(t);
  t.planner.asked = { why: "the GM asked", at: clock.t };   // due, if anyone were here
  t.planner.session = null;
  clock.t += 7 * 3600000;
  const before = t.turns;
  assert.notEqual(await t.tick(), null); await settle(t); await t.memoryIdle(); await settle(t);
  assert.equal(t.turns, before + 1, "the side thread moved on its own");
  assert.equal(plannerCalls(llm).length, calls, "but the planner did not run");
  await alicePosts(t, api, "I'm back."); await settle(t); await t.memoryIdle(); await settle(t);
  assert.equal(plannerCalls(llm).length, calls + 3, "a player's line, and it runs");
});

test("the final review: when the players leave, one review moves the calendar on, acts off-screen and prepares the next session", async () => {
  const { t, api, llm, clock } = await table({ improv: IMPROV, casual: { on: true }, heal: true, cfg: { ...pcfg(), autonomyIdleMinutes: 30 } });
  await planned(t, api);                                   // ten player lines; the first plan sets the first date
  assert.deepEqual([t.calendar.date, t.calendar.time], ["1923-10-02", "early morning"]); assert.equal(t.calendar.log.at(-1).by, "planner");
  assert.equal(t.planner.session.lines, 10);
  const calls = plannerCalls(llm).length;
  clock.t += 29 * 60000;
  assert.equal(t.checkSessionEnd(), null, "not yet: the players may still be thinking");
  clock.t += 2 * 60000;
  const job = t.checkSessionEnd();
  assert.ok(job, "the session is over"); await job; await t.memoryIdle(); await settle(t);
  const review = plannerCalls(llm).slice(calls);
  assert.equal(review.length, 3, "draft, critique, revise");
  assert.match(review[0].system, /FINAL REVIEW/); assert.match(review[0].messages[0].content, /This is the FINAL REVIEW/);
  assert.match(review[0].messages[0].content, /The session that just ended: 10 player lines/);
  assert.match(review[1].messages.at(-1).content, /final review of a session/);
  assert.deepEqual([t.calendar.date, t.calendar.time], ["1923-10-04", "morning"]);
  assert.equal(t.calendar.log.at(-1).by, "final review");
  assert.deepEqual(api.declared.at(-1), { text: "[mock offscreen] The Guild doubled the night watch at the docks.", secret: true });
  const note = api.posts.find((p) => p.visibility === "gm_only" && p.content.startsWith("Final review of the session"));
  assert.ok(note, "a GM-only note");
  assert.match(note.content, /Calendar: 1923-10-02 \(Tuesday\), early morning → 1923-10-04 \(Thursday\), morning/); assert.match(note.content, /1 secret/); assert.match(note.content, /Next session opens: \[mock opening\]/);
  assert.equal(t.planner.session, null); assert.equal(t.planner.arc.trigger, "final");
  clock.t += 3600000;
  assert.equal(t.checkSessionEnd(), null, "once per session");
  // The next session opens from what the review prepared, once.
  await alicePosts(t, api, "Good morning, everyone."); await settle(t);
  const first = directorCalls(llm).find((u) => u.includes("Good morning, everyone.") && !/^MODE: /m.test(u));
  assert.match(first, /BETWEEN SESSIONS: this is the first turn of a new session\. Since the last one, 2 day\(s\) passed in the story \(now: 1923-10-04 \(Thursday\), morning\)/);
  assert.match(first, /\[mock offscreen\] The Guild doubled the night watch at the docks\. \[secret/); assert.match(first, /\[mock opening\] A knock at the door at dawn\./);
  assert.match(first, /Today in the story: 1923-10-04 \(Thursday\), morning/);
  assert.equal(t.planner.between, null);
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.match(cp, /TODAY IN THE STORY: 1923-10-04 \(Thursday\), morning/);
  assert.match(cp, /TIME HAS PASSED since you last spoke: 2 day\(s\)/);
  assert.ok(!cp.includes("[mock offscreen]") && !cp.includes("[mock opening]") && !cp.includes("[mock recap]"), "nothing of the review itself");
  await alicePosts(t, api, "Shall we?"); await settle(t);
  assert.doesNotMatch(directorCalls(llm).find((u) => u.includes("NEWEST LINE: Alice Hale: Shall we?")), /BETWEEN SESSIONS/);
});

test("a short session, or the final review turned off, ends without one; stopping run reviews the session first", async () => {
  const short = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  await alicePosts(short.t, short.api, "Just checking in."); await settle(short.t);
  short.clock.t += 31 * 60000;
  const before = plannerCalls(short.llm).length;
  assert.equal(short.t.checkSessionEnd(), null); assert.equal(short.t.planner.session, null, "closed without a review");
  await short.t.memoryIdle();
  assert.equal(plannerCalls(short.llm).length, before, "no final review");
  const off = await table({ improv: IMPROV, heal: true, cfg: pcfg({ finalReview: false, finalReviewMinLines: 1 }) });
  await alicePosts(off.t, off.api, "Hm."); await settle(off.t);
  off.clock.t += 31 * 60000;
  const offCalls = plannerCalls(off.llm).length;
  assert.equal(off.t.checkSessionEnd(), null); await off.t.memoryIdle();
  assert.equal(plannerCalls(off.llm).length, offCalls);
  const stop = await table({ improv: IMPROV, casual: { on: true }, heal: true, cfg: pcfg({ finalReviewMinLines: 2 }) });
  await alicePosts(stop.t, stop.api, "One."); await settle(stop.t);
  await alicePosts(stop.t, stop.api, "Two, and I have to go."); await settle(stop.t);
  assert.equal(await stop.t.finishSession(), true);
  assert.equal(stop.t.planner.arc.trigger, "final");
  assert.equal(stop.t.calendar.date, "1923-10-04", "the first date, then two days on");
  assert.equal(await stop.t.finishSession(), false, "nothing left to review");
});

test("the GM's date and bond actions; traits, gender and relationships, and who knows what about whom", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (u) => (u.includes("NEWEST LINE: Alice Hale: We rest for the night.") && !/^MODE: /m.test(u)
    ? { actions: [
      { type: "date", date: "1923-10-02", time: "night" }, { type: "date", advance_days: 1, time: "dawn", reason: "a night's rest" }, { type: "date", date: "1923-09-01" },
      { type: "bond", a: "Alice Hale", b: "Harriet Vance", kind: "lives with", note: "they share rooms" },
      { type: "bond", a: "Mr. Grimsby", b: "Lady Ashcombe", kind: "lovers", secret: true },
      { type: "bond", a: "Mr. Grimsby", b: "Harriet Vance", kind: "family", note: "her uncle", secret: true },
      { type: "bond", a: "Mr. Grimsby", b: "Alice Hale", kind: "rivals" },
      { type: "npc", name: "Mr. Grimsby", text: "Good night, miss." }, { type: "narrate", text: "Dawn comes grey." }], coplayers_may_act: true }
    : base(u));
  const lady = { id: "c-lady", name: "Lady Ashcombe", kind: "npc", user_id: null, bio: "LADY-BRIEF: owns the mill", role_card: { basic: { sex: "female", age: "40" }, characteristics: { APP: 90, INT: 85 } } };
  // No pace here (the next test has it): the GM sets the date and moves it on a day in one turn.
  const { t, api } = await table({ llm, casual: { on: true }, extraCharacters: [lady], cfg: { calendarMinMinutes: 0, calendarMinLines: 0 } });
  api.characters_[0].role_card.characteristics = { INT: 88, APP: 50 };
  api.characters_[0].role_card.basic.sex = "female";
  Object.assign(api.characters_[2].role_card, { basic: { sex: "male", age: "62" }, characteristics: { SIZ: 90 } });
  await alicePosts(t, api, "We rest for the night."); await settle(t);
  assert.deepEqual([t.calendar.date, t.calendar.time], ["1923-10-03", "dawn"], "set, moved on a day; the earlier date refused");
  assert.equal(t.bonds.length, 4);
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.match(cp, /TODAY IN THE STORY: 1923-10-03 \(Wednesday\), dawn/);
  assert.match(cp, /notable: extremely intelligent/, "she knows what is striking about Alice");
  assert.doesNotMatch(cp, /\b88\b/, "never the number");
  assert.match(cp, /PEOPLE YOU HAVE MET[^\n]*\n- Mr\. Grimsby \(male, 62; very large, imposing build\)/, "Grimsby spoke in her scene");
  assert.ok(!cp.includes("Lady Ashcombe"), "Lady Ashcombe she has never met, nor her secret affair");
  assert.ok(!cp.includes("knows where the key is") && !cp.includes("LADY-BRIEF"), "never the GM's brief");
  assert.match(cp, /Alice Hale — Harriet Vance \(you\): lives with \(they share rooms\)/);
  assert.match(cp, /Mr\. Grimsby — Harriet Vance \(you\): family \(her uncle\)/, "her own secret bond");
  assert.match(cp, /Mr\. Grimsby — Alice Hale: rivals/);
  await alicePosts(t, api, "Morning, Mr. Grimsby."); await settle(t);
  const gm = directorCalls(llm).find((u) => u.includes("NEWEST LINE: Alice Hale: Morning, Mr. Grimsby.") && !/^MODE: /m.test(u));
  assert.match(gm, /## Calendar[^\n]*\nToday in the story: 1923-10-03 \(Wednesday\), dawn/);
  assert.match(gm, /## Relationships[\s\S]*Mr\. Grimsby — Lady Ashcombe: lovers \[secret\]/);
  assert.match(gm, /- Lady Ashcombe \(female, 40; extremely good-looking, striking; extremely intelligent\): /, "the GM's cast");
  assert.match(gm, /- Mr\. Grimsby \(male, 62; very large, imposing build\): /);
  assert.match(gm, /- Alice Hale \(played by alice\)\n[^\n]*gender: female[\s\S]*notable: extremely intelligent/);
  assert.match(llm.calls.find((c) => c.purpose === "director").system, /"type": "date"[\s\S]*"type": "bond"/);
  // The operator's commands.
  await t.command({ cmd: "bond", a: "Alice Hale", b: "Mr. Grimsby", kind: "rivals", end: true });
  assert.equal(t.bonds.length, 3);
  await t.command({ cmd: "date", days: 2, time: "noon" });
  assert.deepEqual([t.calendar.date, t.calendar.time, t.calendar.log.at(-1).by], ["1923-10-05", "noon", "operator"]);
  await assert.rejects(t.command({ cmd: "date", date: "1900-01-01" }), /never runs backwards/);
  await assert.rejects(t.command({ cmd: "bond", a: "Nobody", b: "Alice Hale", kind: "friends" }), /no character named Nobody/);
});

test("the first date and the everyday routine come from the planner, from the world's own calendar; the GM and the co-players read them", async () => {
  const llm = new MockLlm();
  const baseDirector = llm.director.bind(llm);
  llm.director = (u) => (u.includes("NEWEST LINE: Alice Hale: What day is it?") && !/^MODE: /m.test(u) ? { actions: [{ type: "date", date: "1999-12-31", time: "noon" }, { type: "narrate", text: "Hard to say." }], coplayers_may_act: true } : baseDirector(u));
  const world = `${IMPROV.world}\n\n## The fishing year\nWORLD-CALENDAR: the herring run starts in October; the Harbour Fair is held on the first Saturday after the run begins.`;
  const { t, api } = await table({ llm, improv: { ...IMPROV, world }, casual: { on: true }, heal: true, cfg: pcfg() });
  await alicePosts(t, api, "What day is it?"); await settle(t);
  await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.trigger, "first", "no date: the first plan comes after the first line");
  assert.deepEqual([t.calendar.date, t.calendar.time], ["1923-10-02", "early morning"], "the planner's date and time of day, not the GM's");
  assert.equal(t.calendar.log.find((e) => e.to.includes("1923")).by, "planner");
  const draft = plannerCalls(llm)[0];
  assert.match(draft.system, /choosing the first one is your job/); assert.match(draft.system, /Routine: everyday life follows a calendar/);
  assert.ok(draft.messages[0].content.includes("WORLD-CALENDAR"), "the planner reads the world's own calendar");
  assert.match(draft.messages[0].content, /"routine": "what everyday life is busy with/);
  assert.match(t.calendar.routine.text, /\[mock routine\] The herring season/);
  await alicePosts(t, api, "Harriet, shall we go down to the market?"); await settle(t);
  const gm = directorCalls(llm).find((u) => u.includes("shall we go down to the market?") && !/^MODE: /m.test(u));
  assert.match(gm, /Today in the story: 1923-10-02 \(Tuesday\), early morning\nEveryday life now: \[mock routine\] The herring season[^\n]*Coming up: \[mock\] the Harbour Fair on the quay \(next Saturday\)\./);
  assert.match(llm.calls.find((c) => c.purpose === "director").system, /The story planner chooses the first date/);
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.match(cp, /TODAY IN THE STORY: 1923-10-02 \(Tuesday\), early morning/);
  assert.match(cp, /Everyday life now: \[mock routine\] The herring season.*\(common knowledge: everyone in the story knows it\)/);
  // A routine is common knowledge: one quoting a secret is dropped; the next date move marks it as dated.
  t.applyRoutine({ routine: "Everyone says the Guild master drowned the lighthouse keeper.", upcoming: [] });
  assert.match(t.calendar.routine.text, /herring season/, "kept the old one");
  t.moveCalendar({ days: 1, by: "operator" });
  assert.match(renderCalendarOf(t), /Everyday life now \(as of 1923-10-02 \(Tuesday\)\)/);
});

test("the GM's pace on the calendar: a day passes only after enough time and play, a few days at once at most", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  const turns = {
    "We sleep.": [{ type: "date", advance_days: 1, time: "dawn", reason: "a night's rest" }, { type: "narrate", text: "Night falls." }],
    "A week of research, then.": [{ type: "date", advance_days: 7, reason: "research" }, { type: "narrate", text: "The days pass in the library." }],
    "We take the train north.": [{ type: "advance_scenario", title: "The north", location: "Kingsport", narrative_time: "two days later", advance_days: 2, reason: "a journey" }],
    "Off to the docks.": [{ type: "advance_scenario", title: "The docks", location: "Harbour", narrative_time: "noon", reason: "same day" }],
  };
  llm.director = (u) => { const k = Object.keys(turns).find((x) => u.includes(`NEWEST LINE: Alice Hale: ${x}`)); return k && !/^MODE: /m.test(u) ? { actions: turns[k], coplayers_may_act: true } : base(u); };
  const { t, api, clock } = await table({ llm, casual: { on: true }, cfg: { calendarMinMinutes: 30, calendarMinLines: 3, calendarMaxDays: 2, scenarioMinMinutes: 0, scenarioMinLines: 0 } });
  await t.command({ cmd: "date", date: "1923-10-02", time: "evening" });   // the operator is not held to the pace
  assert.deepEqual(t.calendar.since, { at: clock.t, lines: 0 }, "the date moved: the pace starts again");
  assert.match(renderCalendarOf(t, t.calendarPaceCfg()), /Pace: the date moved on only recently and may not move on again yet\. Keep play within the current day: move only the time of day; later, at most 2 days at once\./);
  // Too soon: the date stays, and the GM reads why.
  await alicePosts(t, api, "We sleep."); await settle(t);
  assert.deepEqual([t.calendar.date, t.calendar.time], ["1923-10-02", "evening"]);
  const held = api.posts.find((p) => p.visibility === "gm_only" && p.content.startsWith("Calendar unchanged: the date moved on too recently"));
  assert.ok(held, "a GM-only note"); assert.match(held.content, /after 30 more min and 2 more player lines/);
  const gm = directorCalls(llm).at(-1);
  assert.match(gm, /Pace: the date moved on only recently and may not move on again yet/);
  assert.match(llm.calls.find((c) => c.purpose === "director").system, /Let the calendar move slowly/);
  // Chatter out of character does not count; play does.
  t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: t.primaryWindowId(), author_id: "u-alice", author_role: "player", character_id: "c-alice", kind: "ooc", content: "brb" }) }); await settle(t);
  assert.equal(t.calendar.since.lines, 1, "one line of play so far");
  clock.t += 31 * 60000;
  await alicePosts(t, api, "We sleep."); await settle(t);
  assert.equal(t.calendar.since.lines, 2);
  assert.equal(t.calendar.date, "1923-10-02", "enough time, not yet enough play");
  await alicePosts(t, api, "Still awake, reading."); await settle(t);
  assert.match(renderCalendarOf(t, t.calendarPaceCfg()), /Pace: the date may move on now, at most 2 days at once; play the day out rather than skip ahead\./);
  await alicePosts(t, api, "We sleep."); await settle(t);
  assert.deepEqual([t.calendar.date, t.calendar.time, t.calendar.log.at(-1).by], ["1923-10-03", "dawn", "keeper"], "a day passed");
  // A week asked: two days at most, and the GM is told.
  clock.t += 31 * 60000;
  for (const line of ["One.", "Two."]) { await alicePosts(t, api, line); await settle(t); }
  await alicePosts(t, api, "A week of research, then."); await settle(t);
  assert.equal(t.calendar.date, "1923-10-05", "two days, not seven");
  assert.ok(api.posts.some((p) => p.visibility === "gm_only" && /^Calendar moved on 2 day\(s\), not 7: at most 2 at once/.test(p.content)));
  // A scenario change that jumps ahead too soon is refused whole; one within the day goes through.
  await alicePosts(t, api, "We take the train north."); await settle(t);
  assert.ok(api.posts.some((p) => p.visibility === "gm_only" && /^Scenario change refused: the date moved on too recently to jump ahead again/.test(p.content)));
  assert.equal(t.calendar.date, "1923-10-05"); assert.notEqual(t.timelines.main().location, "Kingsport");
  await alicePosts(t, api, "Off to the docks."); await settle(t);
  assert.equal(t.timelines.main().location, "Harbour");
  // The operator and the final review are not held to it.
  await t.command({ cmd: "date", days: 5 });
  assert.equal(t.calendar.date, "1923-10-10");
});
import { renderCalendar as _renderCalendar } from "../src/calendar.mjs";
const renderCalendarOf = (t, pace = null) => _renderCalendar(t.calendar, { pace, now: t.now() });

test("a solemn game keeps no date: no calendar for anyone, no date action, and the final review moves no calendar", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (u) => (u.includes("NEWEST LINE: Alice Hale: We rest.") && !/^MODE: /m.test(u) ? { actions: [{ type: "date", date: "1923-10-02", advance_days: 1 }, { type: "narrate", text: "Night falls." }], coplayers_may_act: true } : base(u));
  const { t, api, clock } = await table({ llm, improv: IMPROV, heal: true, cfg: { ...pcfg(), autonomyIdleMinutes: 30 } });
  await alicePosts(t, api, "We rest."); await settle(t);
  await planned(t, api);
  assert.equal(t.planner.arc.trigger, "first"); assert.equal(t.calendar.date, "", "no date");
  const director = llm.calls.find((c) => c.purpose === "director");
  assert.doesNotMatch(director.system, /"type": "date"|advance_days|- Time:/);
  assert.ok(!director.messages[0].content.includes("## Calendar"));
  const draft = plannerCalls(llm)[0];
  assert.doesNotMatch(draft.system, /Time \(a casual game|Routine:/); assert.doesNotMatch(draft.messages[0].content, /"calendar": \{/);
  assert.ok(!llm.calls.filter((c) => c.purpose === "coplayer_turn").some((c) => c.messages[0].content.includes("TODAY IN THE STORY")));
  clock.t += 31 * 60000;
  await t.checkSessionEnd(); await t.memoryIdle(); await settle(t);
  const review = plannerCalls(llm).filter((c) => c.messages[0].content.includes("This is the FINAL REVIEW"));
  assert.equal(review.length, 3, "the final review still runs");
  assert.doesNotMatch(review[0].system, /advance_days/); assert.doesNotMatch(review[0].messages[0].content, /"advance_days"/);
  assert.equal(t.calendar.date, ""); assert.equal(t.calendar.log.length, 0);
  const note = api.posts.find((p) => p.content.startsWith("Final review of the session"));
  assert.doesNotMatch(note.content, /Calendar/); assert.match(note.content, /Off-screen: 1 development/);
  await alicePosts(t, api, "Back again."); await settle(t);
  const first = directorCalls(llm).find((u) => u.includes("NEWEST LINE: Alice Hale: Back again.") && !/^MODE: /m.test(u));
  assert.match(first, /BETWEEN SESSIONS: this is the first turn of a new session\. Meanwhile, off-screen:/);
  assert.doesNotMatch(first, /day\(s\) passed|what day and time/);
  await assert.rejects(t.command({ cmd: "date", days: 1 }), /only in a casual game/);
});

test("a plan made before the platform's first scenario is not redone when that scenario opens; a later change still is", async () => {
  const { t, api, llm } = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  t.scenario = null;
  await planned(t, api);
  assert.equal(t.planner.arc.version, 1); assert.equal(t.planner.scenarioId, null);
  t.onEvent({ stream: "chat", type: "scene.changed", channel_id: "ch", scene: { id: "sc1", status: "active" } });
  await alicePosts(t, api, "Onward."); await settle(t); await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.version, 1, "the first scenario is no change");
  t.onEvent({ stream: "chat", type: "scene.changed", channel_id: "ch", scene: { id: "sc2", status: "active" } });
  await alicePosts(t, api, "Onward again."); await settle(t); await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.version, 2); assert.equal(t.planner.arc.trigger, "scenario");
  assert.ok(plannerCalls(llm).length === 6);
});

test("turning casual mode on mid-campaign asks the planner for the story's first date", async () => {
  const { t, api } = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  await planned(t, api);
  assert.equal(t.planner.arc.calendar, null, "a solemn game's plan carries no calendar");
  assert.doesNotMatch(t.storyPlanSection(), /Calendar:/);
  await t.command({ cmd: "casual", on: true });
  await alicePosts(t, api, "Let's take it easy for a while."); await settle(t); await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.trigger, "asked");
  assert.deepEqual([t.calendar.date, t.calendar.time], ["1923-10-02", "early morning"]);
});

// ---- the table's own windows: the phone log, the planner window, new players
const COPLAYER2 = { id: "c-tomas", name: "Tomas Leclerc", kind: "pc", user_id: "u-bot", player_name: "AI GM", bio: "A journalist.", role_card: {} };
const logLines = (t, api) => api.posts.filter((p) => p.window === t.casual.log && p.kind === "ic");

test("casual: texts between co-players and NPCs go to the GM's phone log, answered in their own time, and stop before they run away", async () => {
  const llm = new MockLlm();
  const baseCp = llm.coplayer.bind(llm);
  // Harriet texts Tomas when Alice asks her to; Tomas and Harriet then answer each other through their own models.
  llm.coplayer = (u) => (u.startsWith("YOU ARE: Harriet Vance") && u.includes("NEWEST LINE: #") && u.includes("Text Tomas") ? { action: "text", to: "Tomas Leclerc", text: "Meet me at the pier at nine." } : baseCp(u));
  const { t, api, clock } = await isolated({ llm, extraCharacters: [COPLAYER2], cfg: { casualAiChain: 3 } });
  const phonesBefore = api.posts.filter((p) => Object.values(t.casual.phones).includes(p.window) && p.kind === "ic").length;
  await alicePosts(t, api, "Harriet, please. Text Tomas."); await settle(t);
  assert.deepEqual(logLines(t, api).map((p) => [p.content, p.character_id]), [["→ Tomas Leclerc: Meet me at the pier at nine.", "c-harriet"]], "in the log, as Harriet");
  await settle(t);
  const cpPhone = llm.calls.filter((c) => c.purpose === "coplayer_phone");
  assert.equal(cpPhone.length, 1, "Tomas reads it"); assert.match(cpPhone[0].system, /You play Tomas Leclerc/);
  clock.t += 6 * MIN; await t.deliverDue(); await settle(t);
  assert.equal(logLines(t, api).at(-1).character_id, "c-tomas"); assert.match(logLines(t, api).at(-1).content, /^→ Harriet Vance: \[mock Tomas Leclerc\] On my way\./);
  clock.t += 6 * MIN; await t.deliverDue(); await settle(t);
  clock.t += 6 * MIN; await t.deliverDue(); await settle(t);
  assert.equal(logLines(t, api).length, 3, "three texts, then the exchange rests (casual.ai_chain 3)");
  clock.t += 60 * MIN; await t.deliverDue(); await settle(t);
  assert.equal(logLines(t, api).length, 3);
  assert.equal(api.posts.filter((p) => Object.values(t.casual.phones).includes(p.window) && p.kind === "ic").length, phonesBefore, "no player's phone saw any of it");
  assert.deepEqual(t.store.phoneOf("c-tomas").map((r) => r.from), ["c-harriet", "c-tomas", "c-harriet"], "both remember the thread");
  // An NPC answers a co-player through the GM, in the log.
  const base = llm.director.bind(llm);
  llm.director = (u) => (/^MODE: phone — Harriet Vance texted Mr\. Grimsby/m.test(u) ? { actions: [{ type: "text", from: "Mr. Grimsby", to: "Harriet Vance", text: "The key is not mine to give.", delay_minutes: 0 }], coplayers_may_act: false } : base(u));
  llm.coplayer = (u) => (u.startsWith("YOU ARE: Harriet Vance") && u.includes("Ask Grimsby") ? { action: "text", to: "Mr. Grimsby", text: "Where is the key?" } : baseCp(u));
  await alicePosts(t, api, "Harriet? Ask Grimsby by text."); await settle(t); await settle(t);
  assert.ok(logLines(t, api).some((p) => p.content === "→ Mr. Grimsby: Where is the key?" && p.character_id === "c-harriet"));
  assert.ok(logLines(t, api).some((p) => p.content === "→ Harriet Vance: The key is not mine to give." && p.character_id === "c-butler"), "Grimsby's answer, through the GM");
  const phoneTurn = directorCalls(llm).find((u) => /^MODE: phone — Harriet Vance texted Mr\. Grimsby/m.test(u));
  assert.match(phoneTurn, /## Chat in "Phone log \(GM only\)"[\s\S]*Where is the key\?/, "the GM reads the log when answering");
  await alicePosts(t, api, "Anything new?"); await settle(t);
  assert.match(directorCalls(llm).find((u) => u.includes("NEWEST LINE: Alice Hale: Anything new?")), /## Recent lines in "Phone log \(GM only\)"[\s\S]*The key is not mine to give\./, "and in every other turn");
  // Nobody at the table: a text still arrives, but no one answers it.
  const answers = llm.calls.filter((c) => c.purpose === "coplayer_phone").length;
  t.aiText("c-butler", "c-tomas", "Stay away from the pier.");
  clock.t += 3 * 3600000; await t.deliverDue(); await settle(t);
  assert.ok(logLines(t, api).some((p) => p.content === "→ Tomas Leclerc: Stay away from the pier."));
  assert.equal(llm.calls.filter((c) => c.purpose === "coplayer_phone").length, answers, "everyone is away: no answer");
  assert.equal(await t.tick(), null, "the log never gets a turn");
});

test("the planner window: every player sits in it; wishes and corrections reach the planner, the GM and (corrections only) the co-players", async () => {
  const { t, api, llm } = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  const w = api.createdWindows.find((x) => x.id === t.planner.window);
  assert.equal(w.name, "To the story planner"); assert.deepEqual(w.members.map((m) => m.user_id), ["u-bot", "u-alice"]);
  assert.ok(api.posts.some((p) => p.window === w.id && p.kind === "ooc" && p.content.startsWith("🧭 This window is for the story planner")));
  const turns = t.turns;
  const say = (content) => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: w.id, author_id: "u-alice", author_name: "alice", author_role: "player", character_id: "c-alice", content }) });
  say("Harriet would never leave a friend behind.");
  say("I'd love a slow-burn rivalry with the harbour master.");
  await settle(t);
  assert.equal(t.turns, turns, "no turn is played there"); assert.equal(t.planner.session, null, "and it is no play");
  await t.memoryIdle();
  assert.equal(plannerCalls(llm).length, 0, "no run of its own: the planner keeps its routine");
  assert.equal(t.planner.inbox.length, 2, "the lines wait for the next run");
  await planned(t, api);   // the planner's usual first plan comes after ten lines of play
  assert.equal(t.planner.arc.trigger, "first");
  const draft = plannerCalls(llm)[0];
  assert.match(draft.system, /The players can write to you/);
  assert.match(draft.messages[0].content, /## The players' words to you[^\n]*\n- alice: Harriet would never leave a friend behind\.\n- alice: I'd love a slow-burn rivalry/);
  assert.deepEqual(t.planner.table.map((n) => [n.id, n.kind, n.about]), [["N1", "correction", ["Harriet Vance"]], ["N2", "wish", []]]);
  assert.equal(t.planner.inbox.length, 0, "read");
  const reply = api.posts.filter((p) => p.window === w.id && p.kind === "ooc").at(-1);
  assert.equal(reply.content, "🧭 [mock reply] Noted 2 line(s): the story will follow.");
  await alicePosts(t, api, "Harriet, the clock?"); await settle(t);
  const gm = directorCalls(llm).at(-2);
  assert.match(gm, /## The players' wishes and corrections[\s\S]*Corrections:[^\n]*\n- N1: \[mock note\] Harriet would never leave a friend behind\. \(about Harriet Vance\)[\s\S]*Wishes:[^\n]*\n- N2: \[mock note\] I'd love a slow-burn rivalry/);
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.match(cp, /TABLE CORRECTIONS[^\n]*\n- \[mock note\] Harriet would never leave a friend behind\./);
  assert.ok(!cp.includes("slow-burn rivalry"), "a wish is the planner's to weave in, never a co-player's to play to");
  // The next words refine the notes; the standing ones are shown to the planner by id.
  say("Actually, no rivalry after all.");
  await t.command({ cmd: "plan", action: "now" }); await settle(t);
  assert.match(plannerCalls(llm).at(-3).messages[0].content, /## Standing table notes[^\n]*\n- N1 \[correction\][\s\S]*- N2 \[wish\]/);
});

test("a new player is seated in the planner window, gets a phone in casual mode, and the GM brings their character in", async () => {
  const { t, api, llm } = await isolated({ cfg: pcfg() });
  await t.ensureTableWindows();
  assert.ok(t.planner.window && t.casual.log, "planner window and phone log");
  const before = Object.keys(t.casual.phones).length;
  api.channelUsers.push("u-cara");
  api.characters_.push({ id: "c-cara", name: "Cara Lind", kind: "pc", user_id: "u-cara", player_name: "cara", role_card: { basic: { sex: "female" } } });
  api.windows_[0].members.push({ user_id: "u-cara", character_id: "c-cara", character_name: "Cara Lind" });
  t.onEvent({ stream: "chat", type: "window.changed", channel_id: "ch", window: { id: "w-main" } });
  await settle(t); await t.ensureTableWindows(); await settle(t);
  assert.ok(api.addedMembers.some((m) => m.window === t.planner.window && m.user_id === "u-cara"), "seated in the planner window");
  assert.equal(Object.keys(t.casual.phones).length, before + 1); assert.ok(t.casual.phones["c-cara"], "her phone");
  assert.equal(api.createdWindows.find((w) => w.id === t.casual.phones["c-cara"]).name, "Phone: Cara Lind");
  const welcome = directorCalls(llm).find((u) => u.includes("a new player just joined the table with Cara Lind"));
  assert.ok(welcome, "the GM brings her in"); assert.match(welcome, /Bring this character into the story here, naturally/);
  assert.ok(t.timelines.main().members.includes("c-cara"));
  await t.refresh(); await settle(t);
  assert.equal(directorCalls(llm).filter((u) => u.includes("a new player just joined the table")).length, 1, "welcomed once");
});

test("a newcomer joins the private primary scene before its welcome is posted", async () => {
  const { t, api } = await table({ bob: true });
  await t.command({ cmd: "split", who: ["Alice Hale"], place: "Docks" });
  await settle(t);
  const scene = t.primaryWindowId();
  assert.notEqual(scene, "w-main");
  api.channelUsers.push("u-cara");
  api.characters_.push({ id: "c-cara", name: "Cara Lind", kind: "pc", user_id: "u-cara" });
  const post = api.postMessage.bind(api);
  api.postMessage = async (ch, w, body) => {
    if (w === scene && body.content.includes("Cara")) assert.ok(api.windows_.find(x => x.id === scene).members.some(m => m.user_id === "u-cara"));
    return post(ch, w, body);
  };
  await t.refresh(); await settle(t);
  assert.ok(api.addedMembers.some(m => m.window === scene && m.user_id === "u-cara"));
  assert.equal(t.timelines.of("c-cara").id, "main");
});

test("recall recovers compacted evidence with source labels; co-players never search GM/private records", async () => {
  const { t, api, llm } = await table();
  const put = (content, over = {}) => {
    const m = api.add({ chat_window_id: "w-main", author_role: "gm", kind: "narration", content, ...over });
    t.history.add(m); return m;
  };
  put("The amber lantern was left in the attic. PUBLIC-DETAIL");
  put("The amber lantern powers a ritual. HIDDEN-DETAIL", { visibility: "gm_only" });
  put("The amber lantern belongs to your family. PRIVATE-DETAIL", { visibility: "whisper", whisper_to: ["c-alice"] });
  const old = put("The amber lantern is seen elsewhere. ELSEWHERE-DETAIL", { chat_window_id: "w-priv" });
  t.store.addChapter({ scope: "gm", windowId: "w-main", fromSeq: 1, toSeq: old.seq, text: "Earlier investigation." });
  t.store.addChapter({ scope: "gm", windowId: "w-priv", fromSeq: 1, toSeq: old.seq, text: "Earlier side scene." });
  const cp = t.roster.coplayers[0];
  t.store.addChapter({ scope: `coplayer:${cp.characterId}`, fromSeq: 1, toSeq: old.seq, text: "We investigated." });
  put("Where did we leave the amber lantern?", { author_role: "player", character_id: "c-alice" });
  const before = llm.calls.length;
  const ctx = await t.buildGm("w-main");
  assert.equal(llm.calls.length, before, "searching history/documents does not call the model");
  assert.match(ctx.parts.at(-1).text, /Relevant earlier records/);
  assert.match(ctx.parts.at(-1).text, /PUBLIC-DETAIL/);
  assert.match(ctx.parts.at(-1).text, /GM only.*HIDDEN-DETAIL/);
  assert.match(ctx.parts.at(-1).text, /Window: Alice alone.*ELSEWHERE-DETAIL/);
  await t.coplayerAct("w-main", cp, true);
  const prompt = llm.calls.findLast((c) => c.purpose === "coplayer_turn").messages[0].content;
  assert.match(prompt, /RELEVANT EARLIER LINES YOU WITNESSED/);
  assert.match(prompt, /PUBLIC-DETAIL/);
  for (const forbidden of ["HIDDEN-DETAIL", "PRIVATE-DETAIL", "ELSEWHERE-DETAIL", ...SECRETS]) assert.ok(!prompt.includes(forbidden), forbidden);
  assert.equal(llm.calls.length, before + 1, "only the co-player's normal response call was added");
});

test("GM prompt cache preserves completed history blocks when a new chunk arrives", async () => {
  const { t, api } = await table();
  while (api.lines.filter((m) => m.chat_window_id === "w-main").length < 50) {
    const m = api.add({ chat_window_id: "w-main", author_role: "player", content: "We continue our investigation." }); t.history.add(m);
  }
  const first = await t.buildGm("w-main");
  for (let i = 0; i < 50; i++) {
    const m = api.add({ chat_window_id: "w-main", author_role: "player", content: "We read another page." }); t.history.add(m);
  }
  const second = await t.buildGm("w-main");
  assert.equal(first.parts[0].text, second.parts[0].text);
  assert.equal(first.parts[1].text, second.parts[1].text, "first 50-line provider block remains identical");
  assert.equal(second.parts.filter((p) => p.cache).length, 3);
  assert.equal(second.parts.at(-2).cacheTtl, "5m");
});

test("a split follows individual declarations, even when the director assigns all three companions to the darkroom", async () => {
  const llm = new MockLlm();
  const cast = ["江念", "谢遥", "周见微"].map((name, i) => ({ id: "c-new" + i, name, kind: "pc", user_id: "u-bot", role_card: {} }));
  const { t, api } = await table({ llm, extraCharacters: cast });
  t.deferArrivals = true;
  for (const [i, content] of ["我陪你们去找沈学姐。", "吃过饭我去暗房，见微你来吗？", "我跟你去暗房。"].entries()) {
    await t.post("w-main", { kind: "ic", character_id: cast[i].id, content });
  }
  await t.post("w-main", { kind: "ic", character_id: cast[0].id, content: "把帖子收好。" });
  llm.director = u => u.includes("Verified departures") ? { actions: [{ type: "narrate", text: "江念陪你去找学姐。" }], coplayers_may_act: false } : {
    actions: [{ type: "narrate", text: "错误分组的草稿" }], coplayers_may_act: false,
    whereabouts: [{ who: cast.map(c => c.name), thread: "new", place: "暗房", opening: "错误分组的草稿", own_scene: true }],
  };
  llm.movements = ({ actors, lines, destinations }) => {
    assert.equal(destinations[0].place, "暗房");
    const commitment = lines.find(l => l.text.includes("去找沈学姐"));
    assert.ok(actors.find(a => a.id === cast[0].id).sources.includes(commitment.seq));
    const last = lines.find(l => l.text === "我跟你去暗房。").seq;
    return { moves: [
      // Even a hallucinated jump citing Zhou's "I'll go with you" cannot move Jiang.
      { id: cast[0].id, destination: destinations[0].key, seq: last },
      { id: cast[1].id, destination: destinations[0].key, seq: lines.find(l => l.text.includes("见微你来吗")).seq },
      { id: cast[2].id, destination: destinations[0].key, seq: last },
    ] };
  };
  await alicePosts(t, api, "我们分头走吧。");
  assert.equal(t.timelines.of(cast[0].id).id, "main");
  const side = t.timelines.of(cast[1].id);
  assert.equal(side.location, "暗房");
  assert.deepEqual(side.members.sort(), [cast[1].id, cast[2].id]);
  assert.ok(!api.posts.some(p => p.content.includes("错误分组的草稿")));
});

test("a player's correction in chat or the planner window restores the real seat before play, despite a fresh move", async () => {
  for (const source of ["w-main", "w-planner"]) {
    const { t, api, llm } = await table({ bob: true });
    t.deferArrivals = true;
    t.planner.window = "w-planner";
    await t.command({ cmd: "split", who: ["Harriet Vance", "Bob Price"], place: "Darkroom" });
    const side = t.timelines.of("c-harriet");
    assert.equal(side.location, "Darkroom");
    const priv = await api.postMessage("ch", side.windowId, { content: "SIDE ONLY", kind: "narration", visibility: "window" });
    t.noteLine(priv);
    llm.placementCorrection = ({ actors, lines, correction }) => {
      assert.equal(lines.at(-1).text, "江念不是刚说要陪我们找学姐的吗？");
      assert.ok(!actors.some(a => a.id === "c-bob"), "someone else's PC is outside this player's authority");
      return { moves: [{ id: "c-harriet", destination: "T0", seq: correction }, { id: "c-bob", destination: "T0", seq: correction }] };
    };
    llm.director = () => {
      assert.equal(t.timelines.of("c-harriet").id, "main", "correct before GM answers");
      return { actions: [], coplayers_may_act: false };
    };
    const m = api.add({ chat_window_id: source, author_id: "u-alice", author_role: "player", kind: "ooc", content: "江念不是刚说要陪我们找学姐的吗？" });
    await t.onMessage(m);
    const cp = t.roster.coplayerByName("Harriet Vance");
    assert.deepEqual(cp.seats.filter(s => s.toSeq === null).map(s => s.windowId), [t.primaryWindowId()]);
    assert.ok(cp.seats.at(-1).fromSeq > m.seq, "new seat does not expose old lines in a reused window");
    assert.equal(t.timelines.of("c-bob").id, side.id);
    assert.equal(t.guard.rec("c-harriet").correctionSeq, m.seq);
    assert.ok(!api.posts.some(p => p.window === "w-main" && p.content.includes("SIDE ONLY")));
    const before = t.timelines.log.length;
    await t.onMessage(m);
    assert.equal(t.timelines.log.length, before, "duplicate correction cannot move anyone twice");
  }
});

test("time skip posts confirmed lunch and a still-planned dinner before reopening the scene; other rooms and GM notes cannot supply evidence", async () => {
  const { t, api, llm } = await table({ cfg: { language: "zh" } });
  const add = (w, content, visibility = "window") => t.noteLine(api.add({ chat_window_id: w, author_id: "u-bot", kind: "narration", visibility, content }));
  add("w-main", "苏婉和唐小满中午吃完了牛肉面。");
  add("w-main", "苏婉说等试唱结束再去吃晚饭。");
  add("w-priv", "谢遥和周见微已经吃过盖饭。");
  add("w-main", "私下安排大家晚饭后去暗房。", "gm_only");
  llm.handoff = ({ lines }) => {
    assert.ok(!lines.some(l => /盖饭|私下安排/.test(l.text)));
    const lunch = lines.find(l => l.text.includes("牛肉面")), dinner = lines.find(l => l.text.includes("再去吃晚饭"));
    return { summary: "苏婉和唐小满中午吃过牛肉面了，晚饭还打算等试唱结束再去吃。", source_seqs: [lunch.seq, dinner.seq] };
  };
  llm.director = () => ({ actions: [{ type: "time_skip", time: "周三 17:30" }, { type: "narrate", text: "礼堂的门开了。" }], coplayers_may_act: false });
  await alicePosts(t, api, "跳到试唱吧。");
  const recap = api.posts.find(p => p.content.includes("时间转场"));
  assert.equal(recap.window, "w-main"); assert.equal(recap.visibility, "window");
  assert.match(recap.content, /中午吃过牛肉面了/);
  assert.match(recap.content, /晚饭还打算等试唱结束再去吃/);
  assert.doesNotMatch(recap.content, /吃完了晚饭|盖饭|私下安排/);
  assert.ok(!("reference_ids" in recap));
  assert.equal(recap.content.split("\n").length, 2, "time followed by one short paragraph, without a quote list");
  assert.equal(api.posts.at(-1).content, "礼堂的门开了。");
  await alicePosts(t, api, "继续。");
  assert.equal(api.posts.filter(p => p.content.includes("时间转场")).length, 1);
});

test("an explicit placement correction can restore a missing side thread without inventing a new departure", async () => {
  const { t, api, llm } = await table();
  llm.placementCorrection = ({ correction }) => ({ moves: [{ id: "c-harriet", destination: "NEW", place: "学生会办公室", seq: correction }] });
  llm.director = () => ({ actions: [], coplayers_may_act: false });
  await t.onMessage(api.add({ chat_window_id: "w-main", author_id: "u-alice", kind: "ooc", content: "分组错了，Harriet 刚才就留在学生会办公室。" }));
  const side = t.timelines.of("c-harriet");
  assert.equal(side.location, "学生会办公室");
  assert.equal(side.opened, true);
  assert.ok(api.posts.some(p => p.window === side.windowId && p.content.includes("Placement corrected")));
  assert.ok(!directorCalls(llm).some(u => u.includes("MODE: arrival")));
});

test("separate arrivals at room 507 reunite before the next response despite stale thread labels and a fresh split", async () => {
  const { t, api, llm } = await table({ extraCharacters: [{ id: "c-jiang", name: "江念", kind: "pc", user_id: "u-bot", role_card: {} }] });
  t.deferArrivals = true;
  t.timelines.main().location = "教室";
  await t.command({ cmd: "split", who: ["Harriet Vance", "江念"], place: "七号楼一楼门厅" });
  const side = t.timelines.of("c-harriet");
  await t.post(side.windowId, { kind: "ic", character_id: "c-harriet", content: "记着呢，明天吃完饭再去领钥匙。晚安，我也回507洗漱了。" });
  const arrival = await api.postMessage("ch", side.windowId, { kind: "narration", visibility: "window", content: "Harriet上到五楼，回到507。江念各自回寝。SIDE-PUBLIC-DETAIL" }); t.noteLine(arrival);
  const home = await api.postMessage("ch", t.primaryWindowId(), { kind: "narration", visibility: "window", content: "你回到507，今晚的奔忙到这里结束。" }); t.noteLine(home);
  t.noteLine(api.add({ chat_window_id: side.windowId, kind: "narration", author_role: "gm", visibility: "gm_only", content: "HIDDEN-PRESENCE-DETAIL" }));
  t.noteLine(api.add({ chat_window_id: side.windowId, kind: "ic", character_id: "c-jiang", visibility: "whisper", content: "WHISPER-PRESENCE-DETAIL" }));
  llm.presence = ({ threads }) => {
    assert.ok(!JSON.stringify(threads).includes("HIDDEN-PRESENCE-DETAIL"));
    assert.ok(!JSON.stringify(threads).includes("WHISPER-PRESENCE-DETAIL"));
    const source = threads.find(th => th.members.some(m => m.id === "c-harriet"));
    if (source.key === "T0") return { placements: [] };
    assert.equal(source.location, "七号楼一楼门厅", "an obsolete label must not hide a published arrival");
    return { placements: [{ id: "c-harriet", thread: "T0", with: "c-alice", actor_seq: arrival.seq, target_seq: home.seq, place: "507" }] };
  };
  llm.director = () => {
    assert.equal(t.timelines.of("c-harriet").id, "main", "membership is corrected before the GM responds");
    return { actions: [], coplayers_may_act: true };
  };
  await alicePosts(t, api, "晚安。");
  assert.equal(t.timelines.of("c-harriet").id, "main");
  assert.equal(t.timelines.main().location, "507");
  assert.equal(t.timelines.of("c-jiang").id, side.id, "same building does not mean everyone is in 507");
  const cp = t.roster.coplayerByName("Harriet Vance");
  assert.deepEqual(cp.seats.filter(s => s.toSeq === null).map(s => s.windowId), [t.primaryWindowId()]);
  const context = llm.calls.findLast(c => c.purpose === "coplayer_turn" && c.messages[0].content.startsWith("YOU ARE: Harriet"));
  assert.match(context.messages[0].content.split("WITH YOU HERE")[1], /Alice Hale/);
  assert.ok(!api.posts.some(p => p.window === "w-main" && p.content.includes("SIDE-PUBLIC-DETAIL")), "comparison never copies another scene's history into chat");
  assert.ok(!directorCalls(llm).some(u => u.includes("MODE: arrival")), "bookkeeping does not narrate a second arrival");
  const log = t.timelines.log.length;
  await t.reconcilePresence("w-main", t.guard.turn);
  assert.equal(t.timelines.log.length, log, "already-synchronised membership is not applied again");
});

test("an arrival published this round reconciles even after a rejected movement proposal; a future return does not", async () => {
  const { t, api, llm } = await table();
  t.deferArrivals = true;
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "七号楼一楼门厅" });
  const side = t.timelines.of("c-harriet");
  const source = await api.postMessage("ch", side.windowId, { kind: "narration", visibility: "window", content: "Harriet回到507，收好了相机。" }); t.noteLine(source);
  let arrived = false;
  llm.presence = ({ threads }) => {
    const main = threads.find(th => th.key === "T0"), there = threads.find(th => th.key !== "T0");
    const target = main.lines.findLast(l => l.text === "你回到507，放下书包。");
    return { placements: target && there ? [{ id: "c-harriet", thread: "T0", with: "c-alice", actor_seq: source.seq, target_seq: target.seq, place: "507" }] : [] };
  };
  llm.movements = () => ({ moves: [] }); // Reproduce the strict movement reader's rejection from the reported log.
  llm.director = () => ({ actions: [{ type: "narrate", text: arrived ? "你回到507，放下书包。" : "你还在洗漱间，打算洗完回507。" }],
    coplayers_may_act: false, whereabouts: arrived ? [{ who: ["Alice Hale"], thread: "T" + side.handle }] : [] });
  await alicePosts(t, api, "我还在洗漱，洗完就回去。");
  assert.equal(t.timelines.of("c-harriet").id, side.id);
  arrived = true;
  await alicePosts(t, api, "（回507放下书包）");
  assert.equal(t.timelines.of("c-harriet").id, "main");
  assert.equal(side.status, "merged");
  assert.equal(t.timelines.main().location, "507");
  assert.ok(llm.calls.some(c => c.purpose === "movement_evidence"));
});

test("presence analysis ignores asynchronous GM audit notes, and records the shared scene for a human reunion", async () => {
  const { t, api, llm } = await table();
  t.deferArrivals = true;
  const side = t.timelines.split({ name: "Lobby", location: "Lobby", members: ["c-alice"], windowId: "w-priv", fromSeq: t.lastSeq + 1 });
  const from = await api.postMessage("ch", side.windowId, { kind: "narration", visibility: "window", content: "Alice arrives at room 507." }); t.noteLine(from);
  const target = await api.postMessage("ch", "w-main", { kind: "narration", visibility: "window", content: "Harriet arrives at room 507." }); t.noteLine(target);
  llm.presence = () => {
    t.noteLine(api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", visibility: "gm_only", content: "Whereabouts not applied: a stale movement proposal" }));
    return { placements: [{ id: "c-alice", thread: "T0", with: "c-harriet", actor_seq: from.seq, target_seq: target.seq, place: "507" }] };
  };
  llm.director = () => ({ actions: [], coplayers_may_act: false });
  await alicePosts(t, api, "We are here. What can I see?", side.windowId);
  await settle(t);
  assert.equal(t.timelines.of("c-alice").id, "main");
  assert.equal(t.timelines.main().location, "507");
  assert.ok(directorCalls(llm).some(u => u.includes("MODE: relay") && u.includes("What can I see?")), "the triggering question is answered in the shared scene");
});

test("a newer departure during presence analysis invalidates the proposed reunion", async () => {
  const { t, api, llm } = await table();
  t.deferArrivals = true;
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Lobby" });
  const side = t.timelines.of("c-harriet");
  const from = await api.postMessage("ch", side.windowId, { kind: "narration", visibility: "window", content: "Harriet arrives at room 507." }); t.noteLine(from);
  const target = await api.postMessage("ch", "w-main", { kind: "narration", visibility: "window", content: "Alice arrives at room 507." }); t.noteLine(target);
  llm.presence = () => {
    t.noteLine(api.add({ chat_window_id: "w-main", author_id: "u-alice", character_id: "c-alice", content: "I leave for the library." }));
    return { placements: [{ id: "c-harriet", thread: "T0", with: "c-alice", actor_seq: from.seq, target_seq: target.seq, place: "507" }] };
  };
  await t.reconcilePresence("w-main", t.guard.turn);
  assert.equal(t.timelines.of("c-harriet").id, side.id);
});

test("planner /pause cancels queued turns; scheduled phone texts still arrive exactly once without replies", async () => {
  const { t, api, llm, clock } = await isolated({ cfg: pcfg() });
  const initialCalls = llm.calls.length;
  const initialInbox = [...t.planner.inbox];
  const queued = t.schedule("w-main", { delay: 60000 });
  t.queueText({ windowId: phoneOf(t, "c-alice"), from: "c-harriet", to: "c-alice", text: "The train is here.", minutes: 1 });
  t.queueText({ windowId: t.casual.log, from: "c-butler", to: "c-harriet", text: "Meet me by the train.", minutes: 1 });

  await playerSays(t, api, "/pause", t.planner.window);
  await queued;
  assert.equal(t.pending, 0);
  assert.equal(t.generation.paused, true);
  assert.deepEqual(t.planner.inbox, initialInbox);
  assert.equal(t.maybePlan(), null);
  assert.equal(t.checkSessionEnd(), null);
  await assert.rejects(t.planCommand("now"), /paused/);
  await playerSays(t, api, "/pause", t.planner.window);
  t.onMessage(api.add({ chat_window_id: "w-main", author_id: "u-alice", author_role: "player", kind: "roll", content: "1d6" }));
  t.onMessage(api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", content: "Automated post" }));
  assert.equal(t.generation.paused, true);

  clock.t += 2 * MIN;
  assert.equal(await t.deliverDue(), 2);
  assert.equal(await t.deliverDue(), 0);
  assert.equal(await t.tick(), null);
  await t.queue;
  assert.equal(texts(t, api, "c-alice").filter(p => p.content === "The train is here.").length, 1);
  assert.equal(logLines(t, api).filter(p => p.content.endsWith("Meet me by the train.")).length, 1);
  assert.equal(llm.calls.length, initialCalls);
  assert.equal(t.casual.pending.length, 0);

  // A second human player's new private message resumes hosting and is handled in its own window.
  await textFrom(t, api, "c-bob", "@Harriet Vance Ready now?");
  assert.equal(t.generation.paused, false);
  assert.equal(llm.calls.filter(c => c.purpose === "coplayer_phone").length, 1);
});

test("a paused director cannot post a late response after the player resumes", { timeout: 3000 }, async () => {
  const llm = new MockLlm();
  const complete = llm.complete.bind(llm);
  const began = Promise.withResolvers(), finish = Promise.withResolvers();
  let signal;
  llm.complete = async req => {
    if (req.purpose === "director" && !signal) {
      signal = req.signal;
      began.resolve();
      await finish.promise;
      return JSON.stringify({ actions: [{ type: "narrate", text: "Stale narration" }] });
    }
    return complete(req);
  };
  const { t, api } = await table({ llm, improv: IMPROV, heal: true, cfg: pcfg() });
  const oldTurn = playerSays(t, api, "I wait.");
  await began.promise;
  const queued = t.schedule("w-priv", { delay: 0 });
  await new Promise(resolve => setTimeout(resolve, 5));
  await playerSays(t, api, "/pause", t.planner.window);
  assert.equal(signal.aborted, true);
  const newTurn = playerSays(t, api, "I open the drawer.");
  finish.resolve();
  await Promise.all([oldTurn, queued, newTurn]);
  assert.equal(t.generation.paused, false);
  assert.equal(api.posts.filter(p => p.content === "Stale narration" || p.window === "w-priv").length, 0);
  assert.ok(directorCalls(llm).some(user => user.includes("I open the drawer.")));
  assert.equal(t.pending, 0);
});

test("pausing an in-flight planner keeps unread wishes across restart and ignores old deliveries", { timeout: 3000 }, async () => {
  const llm = new MockLlm();
  const complete = llm.complete.bind(llm);
  const began = Promise.withResolvers(), finish = Promise.withResolvers();
  let signal;
  llm.complete = async req => {
    if (req.purpose === "planner" && !signal) {
      signal = req.signal;
      began.resolve();
      await finish.promise;
    }
    return complete(req);
  };
  const { t, api } = await table({ llm, improv: IMPROV, heal: true, cfg: pcfg() });
  await playerSays(t, api, "Let us revisit the docks.", t.planner.window);
  const old = api.lines.at(-1);
  const planner = t.runPlanner("manual");
  await began.promise;
  await playerSays(t, api, "/pause", t.planner.window);
  finish.resolve();
  await planner;
  assert.ok(signal.aborted);
  assert.equal(plannerCalls(llm).length, 1, "cancellation stops before critique");
  assert.equal(t.planner.pending, null);
  assert.equal(t.planner.arc, null);
  assert.deepEqual(t.planner.inbox.map(l => l.text), ["Let us revisit the docks."]);
  const restored = await new Table({ api, llm, cfg: t.cfg, channelId: "ch", roster: t.roster,
    planner: structuredClone(t.planner), improv: t.improv, store: t.store }).init({ heal: true });
  restored.onMessage(old);
  assert.equal(restored.generation.paused, true);
  await playerSays(restored, api, "Include the old pier too.", restored.planner.window);
  await restored.planCommand("now");
  assert.equal(restored.planner.arc.version, 1);
  assert.equal(restored.planner.inbox.length, 0);

  // Recover a control command missed by the websocket, without re-playing earlier human turns.
  api.add({ chat_window_id: restored.planner.window, author_id: "u-alice", author_role: "player", content: "/pause" });
  await restored.observeHistory({ controlsOnly: true });
  assert.equal(restored.generation.paused, true);
  api.add({ chat_window_id: "w-main", author_id: "u-alice", author_role: "player", content: "Let's play." });
  await restored.observeHistory({ controlsOnly: true });
  assert.equal(restored.generation.paused, false);
  assert.equal(restored.turns, 0);
});

test('a lost fork response is recovered by the same persisted request without duplicate scenes', async () => {
  const { t, api } = await table({ bob: true });
  t.deferArrivals = true;
  api.loseForkResponse = true;
  await assert.rejects(t.command({ cmd: 'split', who: ['Alice Hale'], place: 'Library' }), /response lost/);
  assert.equal(api.createdWindows.length, 1);
  assert.equal(t.journal.phase, 'A');
  assert.equal(t.timelines.of('c-alice').id, 'main');
  const saved = structuredClone(t.journal);
  const restored = await new Table({ api, llm: new MockLlm(), cfg: t.cfg, channelId: 'ch', roster: new Roster(),
    journal: saved, deferArrivals: true, sleep: async () => {} }).init({ heal: true });
  assert.equal(api.createdWindows.length, 2, 'one fork per party, including the response-lost fork');
  assert.equal(restored.windowOf(restored.timelines.of('c-alice')), api.createdWindows[0].id);
  assert.notEqual(restored.primaryWindowId(), 'w-main');
  assert.equal(restored.journal, null);
});

// ---- without scene forks (timelines.scene_forks: false, the default): the main story stays in the Main Chat

test("without scene forks: a player's correction in chat or the planner window restores the real seat before play, despite a fresh move", async () => {
  for (const source of ["w-main", "w-planner"]) {
    const { t, api, llm } = await table({ forks: false,  bob: true });
    t.deferArrivals = true;
    t.planner.window = "w-planner";
    await t.command({ cmd: "split", who: ["Harriet Vance", "Bob Price"], place: "Darkroom" });
    const side = t.timelines.of("c-harriet");
    assert.equal(side.location, "Darkroom");
    const priv = await api.postMessage("ch", side.windowId, { content: "SIDE ONLY", kind: "narration", visibility: "window" });
    t.noteLine(priv);
    llm.placementCorrection = ({ actors, lines, correction }) => {
      assert.equal(lines.at(-1).text, "江念不是刚说要陪我们找学姐的吗？");
      assert.ok(!actors.some(a => a.id === "c-bob"), "someone else's PC is outside this player's authority");
      return { moves: [{ id: "c-harriet", destination: "T0", seq: correction }, { id: "c-bob", destination: "T0", seq: correction }] };
    };
    llm.director = () => {
      assert.equal(t.timelines.of("c-harriet").id, "main", "correct before GM answers");
      return { actions: [], coplayers_may_act: false };
    };
    const m = api.add({ chat_window_id: source, author_id: "u-alice", author_role: "player", kind: "ooc", content: "江念不是刚说要陪我们找学姐的吗？" });
    await t.onMessage(m);
    const cp = t.roster.coplayerByName("Harriet Vance");
    assert.deepEqual(cp.seats.filter(s => s.toSeq === null).map(s => s.windowId), ["w-main"]);
    assert.ok(cp.seats.at(-1).fromSeq > m.seq, "new seat does not expose old lines in a reused window");
    assert.equal(t.timelines.of("c-bob").id, side.id);
    assert.equal(t.guard.rec("c-harriet").correctionSeq, m.seq);
    assert.ok(!api.posts.some(p => p.window === "w-main" && p.content.includes("SIDE ONLY")));
    const before = t.timelines.log.length;
    await t.onMessage(m);
    assert.equal(t.timelines.log.length, before, "duplicate correction cannot move anyone twice");
  }
});

test("without scene forks: TIMELINE_AUTO=false: split moves co-players into a window of their own on a new timeline; rejoin brings them back", async () => {
  const llm = new MockLlm();
  llm.director = quietDirector(splitPlan);
  const { t, api } = await table({ forks: false,  llm, cfg: { timelineAuto: false } });
  await t.post("w-main", { kind: "ic", character_id: "c-harriet", content: "I go to the Old Harbour." });
  await playerSays(t, api, "Harriet, go and watch the harbour tonight.");
  const side = api.windows_.find((w) => w.name === "Side: Old Harbour");
  assert.ok(side, "a side window was created"); assert.deepEqual(side.members.map((m) => m.user_id), ["u-bot"], "no human sits in it");
  const harriet = t.roster.coplayerByName("Harriet Vance");
  assert.deepEqual(harriet.seats.map((s) => [s.windowId, s.toSeq === null]), [["w-main", false], [side.id, true]], "the Main Chat seat closed, the side seat is open");
  const tl = t.timelines.byName("Old Harbour");
  assert.equal(tl.windowId, side.id); assert.deepEqual(tl.members, ["c-harriet"]); assert.equal(tl.location, "Old Harbour");
  assert.deepEqual(t.timelines.main().members, ["c-alice"]);
  assert.ok(api.posts.some(p => p.window === side.id && p.content === "Fog hangs over the harbour."));
  // Harriet no longer hears the Main Chat.
  api.add({ chat_window_id: "w-main", author_id: "u-alice", author_role: "player", character_id: "c-alice", content: "MAIN-WHILE-AWAY" });
  await t.post(side.id, { kind: "ic", character_id: "c-harriet", content: "I go back to the others." });
  llm.director = quietDirector({ actions: [{ type: "rejoin", timeline: "Old Harbour", text: "Harriet comes back soaked." }], coplayers_may_act: true });
  await playerSays(t, api, "Come back from the harbour."); await settle(t);
  await playerSays(t, api, "Any news from the harbour?");
  assert.equal(t.timelines.byName("Old Harbour").status, "merged");
  assert.deepEqual(t.timelines.main().members.sort(), ["c-alice", "c-harriet"]);
  assert.deepEqual(harriet.seats.at(-1), { windowId: t.primaryWindowId(), fromSeq: harriet.seats.at(-1).fromSeq, toSeq: null });
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.ok(cp.includes("Fog hangs over the harbour."), "Harriet remembers her side trip");
  assert.ok(!cp.includes("MAIN-WHILE-AWAY"), "and not what the Main Chat said while she was away");
  assert.ok(cp.includes("Any news from the harbour?"), "but hears the Main Chat again now");
  assert.ok(cp.includes("YOUR TIMELINE: Main story"));
  const gm = llm.calls.filter((c) => c.purpose === "director").at(-1).messages[0].content;
  assert.ok(gm.includes("## Timelines") && gm.includes("Old Harbour [merged into Main story]"), "the GM sees the timelines");
  assert.ok(/Fog hangs over the harbour\./.test(gm) && gm.includes("[timeline: Old Harbour]"), "side lines are tagged with their timeline");
});

test("without scene forks: a side timeline moves on its own clock, with no human line, and the GM answers the co-players at once", async () => {
  const llm = new MockLlm();
  llm.director = quietDirector(splitPlan);
  const { t, api, clock } = await table({ forks: false,  llm, cfg: { timelineAuto: false, autonomySideIntervalMs: 90000, autonomyQuietMs: 10 * MIN } });
  await t.post("w-main", { kind: "ic", character_id: "c-harriet", content: "I go to the Old Harbour." });
  await playerSays(t, api, "Harriet, go and watch the harbour tonight.");
  const side = api.windows_.find((w) => w.name === "Side: Old Harbour");
  await settle(t);
  llm.director = (user) => ({ actions: user.includes("MODE: side") ? [{ type: "narrate", text: "A boat creaks at the quay." }] : user.includes("MODE: followup") ? [{ type: "narrate", text: "The sailor turns to you." }] : [], coplayers_may_act: true });
  assert.equal(await t.tick(), null, "too soon after the opening line");
  clock.t += 91000;
  const before = api.posts.length;
  await t.tick();
  const posted = api.posts.slice(before);
  assert.deepEqual(posted.map((p) => [p.window, p.kind, p.character_id ?? null]), [[side.id, "narration", null], [side.id, "ic", "c-harriet"], [side.id, "narration", null]], "GM, co-player, GM's answer — all in the side window");
  const sideCall = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.ok(sideCall.includes("No human player is with you here"), "the co-player knows it leads this thread");
  assert.ok(sideCall.includes("YOUR TIMELINE: Old Harbour; time: Tuesday night; place: Old Harbour"));
  assert.equal(await t.tick(), null, "the side interval has not passed again");
  clock.t += 91000;
  assert.notEqual(await t.tick(), null);
  assert.equal(t.autonomousTurns.length, 2);
});

test("without scene forks: a player who says they go elsewhere gets a window of their own with the GM, and its scene opens at once", async () => {
  const { t, api, llm } = await table({ forks: false,  bob: true });
  await alicePosts(t, api, "I go to the docks to look for the sailor.");
  await settle(t);
  const w = api.createdWindows[0];
  assert.ok(w, "a window was created"); assert.equal(w.name, "Scene: docks to look for the sailor");
  assert.deepEqual(w.members.map((m) => m.user_id), ["u-bot", "u-alice"], "exactly Alice (and the GM account)");
  assert.equal(api.membershipWrites, 1, "members are written once, at creation, and never added later");
  const tl = t.timelines.of("c-alice");
  assert.equal(tl.windowId, w.id); assert.deepEqual(tl.members, ["c-alice"]); assert.equal(tl.span, "short");
  assert.deepEqual(t.timelines.main().members.sort(), ["c-bob", "c-harriet"], "Bob and Harriet stay where they are");
  assert.ok(api.posts.some((p) => p.window === "w-main" && p.visibility === "whisper" && p.whisper_to?.[0] === "c-alice" && p.content.includes(w.name)), "Alice is pointed to her window");
  assert.ok(api.posts.some((p) => p.window === w.id && p.content.startsWith("[mock GM] docks")), "the opening is posted there");
  assert.ok(directorCalls(llm).some((u) => u.includes("MODE: arrival") && u.includes("Alice Hale just arrived")), "an arrival turn opened the scene");
  assert.ok(api.posts.some((p) => p.window === w.id && p.kind === "narration" && /You consider/.test(p.content)), "the GM narrated in her window");
  assert.ok(tl.opened, "the thread is marked opened");
  assert.match(t.splitWarning, /knowledge mode is public/, "public knowledge mode is noticed (the CLI warns about it)");
});

test("without scene forks: only the player's own line moves them; a co-player follows after its own line, and its memory follows its seat", async () => {
  const llm = new MockLlm();
  const baseDirector = llm.director.bind(llm);
  llm.director = (user) => {
    if (user.includes("MODE: followup") && user.includes("I follow Alice")) return { actions: [{ type: "narrate", text: "Harriet hurries after her." }], coplayers_may_act: false, whereabouts: [{ who: ["Harriet Vance"], thread: "T1" }] };
    return baseDirector(user);
  };
  llm.coplayer = (user) => (user.includes("YOU ARE: Harriet") && user.includes("I go to the docks") && !user.includes("Harriet hurries") ? { action: "speak", kind: "ic", text: "I follow Alice." } : { action: "speak", kind: "ic", text: "[mock] I look around." });
  const { t, api } = await table({ forks: false,  llm, bob: true });
  await alicePosts(t, api, "Harriet, wait here. I go to the docks.");
  await settle(t);
  const alice = t.timelines.of("c-alice");
  assert.deepEqual(alice.members.sort(), ["c-alice", "c-harriet"], "Harriet followed, after her own line");
  const harriet = t.roster.coplayerByName("Harriet Vance");
  assert.deepEqual(harriet.seats.filter((x) => x.toSeq === null).map((x) => x.windowId), [alice.windowId], "her one open seat is Alice's window");
  api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "MAIN-AFTER-SHE-LEFT" });
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn" && c.messages[0].content.startsWith("YOU ARE: Harriet")).at(-1).messages[0].content;
  assert.ok(cp.includes("I go to the docks"), "she remembers the departure");
  assert.ok(cp.includes("WITH YOU HERE") && cp.indexOf("Alice Hale") > cp.indexOf("WITH YOU HERE"), "she knows Alice is with her");
  assert.equal(api.membershipWrites, 1, "a co-player joining needs no membership write");
});

test("without scene forks: coming back: the player's thread merges into the main story, the old window points to the Main Chat, the reunion is narrated", async () => {
  const { t, api, llm } = await table({ forks: false,  bob: true });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  const side = t.timelines.of("c-alice");
  await alicePosts(t, api, "Nothing here. I go back to the others.", side.windowId);
  await settle(t);
  assert.equal(t.timelines.of("c-alice").id, "main");
  assert.equal(t.timelines.get(side.id).status, "merged"); assert.ok(t.timelines.retired(side.windowId));
  assert.ok(api.posts.some((p) => p.window === side.windowId && p.visibility === "window" && p.content === '→ "Main Chat"'), "the old window points back");
  assert.ok(directorCalls(llm).some((u) => u.includes("MODE: arrival") && u.includes("rejoined the others")), "the reunion gets its own scene opening");
  assert.equal(api.membershipWrites, 1, "no membership write for a reunion");
  assert.equal(await t.tick(), null, "a retired window never gets autonomous turns");
});

test("without scene forks: a platform failure creating the window changes nothing locally and the window is reused on retry", async () => {
  const { t, api } = await table({ forks: false,  llm: twoWays(), bob: true, cfg: { debounceMs: 20 } });
  api.failAfter = 1;                                   // Alice's window is created, Bob's fails
  await Promise.all([alicePosts(t, api, "I go to the docks."), bobSays(t, api, "And I go to the Mill.")]);
  await settle(t);
  assert.equal(api.createdWindows.length, 1);
  assert.equal(t.timelines.active().length, 1, "no thread without its window");
  assert.equal(t.journal, null);
  assert.deepEqual(t.guard.spare.map((x) => x.windowId), [api.createdWindows[0].id], "the window already made is kept");
  api.failAfter = undefined;
  await Promise.all([alicePosts(t, api, "I go to the docks."), bobSays(t, api, "And I go to the Mill.")]);
  await settle(t);
  assert.equal(api.createdWindows.length, 2, "only Bob's window is made the second time");
  assert.equal(t.timelines.of("c-alice").windowId, api.createdWindows[0].id, "Alice's earlier window is reused");
  assert.deepEqual(t.guard.spare, []);
});

test("without scene forks: a split the platform fails three times is given up and noted, not retried every turn", async () => {
  const { t, api } = await table({ forks: false,  bob: true });
  api.failCreate = true;
  for (let i = 0; i < 4; i++) { await alicePosts(t, api, "I go to the docks."); await settle(t); }
  assert.equal(api.createAttempts, 3);
  assert.ok(api.posts.some((p) => p.visibility === "gm_only" && /failed to open this scene three times/.test(p.content)));
  assert.equal(t.timelines.of("c-alice").id, "main");
});

test("without scene forks: an interrupted split is finished on restart with the window it had already made, and its scene still gets an opening turn", async () => {
  const { t, api, llm } = await table({ forks: false,  bob: true });
  const made = await api.createWindow("ch", { name: "Scene: Docks", kind: "group", members: [{ user_id: "u-alice", character_id: "c-alice" }] });
  const ops = [{ op: "split", ids: ["c-alice"], place: "Docks", time: "", span: "short", opening: "Fog.", fromTimeline: "main", replaces: null }];
  const journal = { opId: "x", ops, changed: ["c-alice"], windowId: "w-main", created: [{ windowId: made.id, placeKey: "docks", users: ["u-alice"] }], phase: "A" };
  const t2 = new Table({ api, llm, cfg: t.cfg, channelId: "ch", roster: new Roster(), journal, sleep: async () => {} });
  await t2.init({ heal: true });
  await settle(t2);
  assert.equal(api.createdWindows.length, 1, "no second window");
  assert.equal(t2.timelines.of("c-alice").windowId, made.id);
  assert.equal(t2.timelines.of("c-alice").location, "Docks");
  assert.equal(t2.journal, null);
  assert.ok(directorCalls(llm).some((u) => u.includes("MODE: arrival")), "the opening turn ran");
});

test("without scene forks: a CLI command applied without a run process leaves its arrival for run", async () => {
  const { t, api } = await table({ forks: false });
  t.deferArrivals = true;
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Lighthouse", span: "long" });
  assert.equal(t.owedArrivals.length, 1);
  assert.equal(t.timelines.of("c-harriet").span, "long");
  assert.equal(api.createdWindows[0].name, "Side: Lighthouse");
  await t.command({ cmd: "rejoin", timeline: "Lighthouse" });
  assert.equal(t.timelines.of("c-harriet").id, "main");
});

test("without scene forks: an interrupted presence regroup resumes without narrating a second arrival", async () => {
  const { t, api, llm } = await table({ forks: false,  bob: true });
  const made = await api.createWindow("ch", { name: "Scene: 507", kind: "group", members: [{ user_id: "u-alice", character_id: "c-alice" }] });
  const journal = { mode: "presence", opId: "reunion", phase: "A", windowId: "w-main", changed: ["c-alice", "c-harriet"],
    ops: [{ op: "split", ids: ["c-alice", "c-harriet"], place: "507", time: "", span: "short", opening: "", fromTimeline: "main", replaces: null }],
    created: [{ windowId: made.id, placeKey: "507", users: ["u-alice"] }] };
  const t2 = new Table({ api, llm, cfg: t.cfg, channelId: "ch", roster: new Roster(), journal, sleep: async () => {} });
  await t2.init({ heal: true }); await settle(t2);
  assert.equal(api.createdWindows.length, 1);
  assert.equal(t2.timelines.of("c-alice").id, t2.timelines.of("c-harriet").id);
  assert.equal(t2.timelines.of("c-alice").opened, true);
  assert.equal(t2.journal, null);
  assert.ok(!directorCalls(llm).some(u => u.includes("MODE: arrival")));
});

test("without scene forks: a lone player who leaves keeps the Main Chat (it moves with them); the co-player left behind gets a side window", async () => {
  const { t, api } = await table({ forks: false });
  t.timelines.relocate("main", { location: "Hale House" });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  assert.equal(t.timelines.of("c-alice").id, "main", "Alice never has to change windows");
  assert.equal(t.timelines.main().location, "docks");
  const side = t.timelines.of("c-harriet");
  assert.notEqual(side.id, "main"); assert.equal(side.location, "Hale House");
  assert.equal(api.createdWindows[0].name, "Side: Hale House"); assert.equal(api.membershipWrites, 0, "a co-players-only window has no members to write");
});

test("without scene forks: a player leaving a shared scene: the co-player who stays continues in a fresh window, and only the leaver is welcomed back", async () => {
  const { t, api, llm } = await table({ forks: false,  bob: true });
  await t.command({ cmd: "split", who: ["Alice Hale", "Harriet Vance"], place: "Docks" });
  await settle(t);
  const docks = t.timelines.of("c-alice");
  const callsBefore = directorCalls(llm).length;
  await alicePosts(t, api, "Nothing here. I go back to the others.", docks.windowId);
  await settle(t);
  assert.equal(t.timelines.of("c-alice").id, "main");
  const harriet = t.timelines.of("c-harriet");
  assert.notEqual(harriet.id, "main"); assert.notEqual(harriet.windowId, docks.windowId, "Harriet's scene moved to a fresh window");
  assert.deepEqual(t.windowUsers(harriet.windowId), [], "Alice cannot read where Harriet stayed");
  const later = directorCalls(llm).slice(callsBefore);
  assert.ok(later.some((u) => u.includes("Alice Hale just rejoined")), "Alice's reunion is narrated");
  assert.ok(!later.some((u) => u.includes("Harriet Vance just rejoined")), "Harriet never 'rejoins' anyone");
});

test("without scene forks: separate arrivals at room 507 reunite before the next response despite stale thread labels and a fresh split", async () => {
  const { t, api, llm } = await table({ forks: false,  extraCharacters: [{ id: "c-jiang", name: "江念", kind: "pc", user_id: "u-bot", role_card: {} }] });
  t.deferArrivals = true;
  t.timelines.main().location = "教室";
  await t.command({ cmd: "split", who: ["Harriet Vance", "江念"], place: "七号楼一楼门厅" });
  const side = t.timelines.of("c-harriet");
  await t.post(side.windowId, { kind: "ic", character_id: "c-harriet", content: "记着呢，明天吃完饭再去领钥匙。晚安，我也回507洗漱了。" });
  const arrival = await api.postMessage("ch", side.windowId, { kind: "narration", visibility: "window", content: "Harriet上到五楼，回到507。江念各自回寝。SIDE-PUBLIC-DETAIL" }); t.noteLine(arrival);
  const home = await api.postMessage("ch", "w-main", { kind: "narration", visibility: "window", content: "你回到507，今晚的奔忙到这里结束。" }); t.noteLine(home);
  t.noteLine(api.add({ chat_window_id: side.windowId, kind: "narration", author_role: "gm", visibility: "gm_only", content: "HIDDEN-PRESENCE-DETAIL" }));
  t.noteLine(api.add({ chat_window_id: side.windowId, kind: "ic", character_id: "c-jiang", visibility: "whisper", content: "WHISPER-PRESENCE-DETAIL" }));
  llm.presence = ({ threads }) => {
    assert.ok(!JSON.stringify(threads).includes("HIDDEN-PRESENCE-DETAIL"));
    assert.ok(!JSON.stringify(threads).includes("WHISPER-PRESENCE-DETAIL"));
    const source = threads.find(th => th.members.some(m => m.id === "c-harriet"));
    if (source.key === "T0") return { placements: [] };
    assert.equal(source.location, "七号楼一楼门厅", "an obsolete label must not hide a published arrival");
    return { placements: [{ id: "c-harriet", thread: "T0", with: "c-alice", actor_seq: arrival.seq, target_seq: home.seq, place: "507" }] };
  };
  llm.director = () => {
    assert.equal(t.timelines.of("c-harriet").id, "main", "membership is corrected before the GM responds");
    return { actions: [], coplayers_may_act: true };
  };
  await alicePosts(t, api, "晚安。");
  assert.equal(t.timelines.of("c-harriet").id, "main");
  assert.equal(t.timelines.main().location, "507");
  assert.equal(t.timelines.of("c-jiang").id, side.id, "same building does not mean everyone is in 507");
  const cp = t.roster.coplayerByName("Harriet Vance");
  assert.deepEqual(cp.seats.filter(s => s.toSeq === null).map(s => s.windowId), ["w-main"]);
  const context = llm.calls.findLast(c => c.purpose === "coplayer_turn" && c.messages[0].content.startsWith("YOU ARE: Harriet"));
  assert.match(context.messages[0].content.split("WITH YOU HERE")[1], /Alice Hale/);
  assert.ok(!api.posts.some(p => p.window === "w-main" && p.content.includes("SIDE-PUBLIC-DETAIL")), "comparison never copies another scene's history into chat");
  assert.ok(!directorCalls(llm).some(u => u.includes("MODE: arrival")), "bookkeeping does not narrate a second arrival");
  const log = t.timelines.log.length;
  await t.reconcilePresence("w-main", t.guard.turn);
  assert.equal(t.timelines.log.length, log, "already-synchronised membership is not applied again");
});

import { directorSystem as _directorSystem } from "../src/director.mjs";
test("scene forks are off by default: the GM is told to narrate the main story in the Main Chat; on, it is a lobby", () => {
  assert.equal(buildConfig({}, {}).sceneForks, false);
  assert.equal(buildConfig({ "scene-forks": "true" }, {}).sceneForks, true);
  assert.equal(buildConfig({}, {}, { timelines: { scene_forks: true } }).sceneForks, true);
  const off = _directorSystem("English", {}), on = _directorSystem("English", { forks: true });
  assert.match(off, /Decide this only in the Main Chat\. A short split/); assert.doesNotMatch(off, /public lobby/);
  assert.match(on, /Main Chat becomes a public lobby after the party splits; never narrate a private scene there\./);
});

test("without scene forks: a main story left in a fork comes back to the Main Chat once nobody is split off", async () => {
  const { t, api } = await table({ forks: false });
  const fork = await api.createWindow("ch", { name: "Scene: the study", kind: "group", members: [{ user_id: "u-alice", character_id: "c-alice" }] });
  await t.refresh();
  t.timelines.bind("main", fork.id);
  assert.equal(t.primaryWindowId(), fork.id); assert.equal(t.scene("w-main"), null, "a lobby while bound");
  await t.heal();
  assert.equal(t.timelines.main().windowId, null);
  assert.equal(t.primaryWindowId(), "w-main"); assert.equal(t.scene("w-main").id, "main");
  assert.ok(t.timelines.retired(fork.id), "the fork's scene is over");
  for (const cp of t.roster.coplayers) assert.equal(cp.seats.at(-1).windowId, "w-main", `${cp.name} sits in the Main Chat`);
});

// ---- D&D 2024 tables
const DND_CARD = { basic: { occupation: "Rogue", age: "24", sex: "female" }, dnd: { ...new MockLlm().dndBuild(), level: 3 } };

test("a D&D table: the GM's and the co-players' prompts follow the profile; the cast shows builds and D&D traits; CoC prompts are the snapshot's", async () => {
  const { t, api, llm } = await table({ rules: "dnd2024" });
  api.characters_[1].role_card = DND_CARD;
  api.characters_[0].role_card = { basic: { occupation: "Fighter" }, dnd: { class: "Fighter", level: 2, species: "Goliath", background: "Soldier", base: { STR: 15, DEX: 10, CON: 14, INT: 8, WIS: 12, CHA: 8 }, increases: { STR: 2, CON: 1 }, improvements: { STR: 3 }, skills: { Athletics: 1 } } };
  assert.equal(t.profile.id, "dnd2024"); assert.equal(t.rules.point_buy.budget, 27, "the D&D rules were fetched");
  await alicePosts(t, api, "I check the door for traps."); await settle(t);
  const director = llm.calls.find((c) => c.purpose === "director");
  assert.match(director.system, /^You are the GM \(Game master\) of a fifth-edition fantasy campaign/); assert.doesNotMatch(director.system, /Keeper|Dungeon Master|\bDM\b|\.sc /); assert.match(director.system, /"type": "dice"/);
  const gm = director.messages[0].content;
  assert.match(gm, /Co-players \(AI adventurers/); assert.match(gm, /- Harriet Vance\n    build: level 3 Elf Rogue \(Criminal\)\n/); assert.match(gm, /- Alice Hale \(played by alice\)\n    build: level 2 Goliath Fighter \(Soldier\)\n[^\n]*\n    notable: extremely strong/);
  assert.doesNotMatch(gm, /Keeper|Dungeon Master|Investigators may be living/); assert.match(gm, /## GM board/); assert.match(gm, /\[GM only\]/); assert.match(gm, /Adventurers may be living different threads/);
  assert.match(gm, /Decide the GM's actions for this turn\.$/);
  const cp = llm.calls.find((c) => c.purpose === "coplayer_turn");
  assert.match(cp.system, /^You play one adventurer in a fifth-edition fantasy game/); assert.doesNotMatch(cp.system, /Keeper|Dungeon Master/);
  const self = cp.messages[0].content;
  assert.match(self, /YOUR ROLE CARD:\nlevel 3 Elf Rogue, Criminal background/); assert.match(self, /HP 20\/24/, "live HP from the sheet"); assert.match(self, /AC 14/); assert.match(self, /Stealth \+7 \(expertise\)/);
  assert.match(self, /THE OTHER ADVENTURERS/); assert.match(self, /GM \(narration\)/); assert.doesNotMatch(self, /Keeper|Dungeon Master/);
  assert.ok(!self.includes("STR 20") && !self.includes("base"), "a companion's numbers stay private");
  assert.match(self, /- Alice Hale\n    build: level 2 Goliath Fighter \(Soldier\)/);
});

test("D&D dice: co-players roll .rc/.ri/.ds/.ss and the result comes back; the GM's dice action runs .ri and .init, never .rc", async () => {
  const llm = new MockLlm();
  const baseCp = llm.coplayer.bind(llm);
  llm.coplayer = (u, s) => (u.includes("NEWEST LINE: #") && u.includes("Roll, Harriet") ? { action: "roll", command: ".rc Stealth dc 15", text: "I slip into the shadows." } : baseCp(u, s));
  const baseD = llm.director.bind(llm);
  llm.director = (u) => (u.includes("NEWEST LINE: Alice Hale: A goblin jumps out!") && !/^MODE: /m.test(u) ? { actions: [{ type: "dice", command: ".ri +2 Goblin", text: "Roll for initiative!" }, { type: "dice", command: ".rc Stealth" }, { type: "request_roll", who: "Alice Hale", command: ".ri" }, { type: "request_roll", who: "Harriet Vance", command: ".ri" }], coplayers_may_act: false } : baseD(u));
  const { t, api } = await table({ llm, rules: "dnd2024" });
  await alicePosts(t, api, "Roll, Harriet."); await settle(t);
  const roll = api.posts.find((p) => p.content === ".rc Stealth dc 15");
  assert.ok(roll && roll.character_id === "c-harriet", "posted as her line");
  assert.match(directorCalls(llm).at(-1), /\.rc Stealth dc 15 → \[fake dice\] \.rc Stealth dc 15/, "the GM reads the result in the follow-up");
  await alicePosts(t, api, "A goblin jumps out!"); await settle(t);
  const after = api.posts.slice(api.posts.findIndex((p) => p.content === "Roll for initiative!"));
  assert.deepEqual(after.map((p) => [p.content, p.character_id ?? null]), [["Roll for initiative!", null], [".ri +2 Goblin", null], ["→ Alice Hale: .ri", null], [".ri", "c-harriet"]], "the goblin's roll as the GM account, no .rc; players asked, the co-player rolled");
  const { validateCoplayer } = await import("../src/coplayer.mjs");
  const dnd = t.profile;
  for (const c of [".ri", ".ds", ".ss 1", ".rc attack +5 ac 14", ".ra WIS save adv dc 13", ".r 1d8+3"]) assert.equal(validateCoplayer({ action: "roll", command: c }, { roll: dnd.roll }).command, c);
  for (const c of [".init next", ".st hp-3", ".rch Stealth", ".sc 1/1d6", ".en Stealth"]) assert.throws(() => validateCoplayer({ action: "roll", command: c }, { roll: dnd.roll }), /unsupported roll command/, c);
  assert.throws(() => validateCoplayer({ action: "roll", command: ".ri" }), /unsupported/, "not in CoC");
  const { validateDirector } = await import("../src/director.mjs");
  assert.deepEqual(validateDirector({ actions: [{ type: "dice", command: ".init next" }] }).actions, [], "no dice action on a CoC table");
});

test("D&D initiative: the order is shown in the GM's context while a fight is on, and refreshed on initiative.changed", async () => {
  const { t, api, llm } = await table({ rules: "dnd2024" });
  await alicePosts(t, api, "Hello?"); await settle(t);
  assert.doesNotMatch(directorCalls(llm).at(-1), /## Initiative/);
  api.initiative_ = { round: 2, turn: 1, entries: [{ id: "e1", name: "Goblin", total: 18, character_id: null, created_by: "u-bot" }, { id: "e2", name: "Alice Hale", total: 15, character_id: "c-alice", created_by: "u-alice" }] };
  await alicePosts(t, api, "Still here."); await settle(t);
  assert.doesNotMatch(directorCalls(llm).at(-1), /## Initiative/, "cached: nothing said the order changed");
  t.onEvent({ stream: "chat", type: "initiative.changed", channel_id: "ch", chat_window_id: "w-main" });
  await alicePosts(t, api, "I attack."); await settle(t);
  assert.match(directorCalls(llm).at(-1), /## Initiative in "Main Chat" \(round 2; use dice "\.init next" after each turn\)\n- Goblin 18 \(yours\)\n- Alice Hale 15 ← now/);
  const coc = await table();
  await alicePosts(coc.t, coc.api, "Hello?"); await settle(coc.t);
  assert.equal(coc.api.initiativeReads, 0, "a CoC table never asks for initiative");
});

test("D&D live HP and slots refresh without invalidating the co-player's cached identity", async () => {
  const { t, api, llm } = await table({ rules: "dnd2024" });
  const read = api.characterSpace.bind(api);
  let hp = 20, slots = 2;
  api.characterSpace = async (...args) => {
    const space = await read(...args);
    space.character.role_card.dnd.slots = { 1: 2 };
    space.character.role_card.dnd.spellcasting_ability = "INT";
    space.attrs = { HP: hp, "Slot 1": slots };
    return space;
  };
  const cp = t.roster.coplayers[0];
  await t.coplayerAct("w-main", cp, true);
  const before = llm.calls.findLast(c => c.purpose === "coplayer_turn").parts[0];
  hp = 7; slots = 1;
  t.onEvent({ stream: "chat", type: "character.updated", character: { id: cp.characterId } });
  await t.coplayerAct("w-main", cp, true);
  const after = llm.calls.findLast(c => c.purpose === "coplayer_turn").parts[0];
  assert.equal(before[0].text, after[0].text);
  assert.match(after.at(-1).text, /HP 7\/24/);
  assert.match(after.at(-1).text, /spell slots: level 1: 1\/2/);
  assert.doesNotMatch(after[0].text, /HP 7\/24|level 1: 1\/2/);
});

test("a PbtA table still runs GM and co-player turns with only public player moves", async () => {
  const { t, api, llm } = await table({ rules: "pbta" });
  assert.equal(t.profile.id, "pbta");
  await alicePosts(t, api, "We explore the station."); await settle(t);
  const gm = llm.calls.find(c => c.purpose === "director");
  const cp = llm.calls.find(c => c.purpose === "coplayer_turn");
  assert.match(gm.system, /^You are the GM \(Game master\) of a Powered by the Apocalypse campaign/); assert.doesNotMatch(gm.system, /\bMC\b|Keeper/);
  assert.match(gm.messages[0].content, /PRIVATE-GM-MOVE/);
  assert.match(cp.system, /Powered by the Apocalypse/);
  assert.match(cp.messages[0].content, /Your available moves and playbook:.*Explore/);
  assert.doesNotMatch(cp.messages[0].content, /PRIVATE-GM-MOVE|SECRET-NPC/);
  assert.equal(api.initiativeReads, 0);
});

import { directorSystem as _dirSys } from "../src/director.mjs";
import { plannerSystem as _planSys } from "../src/planner.mjs";
import { rulesProfile as _rulesProfile } from "../src/rules/index.mjs";
test("new people: reuse the cast for new plots; a specific person with more than a line who could bond becomes a platform NPC", () => {
  const director = _dirSys("English", {});
  for (const text of [director, _planSys("English", { mode: "full" })]) {
    assert.match(text, /Grow newer plots out of the people already in the story/);
    assert.match(text, /\(1\) they could build a lasting bond with the player characters or co-players.*\(2\) they have more than one sentence to say; \(3\) they are one specific person, not a voice standing for a crowd or a group/);
    assert.match(text, /a character created on the platform, never a voice inside narration/);
    assert.doesNotMatch(text, /Minor one-off service roles can stay unnamed|only when the story needs a distinct role the existing cast cannot credibly fill/);
  }
  assert.match(director, /enters with new_npc \(name, a brief for their role card, their first line\) and speaks with npc after that; never put a real NPC's words inside narrate/);
  assert.match(_dirSys("English", { profile: _rulesProfile("dnd2024") }), /could build a lasting bond with the player characters/);
});


// ---- recall: a player takes a line back
const recallLine = (t, api, line) => {
  const tombstone = { ...line, content: "", recalled_at: "2026-11-07T00:00:00Z", recall_seconds_left: null };
  api.lines[api.lines.findIndex((m) => m.id === line.id)] = tombstone;
  return t.onEvent({ stream: "chat", type: "message.recalled", channel_id: "ch", message: tombstone });
};
const lineSaid = (api, content, { who = "alice", w = "w-main" } = {}) => api.add({ chat_window_id: w, author_id: `u-${who}`, author_role: "player", character_id: `c-${who}`, content });
const sayLine = (t, line) => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: line });
const openSeats = (cp) => cp.seats.filter((s) => s.toSeq === null).map((s) => s.windowId);

test("a recent recall rolls the table back: the GM's lines after it are recalled and the co-player's move is undone", async () => {
  const { t, api } = await table({ forks: false });
  const harriet = t.roster.coplayerByName("Harriet Vance");
  const before = { timelines: structuredClone(t.timelines.toJSON()), seats: openSeats(harriet) };
  const said = lineSaid(api, "I go to the docks to look for the sailor.");
  await sayLine(t, said); await settle(t);
  assert.equal(api.createdWindows.length, 1, "Harriet, left behind, got a side window");
  assert.notDeepEqual(openSeats(harriet), ["w-main"]);
  const answered = api.lines.filter((m) => m.author_id === "u-bot" && m.seq > said.seq);
  assert.ok(answered.length >= 2, "the GM answered, in the Main Chat and in the side window");
  await recallLine(t, api, said); await settle(t);
  for (const m of answered) assert.ok(api.recalled.includes(m.id), `recalled: ${m.content.slice(0, 40)}`);
  assert.deepEqual(openSeats(harriet), before.seats, "Harriet is back in the Main Chat");
  assert.deepEqual(JSON.parse(JSON.stringify(t.timelines.toJSON())), JSON.parse(JSON.stringify(before.timelines)), "the timelines are as they were");
  const note = api.posts.at(-1);
  assert.equal(note.visibility, "gm_only"); assert.match(note.content, /^Alice Hale recalled a line\. I took back \d+ of my lines after it and undid where everyone is\./);
  assert.ok(!t.history.lines("w-main").some((m) => answered.some((a) => a.id === m.id) || m.id === said.id), "none of it is in the context");
  assert.equal(t.checkpoints.length, 0, "the undone turns are forgotten");
});

test("a recall after ten or more lines only takes the line out of the context", async () => {
  const { t, api } = await table({ forks: false });
  const said = lineSaid(api, "I look around the study.");
  await sayLine(t, said); await settle(t);
  for (let i = 0; i < 10; i++) t.onMessage(api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: `later ${i}` }));
  const posts = api.posts.length;
  await recallLine(t, api, said); await settle(t);
  assert.equal(api.recalled, undefined, "nothing is recalled");
  assert.equal(api.posts.length, posts, "no note");
  assert.ok(!t.history.lines("w-main").some((m) => m.id === said.id), "the line itself is gone");
  assert.ok(t.history.lines("w-main").some((m) => m.content === "later 9"));
});

test("a line recalled before its turn starts is not answered; one recalled mid-turn stops the turn", async () => {
  const waiting = await table({ forks: false, cfg: { debounceMs: 40 } });
  const early = lineSaid(waiting.api, "I open the cabinet.");
  sayLine(waiting.t, early);
  await recallLine(waiting.t, waiting.api, early);
  await new Promise((r) => setTimeout(r, 80)); await settle(waiting.t);
  assert.equal(waiting.llm.calls.filter((c) => c.purpose === "director").length, 0, "no turn for a recalled line");
  assert.equal(waiting.api.posts.length, 0);

  const llm = new MockLlm(), base = llm.complete.bind(llm);
  let release; const gate = new Promise((r) => { release = r; });
  llm.complete = async (args) => { if (args.purpose === "coplayer_turn") await gate; return base(args); };
  const { t, api } = await table({ llm, forks: false });
  const said = lineSaid(api, "Harriet, what do you make of the clock?");
  sayLine(t, said);
  for (let i = 0; i < 50 && !api.posts.length; i++) await new Promise((r) => setTimeout(r, 2));
  const gm = api.posts.length;
  assert.ok(gm > 0, "the GM spoke before the co-player");
  const rolledBack = recallLine(t, api, said);
  release(); await rolledBack; await settle(t);
  assert.ok(!api.posts.some((p) => p.character_id === "c-harriet"), "the co-player never spoke");
  assert.ok(api.lines.filter((m) => m.author_id === "u-bot" && m.seq > said.seq && !m.visibility?.startsWith("gm")).every((m) => m.recalled_at), "what the GM said is recalled");
});

test("another player's line after the recalled one stays and is answered again; a roll stays on the record", async () => {
  const llm = new MockLlm();
  const { t, api } = await table({ llm, bob: true, forks: false });
  const said = lineSaid(api, "I knock on the cellar door.");
  await sayLine(t, said); await settle(t);
  await t.post("w-main", { content: ".ra Listen", kind: "ic", character_id: "c-harriet" }, { count: false });
  const bob = lineSaid(api, "I check the window.", { who: "bob" });
  await sayLine(t, bob); await settle(t);
  const calls = llm.calls.filter((c) => c.purpose === "director").length;
  await recallLine(t, api, said); await settle(t);
  const fresh = llm.calls.filter((c) => c.purpose === "director").slice(calls);
  assert.ok(fresh.length >= 1, "a new turn answers Bob");
  const prompt = fresh[0].messages[0].content;
  assert.ok(prompt.includes("I check the window."), "Bob's line is still there");
  assert.ok(!prompt.includes("I knock on the cellar door."), "the recalled line is not");
  const note = api.posts.find((p) => p.visibility === "gm_only" && /recalled a line/.test(p.content));
  assert.ok(note, "the GM is told"); assert.match(note.content, /These stay, because the platform already holds them: a roll's result\./);
  assert.ok(api.lines.some((m) => m.kind === "roll" && !m.recalled_at), "the roll stays");
});


test("casual: a recalled text is taken back from the other player's phone, and a reply on its way is cancelled", async () => {
  const llm = new MockLlm(), base = llm.director.bind(llm);
  llm.director = (user) => (/^MODE: phone/m.test(user) ? { actions: [{ type: "text", from: "Mr. Grimsby", to: "Alice Hale", text: "Under the clock, miss.", delay_minutes: 30 }], coplayers_may_act: false } : base(user));
  const { t, api } = await isolated({ llm });
  await t.setCasual(true);
  await textFrom(t, api, "c-alice", "@Bob Price meet me at the pier"); await settle(t);
  const text = api.lines.findLast((m) => m.author_id === "u-alice");
  const copy = texts(t, api, "c-bob")[0];
  assert.equal(copy.content, "meet me at the pier");
  await recallLine(t, api, text); await settle(t);
  const copyLine = api.lines.find((m) => m.chat_window_id === phoneOf(t, "c-bob") && m.character_id === "c-alice");
  assert.ok(copyLine.recalled_at, "the copy in Bob's phone is recalled");
  await textFrom(t, api, "c-alice", "@Mr. Grimsby where is the key?"); await settle(t);
  assert.equal(t.casual.pending.length, 1, "Grimsby's answer is on its way");
  await recallLine(t, api, api.lines.findLast((m) => m.author_id === "u-alice")); await settle(t);
  assert.equal(t.casual.pending.length, 0, "and is cancelled with the text it answered");
});


// ---- illustrations
const illustrateCfg = (over = {}) => ({ illustrations: { enabled: true, maxPerHour: 3, allowCloud: true, ...over } });

test("the GM may have an evocative moment drawn: with the characters' portraits, at most so often, and it costs no line", async () => {
  const llm = new MockLlm();
  llm.director = (user) => (user.includes("NEWEST LINE") ? { actions: [
    { type: "narrate", text: "The fog parts over the harbour." },
    { type: "illustrate", text: "Harriet at the end of the pier, lantern raised, fog lit gold", who: ["Harriet Vance", "Mr. Grimsby", "Nobody"], orientation: "portrait" },
  ], coplayers_may_act: false } : { actions: [], coplayers_may_act: false });
  const { t, api } = await table({ llm, forks: false, cfg: illustrateCfg({ maxPerHour: 1 }) });
  await playerSays(t, api, "I walk to the end of the pier."); await settle(t);
  const system = llm.calls.find((c) => c.purpose === "director").system;
  assert.match(system, /- Pictures: the story moves in small events/); assert.match(system, /for a breathtaking moment in the middle of an event[^\n]*illustrate/); assert.match(system, /"type": "illustrate"/); assert.match(system, /"type": "event_done"/);
  assert.deepEqual(api.illustrations_.map((j) => [j.window_id, j.prompt, j.character_ids, j.orientation, j.allow_cloud]),
    [["w-main", "Harriet at the end of the pier, lantern raised, fog lit gold", ["c-harriet", "c-butler"], "portrait", true]], "unknown names are left out");
  assert.ok(api.lines.some((m) => m.kind === "ooc" && m.content.startsWith("🖼️ Harriet at the end") && m.media_asset_id), "posted by the platform as the GM's picture");
  await playerSays(t, api, "I look back at the town."); await settle(t);
  assert.equal(api.illustrations_.length, 1, "the hourly limit holds");
  const off = await table({ llm: new MockLlm(), forks: false, cfg: illustrateCfg({ enabled: false }) });
  await playerSays(off.t, off.api, "Hello?"); await settle(off.t);
  assert.doesNotMatch(off.llm.calls.find((c) => c.purpose === "director").system, /Illustrations:|"illustrate"/, "off: the GM is not offered the action");
});

test("every scenario change draws the best moment of each timeline a player is in, all posted in the Main Chat", async () => {
  const { t, api, llm } = await table({ bob: true, forks: false, cfg: illustrateCfg() });
  await playerSays(t, api, "I go to the docks to look for the sailor."); await settle(t);
  const scene = t.timelines.of("c-alice").windowId;
  assert.ok(scene && scene !== "w-main", "Alice plays in her own scene");
  await sayLine(t, lineSaid(api, "I watch the gulls over the moonlit water.", { w: scene })); await settle(t);
  await sayLine(t, lineSaid(api, "I bar the study door.", { who: "bob" })); await settle(t);
  const before = llm.calls.length;
  await t.command({ cmd: "advance", title: "The next morning" }); await t.illustrating;
  const asks = llm.calls.slice(before).filter((c) => c.purpose === "scenario_illustration").map((c) => c.messages[0].content);
  assert.equal(asks.length, 2, "one for Bob's timeline in the Main Chat, one for Alice's scene");
  const [main, docks] = [asks.find((a) => a.includes("I bar the study door.")), asks.find((a) => a.includes("moonlit water"))];
  assert.ok(main && docks, "each from its own window's lines");
  assert.ok(!main.includes("moonlit water") && !docks.includes("I bar the study door."), "neither sees the other's scene");
  assert.ok(!asks.some((a) => a.includes("The next morning\n")), "the next scenario's own lines are not part of it");
  assert.deepEqual(api.illustrations_.map((j) => j.window_id), ["w-main", "w-main"], "both posted in the Main Chat");
  assert.ok(api.illustrations_.every((j) => j.prompt.startsWith("[mock moment]")));
});

test("a co-player-only thread gets no scenario picture; a busy account makes the picture wait; no image provider turns illustrations off", async () => {
  const { t, api, llm } = await table({ forks: false, cfg: illustrateCfg() });
  await playerSays(t, api, "I go to the docks to look for the sailor."); await settle(t);
  assert.ok(t.timelines.active().some((tl) => tl.members.length && tl.members.every((id) => !t.isPc(id))), "Harriet, left behind, has a thread of her own");
  api.holdIllustrations = 1;                       // the first picture stays in the drawing
  await t.illustrateMoment("w-main", { text: "A picture still being drawn", who: [] });
  api.releaseIllustrations = true;                 // finished when the table next looks
  await t.command({ cmd: "advance", title: "Later" }); await t.illustrating;
  assert.equal(llm.calls.filter((c) => c.purpose === "scenario_illustration").length, 1, "only Alice's timeline");
  assert.deepEqual(api.illustrations_.map((j) => j.status), ["completed", "completed"], "it waited for the first picture, then was drawn");
  const none = await table({ forks: false, cfg: illustrateCfg() });
  none.api.noImages = true;
  await none.t.illustrateMoment("w-main", { text: "A moment", who: [] });
  assert.match(none.t.illustrationOff, /not configured/);
  await playerSays(none.t, none.api, "Hello?"); await settle(none.t);
  assert.doesNotMatch(none.llm.calls.filter((c) => c.purpose === "director").at(-1).system, /"illustrate"/, "the GM is no longer offered it");
});

test("the platform's switches: no drawing while the GM or the server's maintainers have it off, never off for good", async () => {
  const { t, api, llm } = await table({ forks: false, cfg: illustrateCfg() });
  // The GM turned it off since the table started: the refusal is learnt, not taken for a missing image provider.
  api.channelIllustrations = false;
  await t.illustrateMoment("w-main", { text: "A moment", who: [] });
  assert.equal(api.illustrations_?.length ?? 0, 0);
  assert.equal(t.illustrationOff, null, "not off for good");
  assert.equal(t.illustrationsOn(), false);
  await playerSays(t, api, "Hello?"); await settle(t);
  assert.doesNotMatch(llm.calls.filter((c) => c.purpose === "director").at(-1).system, /"illustrate"/, "the GM is not offered it while it is off");
  // Back on: the channel's update is followed.
  api.channelIllustrations = true;
  t.onEvent({ stream: "chat", type: "channel.updated", channel_id: "ch" }); await settle(t);
  assert.equal(t.illustrationsOn(), true);
  // The server's maintainers switch it: their settings event is followed at once, both ways.
  t.onEvent({ stream: "chat", type: "server.settings", channel_id: "ch", settings: { features: { illustrations: false } } });
  assert.equal(t.illustrationsOn(), false);
  t.onEvent({ stream: "chat", type: "server.settings", channel_id: "ch", settings: { features: { illustrations: true } } });
  await t.illustrateMoment("w-main", { text: "The hall in moonlight", who: [] });
  assert.deepEqual(api.illustrations_.map((j) => j.prompt), ["The hall in moonlight"]);
  // Off on the server when the table starts: read from the server's settings.
  const later = await table({ forks: false, cfg: illustrateCfg(), before: (a) => { a.serverIllustrations = false; } });
  assert.equal(later.t.illustrationsOn(), false);
});

test("a recall that rolls back a turn cancels the picture it asked for", async () => {
  const llm = new MockLlm();
  llm.director = (user) => (user.includes("NEWEST LINE") ? { actions: [{ type: "narrate", text: "Moonlight floods the hall." }, { type: "illustrate", text: "The hall in moonlight", who: [] }], coplayers_may_act: false } : { actions: [], coplayers_may_act: false });
  const { t, api } = await table({ llm, forks: false, cfg: illustrateCfg() });
  api.holdIllustrations = 1;
  const said = lineSaid(api, "I open the shutters.");
  await sayLine(t, said); await settle(t);
  assert.equal(api.illustrations_[0].status, "pending");
  await recallLine(t, api, said); await settle(t);
  assert.equal(api.illustrations_[0].status, "cancelled");
});

test("the end of each small event is drawn where it was played, from its own lines; the next scenario's picture knows what is drawn", async () => {
  const llm = new MockLlm();
  const answer = { "I lower my blade.": [{ type: "narrate", text: "The duel on the pier is over; the stranger yields." }, { type: "event_done", text: "the duel on the pier" }],
    // The scenario change listed first: the event still ends before it.
    "We count the coins.": [{ type: "narrate", text: "The coins glint in the lamplight." }, { type: "advance_scenario", title: "Dawn" }, { type: "event_done", text: "counting the loot" }] };
  llm.director = (user) => {
    const said = user.match(/^NEWEST LINE: Alice Hale: (.*)$/m)?.[1];
    return { actions: answer[said] ?? (said ? [{ type: "narrate", text: `The night answers: ${said}` }] : []), coplayers_may_act: false };
  };
  const { t, api } = await table({ llm, forks: false, cfg: { ...illustrateCfg(), scenarioMinMinutes: 0, scenarioMinLines: 0 } });
  const events = () => llm.calls.filter((c) => c.purpose === "event_illustration").map((c) => c.messages[0].content);
  for (const line of ["I draw my sword on the pier.", "I parry the stranger's blow.", "I lower my blade."]) { await playerSays(t, api, line); await settle(t); }
  await t.illustrating;
  assert.equal(events().length, 1);
  assert.match(events()[0], /^THE EVENT THAT JUST ENDED: the duel on the pier/);
  assert.ok(events()[0].includes("I draw my sword on the pier.") && events()[0].includes("The duel on the pier is over"), "the event's lines, up to its end");
  assert.ok(!events()[0].includes("ALREADY DRAWN"), "nothing drawn yet");
  assert.deepEqual(api.illustrations_.map((j) => [j.window_id, j.prompt]), [["w-main", "[mock event] The duel on the pier is over; the stranger yields."]], "posted where it was played");
  for (const line of ["We open the chest.", "We weigh the gold.", "We count the coins."]) { await playerSays(t, api, line); await settle(t); }
  await t.illustrating;
  assert.equal(events().length, 2);
  assert.ok(events()[1].includes("We open the chest.") && !events()[1].includes("I parry the stranger's blow."), "the next event begins after the last one");
  assert.ok(!events()[1].includes("Dawn"), "and ends before the scenario change");
  assert.match(events()[1], /ALREADY DRAWN IN THIS SCENARIO[^\n]*\n- \[mock event\] The duel on the pier is over/, "it knows what the scenario already has");
  const scenario = llm.calls.filter((c) => c.purpose === "scenario_illustration").map((c) => c.messages[0].content);
  assert.equal(scenario.length, 1);
  assert.match(scenario[0], /ALREADY DRAWN IN THIS SCENARIO[^\n]*\n- \[mock event\] The duel on the pier is over[^\n]*\n- \[mock event\] The coins glint in the lamplight\./, "the scenario picture knows both, the newest one too");
  assert.deepEqual(llm.calls.map((c) => c.purpose).filter((x) => x.endsWith("_illustration")), ["event_illustration", "event_illustration", "scenario_illustration"], "chosen one at a time, in order");
  assert.deepEqual(api.illustrations_.map((j) => j.status), ["completed", "completed", "completed"]);
});

test("pictures dress each character in the outfit that suits the moment; when unsure, in what they wear now", async () => {
  const llm = new MockLlm();
  llm.director = (user) => {
    const said = user.match(/^NEWEST LINE: Alice Hale: (.*)$/m)?.[1] ?? "";
    return { actions: said ? [{ type: "narrate", text: `So it goes: ${said}` }, ...(/leave the ball/.test(said) ? [{ type: "event_done", text: "the ball" }] : [])] : [], coplayers_may_act: false };
  };
  const ATTIRE = { "o-gown": "black silk evening gown, long gloves, pearls", "o-dive": "brass-helmeted diving suit, lead boots" };
  const { t, api } = await table({ llm, forks: false, cfg: illustrateCfg({ maxPerHour: 10 }), before: (a) => {
    // Harriet has two outfits and wears the diving suit now; her line at the ball was written in the gown.
    Object.assign(a.characters_.find((c) => c.id === "c-harriet"), { outfits: [{ id: "o-gown", name: "Evening gown" }, { id: "o-dive", name: "Diving suit" }], outfit_id: "o-dive", outfit_name: "Diving suit" });
    const space = a.characterSpace.bind(a);
    a.characterSpace = async (ch, id) => ({ ...(await space(ch, id)), outfits: id === "c-harriet" ? [{ id: "o-gown", name: "Evening gown", attire: ATTIRE["o-gown"] }, { id: "o-dive", name: "Diving suit", attire: ATTIRE["o-dive"] }] : [] });
  } });
  await playerSays(t, api, "We arrive at the ball."); await settle(t);
  await sayLine(t, api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "player", character_id: "c-harriet", content: "Harriet takes the floor and waltzes.", outfit_id: "o-gown" })); await settle(t);
  // The art director's choice: the gown for Harriet; Alice has no outfits, so naming one for her changes nothing.
  llm.scenarioMoment = () => ({ moment: "Harriet waltzing under the chandeliers", who: ["Harriet Vance", "Alice Hale"], orientation: "landscape", outfits: { "Harriet Vance": "Evening gown", "Alice Hale": "Evening gown" }, why: "the waltz" });
  await playerSays(t, api, "We leave the ball."); await settle(t); await t.illustrating;
  const ask = llm.calls.find((c) => c.purpose === "event_illustration");
  assert.match(ask.system, /Some characters have outfits[\s\S]*leave the character out of "outfits": they are drawn in what they wear now/);
  assert.match(ask.messages[0].content, /^OUTFITS:\n- Harriet Vance \(wears now: "Diving suit"; in these lines: "Evening gown"\): "Evening gown" — black silk evening gown, long gloves, pearls; "Diving suit" — brass-helmeted diving suit, lead boots; usual clothes$/m);
  assert.deepEqual(api.illustrations_.map((j) => j.outfits), [{ "c-harriet": "o-gown" }], "the gown, by its id; Alice as she is");
  // The GM sees the outfits in the cast, and may dress its own picture too; the outfit worn now, or a name that is no
  // outfit of hers, sends nothing: she is drawn in what she wears.
  assert.match(llm.calls.filter((c) => c.purpose === "director").at(-1).messages[0].content, /- Harriet Vance[\s\S]*?\n {4}outfits: "Evening gown", "Diving suit", or their usual clothes; wears "Diving suit" now/);
  for (const outfits of [{ "Harriet Vance": "usual clothes" }, { "Harriet Vance": "Diving suit" }, { "Harriet Vance": "Tuxedo" }]) await t.illustrateMoment("w-main", { text: "Harriet on the pier", who: ["Harriet Vance"], outfits });
  assert.deepEqual(api.illustrations_.slice(1).map((j) => j.outfits), [{ "c-harriet": "" }, undefined, undefined]);
  // Without outfits at the table, the art director is told nothing of them.
  const plain = await table({ llm: new MockLlm(), forks: false, cfg: illustrateCfg() });
  plain.llm.director = llm.director;
  for (const l of ["We arrive at the ball.", "We dance.", "We leave the ball."]) { await playerSays(plain.t, plain.api, l); await settle(plain.t); }
  await plain.t.illustrating;
  const bare = plain.llm.calls.find((c) => c.purpose === "event_illustration");
  assert.ok(bare && !/outfits|OUTFITS/.test(bare.system + bare.messages[0].content));
});

test("an event's picture: none for a short event, none past the hourly cap, and a rolled-back turn's picture is not drawn", async () => {
  const llm = new MockLlm();
  llm.director = (user) => {
    const said = user.match(/^NEWEST LINE: Alice Hale: (.*)$/m)?.[1] ?? "";
    return { actions: said ? [{ type: "narrate", text: `So it goes: ${said}` }, ...(/done/.test(said) ? [{ type: "event_done", text: said }] : [])] : [], coplayers_may_act: false };
  };
  const { t, api } = await table({ llm, forks: false, cfg: illustrateCfg({ maxPerHour: 1 }) });
  for (const l of ["We meet the captain.", "We bargain."]) { await playerSays(t, api, l); await settle(t); }
  await playerSays(t, api, "First event done."); await settle(t); await t.illustrating;
  assert.equal(api.illustrations_?.length ?? 0, 1, "the first event is drawn");
  await playerSays(t, api, "A short one, done."); await settle(t); await t.illustrating;
  assert.equal(api.illustrations_.length, 1, "two lines are too short for a picture");
  for (const l of ["We walk on.", "We talk.", "We arrive."]) { await playerSays(t, api, l); await settle(t); }
  await playerSays(t, api, "Second event done."); await settle(t); await t.illustrating;
  assert.equal(api.illustrations_.length, 1, "the hourly cap holds");
  // A recall rolls back the turn that ended an event: its picture is not asked for.
  const later = await table({ llm, forks: false, cfg: illustrateCfg() });
  for (const l of ["We walk on.", "We talk.", "We arrive."]) { await playerSays(later.t, later.api, l); await settle(later.t); }
  let open;
  const gate = new Promise((r) => (open = r)), complete = llm.complete.bind(llm);
  llm.complete = async (req) => { if (req.purpose === "event_illustration") await gate; return complete(req); };
  const said = lineSaid(later.api, "The meeting is done.");
  await sayLine(later.t, said); await settle(later.t);
  await recallLine(later.t, later.api, said); await settle(later.t);
  open(); await later.t.illustrating;
  assert.equal(later.api.illustrations_?.length ?? 0, 0, "the rolled-back event's picture is never drawn");
});

// ---- pictures of past plots, asked for in the planner window
const AURORA = "Green light ripples over the bay as the aurora wakes above the lighthouse.";
const artCfg = (over = {}) => ({ ...pcfg(), ...illustrateCfg(over), historyBackfillLines: 10, contextLines: 20 });
const inPlanner = (t, api, content, who = "alice") => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch",
  message: api.add({ chat_window_id: t.planner.window, author_id: `u-${who}`, author_name: who, author_role: "player", character_id: `c-${who}`, content }) });
const plannerPosts = (t, api) => api.posts.filter((p) => p.window === t.planner.window && p.content.startsWith("🎨")).map((p) => p.content);

test("a player asks the planner window for a picture of a past plot: found however long ago, drawn there at once, never the planner's", async () => {
  // The aurora was long ago: before the oldest line the table keeps, in the scenario it began.
  const { t, api, llm } = await table({ heal: true, forks: false, cfg: artCfg(), before: (a) => {
    a.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: AURORA });
    for (let i = 0; i < 60; i++) a.add({ chat_window_id: "w-main", author_id: "u-alice", author_role: "player", character_id: "c-alice", content: `Filler ${i}: we talk about the weather.` });
  } });
  assert.ok(!t.history.lines("w-main").some((m) => m.content === AURORA), "not in the local copy");
  const turns = t.turns;
  await inPlanner(t, api, "/draw the aurora above the lighthouse, as a watercolour");
  assert.equal(t.turns, turns, "no turn is played");
  assert.equal(t.planner.inbox.length, 0, "the planner never gets it");
  assert.match(llm.calls.find((c) => c.purpose === "plot_search").messages[0].content, /^ENTRIES:\nS1 \[scenario "The study"\][^\n]*\nR1 \[play in "Main Chat", #\d+–#\d+\] /m, "an index of the story to choose from");
  const asked = llm.calls.find((c) => c.purpose === "plot_illustration").messages[0].content;
  assert.match(asked, /THE PLAYER'S REQUEST: the aurora above the lighthouse, as a watercolour/);
  assert.ok(asked.includes(AURORA) && asked.includes("Filler 0:"), "the lines around it, read from the platform");
  assert.deepEqual(api.illustrations_.map((j) => [j.window_id, j.prompt.slice(0, 40), j.status]), [[t.planner.window, `[mock picture] ${AURORA}`.slice(0, 40), "completed"]]);
  assert.deepEqual(plannerPosts(t, api), ["🎨 Looking for that moment in the story; the picture will appear here when it is drawn."]);
  assert.ok(api.lines.some((m) => m.chat_window_id === t.planner.window && m.media_asset_id), "the picture is posted in the planner window");
  assert.match(api.posts.find((p) => p.window === t.planner.window && p.content.startsWith("🧭")).content, /Send \/draw \(or \/画\) and a moment from earlier play/, "the window says how");
  // Neither the GM nor the planner reads the command, the reply or the picture.
  for (const m of api.lines.filter((x) => x.chat_window_id === t.planner.window)) t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: m });
  await planned(t, api);
  const read = [...directorCalls(llm), ...plannerCalls(llm).map((c) => c.messages.map((m) => m.content).join("\n"))];
  assert.ok(read.length && read.every((u) => !u.includes("/draw the aurora") && !u.includes("🎨") && !u.includes("[mock picture]")));
});

test("a picture request while the GM has illustrations off is answered at once, and costs nothing", async () => {
  const { t, api, llm } = await table({ heal: true, forks: false, cfg: artCfg(), before: (a) => { a.channelIllustrations = false; } });
  await inPlanner(t, api, "/draw the aurora above the lighthouse");
  assert.deepEqual(plannerPosts(t, api), ["🎨 Picture requests are turned off for this table."]);
  assert.equal(llm.calls.filter((c) => c.purpose === "plot_search" || c.purpose === "plot_illustration").length, 0);
  assert.equal(api.illustrations_?.length ?? 0, 0);
});

test("a picture request searches by meaning: summaries and recent play, a zoom into a long stretch, and the next entry when the first holds nothing", async () => {
  const pad = " The rain keeps falling on the slate roofs while we wait and talk of tides, of debts, of the old harbour master's stubborn silence.";
  const llm = new MockLlm();
  const { t, api } = await table({ llm, heal: true, forks: false, cfg: { ...pcfg(), ...illustrateCfg() }, before: (a) => {
    for (let i = 0; i < 300; i++) a.add({ chat_window_id: "w-main", author_id: "u-alice", author_role: "player", character_id: "c-alice",
      content: i === 150 ? "Harriet lifts the lantern and green light ripples across the bay." : `Line ${i}:${pad}` });
    for (const l of ["We dry our coats by the fire.", "We say little.", "We sleep."]) a.add({ chat_window_id: "w-main", author_id: "u-alice", author_role: "player", character_id: "c-alice", content: l });
  } });
  const night = api.lines.filter((m) => /^Line \d+:|lantern/.test(m.content));
  t.store.addChapter({ scope: "gm", windowId: "w-main", fromSeq: night[0].seq, toSeq: night.at(-1).seq, level: 1, text: "Through a long wet night at the harbour, Harriet showed the others the lights over the bay." });
  // The model's reading, by meaning: no entry shares a word with "lantern", yet the summary is the night it means.
  llm.plotChoose = (user) => (user.includes("PARTS:")
    ? { entries: [user.match(/^(P\d+) \[[^\]]*\][^\n]*green light/m)?.[1]].filter(Boolean), why: "the lights" }
    : { entries: ["R1", "C1"], why: "the night by the bay, or just after" });
  await inPlanner(t, api, "/draw Harriet's lantern over the bay");
  const searches = llm.calls.filter((c) => c.purpose === "plot_search").map((c) => c.messages[0].content);
  assert.match(searches[0], /^C1 \[summary of earlier play in "Main Chat"\] Through a long wet night at the harbour/m);
  assert.match(searches[0], /^R1 \[play in "Main Chat", #\d+–#\d+\] [^\n]*We dry our coats by the fire\./m, "recent play since the summary, shortened");
  assert.ok(!/^R\d+ [^\n]*Line 1:/m.test(searches[0]), "summarised play is not repeated in full");
  const picks = llm.calls.filter((c) => c.purpose === "plot_illustration").map((c) => c.messages[0].content);
  assert.equal(picks.length, 2, "the first entry held nothing; the second was read");
  assert.ok(picks[0].includes("We dry our coats") && !picks[0].includes("green light"));
  assert.match(searches[1], /^PARTS:/m, "the summary's night was too long to read whole: zoomed in");
  assert.ok(picks[1].includes("green light ripples") && !picks[1].includes("Line 0:") && !picks[1].includes("Line 299:"), "only the part that holds it, with a few lines around");
  assert.deepEqual(api.illustrations_.map((j) => [j.window_id, j.prompt]), [[t.planner.window, "[mock picture] Harriet lifts the lantern and green light ripples across the bay."]]);
});

test("a picture request: any scene, never a whisper; a hint when empty, one at a time and capped per hour, and no resumption of a paused table", async () => {
  const { t, api, llm } = await table({ heal: true, forks: false, bob: true, cfg: artCfg({ requestsPerHour: 2 }), before: (a) => {
    a.add({ chat_window_id: "w-priv", author_id: "u-alice", author_role: "player", character_id: "c-alice", content: "I find the brass astrolabe hidden behind the portrait." });
    a.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "Only you hear the violin playing under the floorboards.", visibility: "whisper", whisper_to: ["c-bob"] });
  } });
  // Bob is no member of Alice's window, and may still have her scene drawn; a whisper is never drawn, even for him.
  await inPlanner(t, api, "/draw the astrolabe behind the portrait", "bob");
  await inPlanner(t, api, "/画", "bob");
  await inPlanner(t, api, "/draw the violin under the floorboards", "bob");
  await inPlanner(t, api, "/draw the violin once more", "bob");
  assert.deepEqual(api.illustrations_.map((j) => [j.window_id, j.prompt]), [[t.planner.window, "[mock picture] I find the brass astrolabe hidden behind the portrait."]]);
  const notFound = "🎨 I could not find that moment in the story. Add a detail or two: who was there, where it was, what happened.";
  assert.deepEqual(plannerPosts(t, api).filter((c) => !c.startsWith("🎨 Looking")), [
    "🎨 Write what to draw after the command, for example: /draw the moment we reached the lighthouse at dusk",
    notFound,
    "🎨 That is 2 pictures in the last hour; please ask again a little later.",
  ], "an empty command costs nothing; the third request is over the cap");
  assert.ok(llm.calls.filter((c) => c.purpose.startsWith("plot_")).every((c) => !c.messages[0].content.includes("Only you hear the violin")), "the whisper reached neither the search nor a picture");
  // Asked while the table is paused, a picture is drawn, and play stays paused.
  await inPlanner(t, api, "/pause");
  assert.equal(t.generation.paused, true);
  await inPlanner(t, api, "/draw the astrolabe behind the portrait");
  assert.equal(t.generation.paused, true, "a picture request is no play");
  assert.equal(api.illustrations_.length, 2);
  // While a request is on its way, the same player's next one is turned away.
  let open;
  const gate = new Promise((r) => (open = r)), complete = llm.complete.bind(llm);
  llm.complete = async (req) => { if (req.purpose === "plot_search") await gate; return complete(req); };
  const first = inPlanner(t, api, "/draw the astrolabe behind the portrait");
  await inPlanner(t, api, "/draw the astrolabe behind the portrait");
  assert.equal(plannerPosts(t, api).at(-1), "🎨 Your previous picture is still on its way; ask again once it has arrived.");
  open(); await first;
  assert.deepEqual(api.illustrations_.map((j) => j.status), ["completed", "completed", "completed"]);
  assert.equal(llm.calls.filter((c) => c.purpose === "director").length, 0, "no GM turn at any point");
});

