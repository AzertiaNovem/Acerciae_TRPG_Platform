// Interactive messages (docs/HYPERTEXT.md) as this client posts them: the declarative builders (src/hypertext.mjs),
// the roll card a GM's request_roll becomes for a person's character, its fallback on a platform without cards, closing
// it when the roll arrives, and how lines a card produced count and read for the models.
import test from "node:test";
import assert from "node:assert/strict";
import { Table } from "../src/loop.mjs";
import { Roster } from "../src/roles/roster.mjs";
import { MockLlm } from "../src/llm/mock.mjs";
import { buildConfig } from "../src/config.mjs";
import { renderLine } from "../src/context/coplayerContext.mjs";
import { rollRequest, choice, checklist, cardProblems, cleanText, diceVerdict, rollSignature, cardStrings, cpLength, LIMITS } from "../src/hypertext.mjs";
import { FakeApi } from "./fixtures/platform.mjs";

async function setup({ hypertext = true, llm = new MockLlm(), cfg: over = {} } = {}) {
  const api = new FakeApi(), clock = { now: 1_700_000_000_000 }, logs = [];
  api.hypertext = hypertext;
  const add = api.add.bind(api); api.add = (m) => add({ created_at: new Date(clock.now).toISOString(), ...m });
  const cfg = Object.assign(buildConfig({}, {}, { data: {} }), { debounceMs: 0, postDelayMs: 0, ...over });
  cfg.planner.enabled = false; cfg.illustrations.enabled = false;
  const saved = [];
  const t = await new Table({ api, cfg, llm, roster: new Roster(), channelId: "ch", now: () => clock.now, sleep: async () => {},
    persist: (table) => saved.push([...table.rollCards.values()]), log: (s) => { logs.push(s); if (process.env.TEST_LOG) console.log(s); } }).init();
  const line = (m) => api.add({ channel_id: "ch", chat_window_id: "w-main", author_id: "u-alice", author_role: "player", character_id: "c-alice", kind: "ic", ...m });
  return { t, api, llm, clock, logs, saved, line };
}
const event = (t, message) => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message });
const ask = (t, extra = {}) => t.requestRoll("w-main", { type: "request_roll", who: "Alice Hale", command: ".ra Library Use", text: "Alice, the shelves.", ...extra });

// ---- the builders

test("a roll card: the narration, one button posting the command as the player's roll, for that character only", () => {
  const body = rollRequest({ text: "The study is dark.", command: ".ra Spot Hidden", pcId: "c-ada", name: "Ada", language: "English" });
  assert.deepEqual(body, {
    content: "The study is dark.\n→ Ada: .ra Spot Hidden",
    hypertext: {
      v: 1, title: "Roll for Ada",
      state: { done: { type: "bool" } },
      body: [
        { type: "text", text: "The study is dark." },
        { type: "button", id: "roll", label: "Roll Spot Hidden", act: { say: ".ra Spot Hidden", set: { done: true } }, enable_if: { key: "done", eq: false } },
      ],
      actors: ["c-ada"],
      runs_per_viewer: 1,
    },
  });
  assert.ok(!JSON.stringify(body).includes("script"), "no builder ever writes a script");
  // The caller's own fallback line wins; without narration there is no text node.
  const bare = rollRequest({ command: "。ra 侦查", pcId: "c-ada", name: "Ada", language: "Simplified Chinese", content: "→ Ada: 。ra 侦查" });
  assert.equal(bare.content, "→ Ada: 。ra 侦查");
  assert.deepEqual(bare.hypertext.body.map((n) => n.type), ["button"]);
  assert.equal(bare.hypertext.title, "Ada 的检定");
  assert.equal(bare.hypertext.body[0].label, "检定：侦查");
  assert.equal(rollRequest({ command: ".r 1d100", pcId: "x", language: "zh-TW" }).hypertext.body[0].label, "檢定：1d100");
  assert.equal(rollRequest({ command: ".ri +2", pcId: "x", language: "Japanese" }).hypertext.body[0].label, "Roll initiative", "English for other languages");
  assert.equal(rollRequest({ command: ".sc 1/1d6", pcId: "x" }).hypertext.body[0].label, "Sanity check 1/1d6");
  assert.equal(rollRequest({ command: ".ds", pcId: "x" }).hypertext.body[0].label, "Death saving throw");
  assert.equal(cardStrings("zh-Hant"), cardStrings("Traditional Chinese"));
  assert.equal(cardStrings("zh"), cardStrings("Simplified Chinese"));
  assert.equal(cardStrings(undefined), cardStrings("English"));
});

test("a roll card is only made for a command a card may post as the clicker", () => {
  for (const command of [".st STR 50", ".ri Bob", ".ri +2 Goblin", ".ss", ".en Spot Hidden", ".init", "look around", ".ra a\n.ra b", ".ra {{x}}", ""]) {
    assert.equal(rollRequest({ command, pcId: "c-ada", name: "Ada" }), null, JSON.stringify(command));
  }
  assert.equal(rollRequest({ command: ".ra Spot Hidden" }), null, "a card for nobody");
  for (const command of [".ra Spot Hidden", ".rc Listen", ".rah Spot Hidden", ".r 1d100", ".rd6", ".ri", ".ri +2 adv", ".sc 1/1d6", ".ds"]) {
    assert.ok(rollRequest({ command, pcId: "c-ada" }), command);
  }
  assert.equal(diceVerdict(".sc 1/1d6"), "confirm");
  assert.equal(diceVerdict("I look."), "none");
});

test("text from the model is cleaned and cut by code points to the card rules", () => {
  const long = "🜲".repeat(3000), name = "N".repeat(200);
  const body = rollRequest({ text: `${long}`, command: `.ra ${"Very Long Skill Name ".repeat(10).trim()}`, pcId: "c", name });
  const [text, button] = body.hypertext.body;
  assert.equal(cpLength(text.text), LIMITS.text);
  assert.ok(text.text.endsWith("…"));
  assert.ok(cpLength(button.label) <= LIMITS.button, button.label);
  assert.ok(cpLength(body.hypertext.title) <= LIMITS.title);
  assert.ok(cpLength(body.content) <= LIMITS.content);
  assert.deepEqual(cardProblems(body), []);
  // Placeholders, bidi controls, other control characters and lone surrogates never reach a card.
  assert.equal(cleanText("a{{b}}\u202Ec\td\u0007e\n f\ud800"), "a{ {b}}c de f");
  assert.equal(cleanText("one\n\n\n\ntwo  three", { multiline: true }), "one\n\ntwo three");
  assert.equal(cleanText("   ", { max: 10 }), "");
  const sneaky = rollRequest({ text: "{{done}} \u2066fake\u2069 {{", command: ".ra Spot Hidden", pcId: "c", name: "A{{b}}" });
  assert.deepEqual(cardProblems(sneaky), []);
  assert.ok(!sneaky.hypertext.body[0].text.includes("{{"));
  // The fallback is never a dot command (the platform refuses one as content).
  const command = rollRequest({ text: ".ra Spot Hidden", command: ".ra Spot Hidden", pcId: "c", name: "Ada" });
  assert.equal(command.content, "→ .ra Spot Hidden\n→ Ada: .ra Spot Hidden");
});

test("a choice: 2 to 20 distinct options, picked privately and answered once as the reader's own line", () => {
  const body = choice({ prompt: "Where now?", options: ["the lighthouse", "the harbour", "The Harbour", " ", "the inn"], actorIds: ["c-a", "c-b", "c-a"], language: "English" });
  assert.deepEqual(body.hypertext.state.pick.values, [{ value: "o1", label: "the lighthouse" }, { value: "o2", label: "the harbour" }, { value: "o3", label: "the inn" }]);
  assert.deepEqual(body.hypertext.actors, ["c-a", "c-b"]);
  assert.equal(body.content, "Where now?\nthe lighthouse / the harbour / the inn");
  const [prompt, pick, go] = body.hypertext.body;
  assert.deepEqual(prompt, { type: "text", text: "Where now?" });
  assert.deepEqual(pick, { type: "choice", id: "options", bind: "pick", display: "buttons", enable_if: { key: "done", eq: false } });
  assert.deepEqual(go.act, { say: "I choose: {{pick}}", say_kind: "ooc", set: { done: true } });
  assert.deepEqual(go.enable_if, { all: [{ key: "done", eq: false }, { not: { key: "pick", empty: true } }] });
  assert.equal(body.hypertext.runs_per_viewer, 1);
  assert.deepEqual(cardProblems(body), []);
  assert.equal(choice({ prompt: "?", options: ["only one"] }), null);
  assert.equal(choice({ options: ["same", "SAME"] }), null);
  const many = choice({ prompt: "Pick", options: Array.from({ length: 30 }, (_, i) => `${i} ${"x".repeat(150)}`), language: "Simplified Chinese", kind: "ic" });
  assert.equal(many.hypertext.state.pick.values.length, LIMITS.options);
  assert.ok(many.hypertext.state.pick.values.every((v) => cpLength(v.label) <= LIMITS.label));
  assert.equal(many.hypertext.body[1].display, "list");
  assert.equal(many.hypertext.title, "请选择");
  assert.deepEqual(many.hypertext.body[2].act, { say: "我选择：{{pick}}", say_kind: "ic", set: { done: true } });
  assert.ok(!("actors" in many.hypertext), "every reader may answer");
  assert.deepEqual(cardProblems(many), []);
  assert.ok(JSON.stringify(many).length < 32 * 1024);
});

test("a checklist: one box per item, at most 30, nothing posted; 'All done.' only while a condition can hold them all", () => {
  const body = checklist({ title: "Before you descend", items: ["Lamp oil", "Rope", "The surveyor's map"], language: "English" });
  assert.deepEqual(body, {
    hypertext: {
      v: 1, title: "Before you descend",
      state: { i1: { type: "bool" }, i2: { type: "bool" }, i3: { type: "bool" } },
      body: [
        { type: "checkbox", id: "c1", label: "Lamp oil", bind: "i1" },
        { type: "checkbox", id: "c2", label: "Rope", bind: "i2" },
        { type: "checkbox", id: "c3", label: "The surveyor's map", bind: "i3" },
        { type: "text", text: "All done.", tone: "good", show_if: { all: [{ key: "i1", eq: true }, { key: "i2", eq: true }, { key: "i3", eq: true }] } },
      ],
    },
  });
  assert.equal(checklist({ items: ["one"], language: "Simplified Chinese" }).hypertext.title, "清单");
  assert.deepEqual(checklist({ items: ["one"] }).hypertext.body[1].show_if, { key: "i1", eq: true });
  const nine = checklist({ items: Array.from({ length: 9 }, (_, i) => `item ${i}`) });
  assert.ok(nine.hypertext.body.every((n) => n.type === "checkbox"), "nine leaves are more than a condition takes");
  const big = checklist({ items: Array.from({ length: 100 }, (_, i) => `${i} ${"é".repeat(130)}`) });
  assert.equal(Object.keys(big.hypertext.state).length, LIMITS.items);
  assert.ok(big.hypertext.body.length <= LIMITS.nodes && Object.keys(big.hypertext.state).length <= LIMITS.stateKeys);
  assert.deepEqual(cardProblems(big), []);
  assert.equal(checklist({ items: [] }), null);
});

test("the card check catches what the platform would refuse", () => {
  const ok = rollRequest({ command: ".ra Spot Hidden", pcId: "c" });
  const broken = structuredClone(ok);
  broken.hypertext.script = "on('roll', () => {})";
  broken.hypertext.body[0].id = "constructor";
  broken.hypertext.body[0].label = "x".repeat(61);
  broken.hypertext.body[0].act.say = ".st STR 90";
  broken.content = ".ra Spot Hidden";
  const problems = cardProblems(broken).join("\n");
  for (const p of ["hypertext.script", "hypertext.body[0].id", "hypertext.body[0].label", "hypertext.body[0].act.say", "content"]) assert.ok(problems.includes(p), p);
  assert.equal(rollSignature(".rc spot hidden 60"), rollSignature("。rah Spot Hidden +10"));
  assert.notEqual(rollSignature(".ra Spot Hidden"), rollSignature(".ra Listen"));
  assert.equal(rollSignature("hello"), null);
});

// ---- the table

test("request_roll for a person's character posts a roll card in their scene; a co-player still rolls itself", async () => {
  const { t, api } = await setup();
  assert.equal(await ask(t), 1);
  assert.equal(api.posts.length, 0, "no plain line");
  const [card] = api.hypertextPosts;
  assert.equal(card.window, "w-main");
  assert.equal(card.visibility, "window");
  assert.equal(card.content, "Alice, the shelves.\n→ Alice Hale: .ra Library Use");
  assert.deepEqual(card.hypertext.actors, ["c-alice"]);
  assert.deepEqual(card.hypertext.body.at(-1).act, { say: ".ra Library Use", set: { done: true } });
  const m = api.lines.at(-1);
  assert.equal(m.kind, "hypertext");
  assert.ok(t.botMessageIds.has(m.id) && !t.isHuman(m), "the card is this client's own line");
  assert.deepEqual([...t.rollCards.values()].map((c) => [c.id, c.windowId, c.pcId, c.command]), [[m.id, "w-main", "c-alice", ".ra Library Use"]]);
  // Harriet is a co-player: the client rolls for her, against her sheet, with no card.
  await t.requestRoll("w-main", { type: "request_roll", who: "Harriet Vance", command: ".ra Spot Hidden", text: "Harriet, look around." });
  assert.equal(api.hypertextPosts.length, 1);
  assert.deepEqual(api.posts.map((p) => [p.kind, p.content, p.character_id ?? null]), [["narration", "Harriet, look around.", null], ["ic", ".ra Spot Hidden", "c-harriet"]]);
});

test("asking for the same roll again replaces the open card; a different roll keeps its own", async () => {
  const { t, api } = await setup();
  await ask(t);
  const first = api.lines.at(-1).id;
  await ask(t, { command: ".ra Spot Hidden" });
  assert.deepEqual(api.closedCards ?? [], []);
  await ask(t, { command: ".rc library use", text: "Again, the shelves." });
  assert.deepEqual(api.closedCards, [first], "the earlier Library Use card is closed");
  assert.equal(t.rollCards.size, 2);
});

for (const [label, error] of [["404 (an older platform)", { status: 404, code: "" }], ["405", { status: 405, code: "" }], ["403 feature_disabled", { status: 403, code: "feature_disabled" }]]) {
  test(`a platform without cards (${label}): today's line instead, and no card is tried again; role cards untouched`, async () => {
    const { t, api, logs } = await setup({ hypertext: false });
    if (error.status !== 404) api.hypertextError = error;
    const sheet = { skills: { "Library Use": 70 } };
    t.cards.set("c-alice", sheet);
    const cards = t.cards;
    assert.equal(await ask(t), 1);
    assert.equal(t.hypertextSupported, false);
    assert.deepEqual(api.posts.map((p) => [p.window, p.kind, p.content]), [["w-main", "narration", "Alice, the shelves.\n→ Alice Hale: .ra Library Use"]]);
    assert.equal(t.cards, cards); assert.equal(t.cards.get("c-alice"), sheet); assert.equal(t.cards.size, 1);
    assert.equal(t.rollCards.size, 0);
    assert.equal(logs.filter((l) => l.includes("interactive messages are unavailable")).length, 1);
    await ask(t, { command: ".ra Spot Hidden" });
    assert.equal(api.hypertextPosts.length, 1, "straight to the line");
    assert.equal(api.posts.at(-1).content, "Alice, the shelves.\n→ Alice Hale: .ra Spot Hidden");
  });
}

test("a card the platform refuses for another reason falls back once, and the next is tried again", async () => {
  const { t, api, logs } = await setup();
  api.hypertextError = { status: 400, code: "invalid_hypertext", data: { error: "invalid_hypertext", errors: [{ path: "hypertext.body[1].label", message: "must be at most 60 code points" }] } };
  assert.equal(await ask(t), 1);
  assert.equal(t.hypertextSupported, true);
  assert.equal(api.posts.at(-1).content, "Alice, the shelves.\n→ Alice Hale: .ra Library Use");
  assert.ok(logs.some((l) => l.includes("interactive message failed (invalid_hypertext)") && l.includes("hypertext.body[1].label")));
  delete api.hypertextError;
  await ask(t);
  assert.equal(api.hypertextPosts.length, 2);
  assert.equal(api.lines.at(-1).kind, "hypertext");
});

test("the card closes when its roll arrives: tapped (via the card) or typed by the same character", async () => {
  const { t, api, saved, line } = await setup();
  await ask(t);
  const card = api.lines.at(-1);
  assert.deepEqual(saved.at(-1).map((c) => c.id), [card.id], "open cards are kept in the state file");
  // Another character's roll, or another roll, answers nothing.
  await event(t, line({ kind: "roll", content: ".ra Library Use", character_id: "c-harriet", author_id: "u-bot" }));
  await event(t, line({ kind: "roll", content: ".ra Spot Hidden" }));
  assert.deepEqual(api.closedCards ?? [], []);
  // The player taps the button: the platform posts the roll as Alice, from the card.
  await event(t, line({ kind: "roll", content: ".ra Library Use", via_hypertext_id: card.id, via_user_id: "u-alice", dice: { text: "Alice rolled 12/70" } }));
  assert.deepEqual(api.closedCards, [card.id]);
  assert.equal(t.rollCards.size, 0);
  assert.deepEqual(saved.at(-1), []);
  // Typed by hand, in another form of the same roll.
  await ask(t, { command: ".ra Spot Hidden" });
  const second = api.lines.at(-1);
  await event(t, line({ kind: "roll", content: "。rch spot hidden 60", dice: { text: "Alice rolled 40/60" } }));
  assert.deepEqual(api.closedCards, [card.id, second.id]);
  assert.equal(t.rollCards.size, 0);
});

test("closing a card that fails is logged, never thrown; a recalled card is forgotten", async () => {
  const { t, api, logs, line } = await setup();
  await ask(t);
  const card = api.lines.at(-1);
  api.closeError = { status: 404, code: "not_found" };
  await assert.doesNotReject(event(t, line({ kind: "roll", content: ".ra Library Use", via_hypertext_id: card.id, via_user_id: "u-alice" })));
  assert.ok(logs.some((l) => l.includes("closing the roll card for Alice Hale (.ra Library Use) failed (not_found)")));
  delete api.closeError;
  await ask(t, { command: ".ra Listen" });
  const listen = api.lines.at(-1);
  await t.onEvent({ stream: "chat", type: "message.recalled", channel_id: "ch", message: { ...listen, content: "", recalled_at: "2026-11-14T00:00:00Z" } });
  assert.equal(t.rollCards.size, 0);
});

test("restarted, the table still knows its open roll cards", async () => {
  const { t, api, saved, line } = await setup();
  await ask(t);
  const card = api.lines.at(-1);
  const again = new Table({ api, cfg: t.cfg, llm: new MockLlm(), roster: new Roster(), channelId: "ch", rollCards: saved.at(-1), sleep: async () => {} });
  await again.init();
  assert.equal(again.rollCards.size, 1);
  await event(again, line({ kind: "roll", content: ".rc Library Use" }));
  assert.deepEqual(api.closedCards, [card.id]);
});

test("a GM's request_roll turn: the card is posted, the tap closes it and starts the next turn, which reads it as such", async () => {
  const llm = new MockLlm();
  let asked = false;
  llm.director = () => (asked ? { actions: [{ type: "narrate", text: "The catalogue gives up its secret." }], coplayers_may_act: false }
    : (asked = true, { actions: [{ type: "request_roll", who: "Alice Hale", command: ".ra Library Use", text: "Check the catalogue first." }], coplayers_may_act: false }));
  llm.coplayer = () => ({ action: "pass" });
  const { t, api, line } = await setup({ llm });
  await event(t, line({ content: "I search the shelves." }));
  for (let i = 0; i < 30 && t.pending; i++) { await new Promise((r) => setTimeout(r, 2)); await t.queue; }
  const card = api.lines.find((m) => m.kind === "hypertext");
  assert.ok(card, "the roll is asked for with a card");
  await event(t, line({ kind: "roll", content: ".ra Library Use", via_hypertext_id: card.id, via_user_id: "u-alice", dice: { text: "Alice rolled 12/70: Hard success" } }));
  for (let i = 0; i < 30 && t.pending; i++) { await new Promise((r) => setTimeout(r, 2)); await t.queue; }
  assert.deepEqual(api.closedCards, [card.id]);
  const prompts = llm.calls.filter((c) => c.purpose === "director").map((c) => c.messages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n"));
  const last = prompts.at(-1);
  assert.match(last, /#\d+ GM \(interactive message\) \[timeline: Main story\]: Check the catalogue first\. → Alice Hale: \.ra Library Use\n/);
  assert.match(last, /#\d+ Alice Hale \(via interactive message\) \[timeline: Main story\]: \.ra Library Use → Alice rolled 12\/70/);
  assert.ok(!last.includes('"act"') && !last.includes("enable_if"), "the card's document never reaches the model");
  assert.ok(api.posts.some((p) => p.content === "The catalogue gives up its secret."), "the tap started the GM's next turn");
});

// ---- lines a card produced

test("a card's reply posted as this account counts as the reader's who acted; the client's own lines do not", async () => {
  const { t } = await setup();
  const reply = { id: "r1", seq: 50, channel_id: "ch", chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", visibility: "window", content: "The door groans open.", via_hypertext_id: "card1", via_user_id: "u-alice", via_user_name: "alice" };
  assert.equal(t.isHuman(reply), true);
  assert.equal(t.isTrigger(reply), true, "a window line from a reader's action wakes the table");
  assert.equal(t.isHuman({ ...reply, via_user_id: "u-bot" }), false, "the client acting on its own card");
  assert.equal(t.isHuman({ ...reply, via_hypertext_id: null, via_user_id: null }), false);
  assert.equal(t.playerSpeech(reply), false, "a reply is the GM account's line, not a player's speech");
  const say = { ...reply, id: "r2", author_id: "u-alice", author_role: "player", character_id: "c-alice", kind: "ic", content: "I head for the harbour." };
  assert.equal(t.isHuman(say), true); assert.equal(t.isTrigger(say), true);
  for (const visibility of ["whisper", "gm_only"]) {
    assert.equal(t.isTrigger({ ...say, visibility, whisper_to: visibility === "whisper" ? ["c-alice"] : [] }), false, `a ${visibility} via line does not trigger`);
    assert.equal(t.isTrigger({ ...reply, visibility }), false);
  }
  const othersCard = { ...reply, id: "r3", author_id: "u-gm2", kind: "hypertext", via_hypertext_id: null, via_user_id: null, content: "Where now?" };
  assert.equal(t.isTrigger(othersCard), false, "a card never wakes the table");
  assert.equal(t.playerSpeech(othersCard), false);
});

test("another GM account's card is read but starts no turn", async () => {
  const llm = new MockLlm();
  const { t, line } = await setup({ llm });
  await event(t, line({ author_id: "u-gm2", author_role: "gm", character_id: null, kind: "hypertext", content: "Where now?\nthe lighthouse / the inn", hypertext: { v: 1, body: [] } }));
  for (let i = 0; i < 30 && t.pending; i++) { await new Promise((r) => setTimeout(r, 2)); await t.queue; }
  assert.equal(llm.calls.filter((c) => c.purpose === "director").length, 0);
  assert.ok(t.history.lines("w-main").some((m) => m.kind === "hypertext"), "it is in the table's record");
});

test("renderLine tags cards and the lines they produced, from their plain text only", () => {
  const base = { id: "m1", seq: 7, chat_window_id: "w-main", visibility: "window", author_role: "gm", author_id: "u-bot" };
  const card = renderLine({ ...base, kind: "hypertext", content: "The study is dark.\n→ Ada: .ra Spot Hidden", hypertext: { v: 1, title: "SECRET-TITLE", script: "SECRET-SCRIPT", body: [] } });
  assert.equal(card, "#7 GM (interactive message): The study is dark. → Ada: .ra Spot Hidden");
  const via = { ...base, author_role: "player", author_id: "u-ann", character_name: "Ada", via_hypertext_id: "m1", via_user_id: "u-ann", via_user_name: "ann" };
  assert.equal(renderLine({ ...via, kind: "roll", content: ".ra Spot Hidden", dice: { text: "Ada rolled 30/60" } }), "#7 Ada (via interactive message): .ra Spot Hidden → Ada rolled 30/60");
  assert.equal(renderLine({ ...via, kind: "ooc", content: "I choose: the inn" }), "#7 Ada (out of character) (via interactive message): I choose: the inn");
  const reply = { ...base, kind: "narration", content: "Behind the frame: a brass key.", via_hypertext_id: "m1", via_user_id: "u-ann", via_user_name: "ann" };
  assert.equal(renderLine(reply, { gm: "Keeper" }), "#7 Keeper (narration) (via interactive message) (answering ann): Behind the frame: a brass key.");
  assert.equal(renderLine({ ...reply, via_user_name: null }), "#7 GM (narration) (via interactive message) (answering a player): Behind the frame: a brass key.");
  assert.equal(renderLine({ ...base, kind: "narration", content: "Rain." }), "#7 GM (narration): Rain.", "ordinary lines are unchanged");
});
