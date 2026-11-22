// The worldbook at a real table: the file the host's Web UI edits, read by the turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Table } from "../src/loop.mjs";
import { botBrief } from "../src/table/bots.mjs";
import { Roster } from "../src/roles/roster.mjs";
import { MockLlm } from "../src/llm/mock.mjs";
import { buildConfig } from "../src/config.mjs";
import { FakeApi } from "./fixtures/platform.mjs";
import { operatorPath, readOperatorFile, writeOperatorFile } from "../src/operator-files.mjs";

const IMPROV = { on: true, world: "WORLD-PUBLIC: Kingsport, 1923.", secrets: "WORLD-SECRET: the Guild master drowned the keeper." };
const ENTRIES = [
  { id: "e1", title: "Harbour Guild", keys: ["dockmasters"], body: "LORE-GUILD: the Guild runs the docks.", secret: false, enabled: true },
  { id: "e2", title: "Drowned keeper", keys: ["lighthouse"], body: "LORE-KEEPER: murdered by the Guild master.", secret: true, enabled: true },
  { id: "e3", title: "Fish market", keys: ["fishmongers"], body: "LORE-MARKET: opens at dawn.", secret: false, enabled: true },
];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "worldbook-"));
const bookFile = (dir) => operatorPath(dir, "ch", "worldbook");

async function setup({ improv = IMPROV, llm = new MockLlm(), dir = tmp(), logs = [] } = {}) {
  const api = new FakeApi();
  const base = buildConfig({}, {});
  const cfg = { ...base, debounceMs: 0, postDelayMs: 0, planner: { ...base.planner, enabled: false } };
  const t = await new Table({ api, llm, cfg, channelId: "ch", roster: new Roster(), improv: structuredClone(improv), sleep: async () => {}, log: (m) => logs.push(m), operatorDir: dir }).init({ heal: true });
  return { t, api, llm, dir, logs };
}
const says = (t, api, content) => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: t.primaryWindowId(), author_id: "u-alice", author_role: "player", character_id: "c-alice", content }) });
const settle = async (t) => { for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 2)); await t.queue; } };
const last = (llm, purpose) => llm.calls.filter((c) => c.purpose === purpose).at(-1)?.messages[0].content ?? "";

test("worldbook: created from the world setting, never posted, and an edit reaches the next turn", async () => {
  const { t, api, llm, dir } = await setup();
  const book = readOperatorFile(bookFile(dir));
  assert.deepEqual([book.bible, book.hidden, book.entries], [IMPROV.world, IMPROV.secrets, []]);
  assert.equal(t.improv.book.revision, 1);
  writeOperatorFile(bookFile(dir), (cur) => ({ ...cur, bible: "WORLD-PUBLIC-2: Kingsport in fog.", entries: ENTRIES, nextId: 4 }), { expect: 1 });
  await says(t, api, "We walk past the dockmasters toward the lighthouse.");
  await settle(t);
  assert.equal(t.improv.world, "WORLD-PUBLIC-2: Kingsport in fog.");
  const gm = last(llm, "director");
  assert.ok(gm.includes("WORLD-PUBLIC-2"));
  assert.match(gm, /## Worldbook \(entries beyond the world bible/);
  assert.match(gm, /- Fish market \(keys: fishmongers\)/);
  assert.match(gm, /- Drowned keeper \[secret: yours alone\]/);
  assert.ok(gm.includes("LORE-GUILD") && gm.includes("LORE-KEEPER"), "the entries mentioned are in play for the GM, the secret one too");
  assert.ok(!gm.includes("LORE-MARKET"), "an entry nobody mentioned stays a title");
  const brief = botBrief(t);
  assert.ok(brief.includes("LORE-GUILD"), "the platform's bots are told what came up where everyone could read it");
  assert.ok(!brief.includes("LORE-KEEPER") && !brief.includes("Drowned keeper"), "never a secret entry");
  assert.ok(!brief.includes("Fish market"), "no index for the bots");
  assert.ok(!api.posts.some((p) => /WORLD-PUBLIC|LORE-/.test(p.content)), "nothing of the world is posted");
});

test("worldbook: a newer world in the state is written into the file, an edit made while stopped wins at the next start", async () => {
  const dir = tmp();
  writeOperatorFile(bookFile(dir), () => ({ bible: "OLD", hidden: "OLD-SECRET", entries: ENTRIES, nextId: 4, updatedBy: "agent" }));
  // A state that knows nothing of the file, replaced since the agent last wrote it (an older Forge).
  const first = await setup({ dir, improv: { on: true, world: "FORGED-WORLD", secrets: "FORGED-SECRET" } });
  let book = readOperatorFile(bookFile(dir));
  assert.deepEqual([book.bible, book.hidden, book.entries.length, first.t.improv.book.revision], ["FORGED-WORLD", "FORGED-SECRET", 3, 2]);
  writeOperatorFile(bookFile(dir), (cur) => ({ ...cur, bible: "EDITED" }), { expect: 2 });
  const second = await setup({ dir, improv: first.t.improv });
  assert.equal(second.t.improv.world, "EDITED");
  // Both changed since they last met: the worldbook wins, and says so.
  writeOperatorFile(bookFile(dir), (cur) => ({ ...cur, bible: "EDITED-2" }));
  const third = await setup({ dir, improv: { ...second.t.improv, world: "CHANGED-IN-STATE" } });
  assert.equal(third.t.improv.world, "EDITED-2");
  assert.ok(third.logs.some((m) => m.includes("both the worldbook and the world setting changed")));
  // The `world` command writes the bible into the file and keeps the entries.
  await third.t.command({ cmd: "world", world: "FROM-THE-COMMAND" });
  book = readOperatorFile(bookFile(dir));
  assert.deepEqual([book.bible, book.entries.length], ["FROM-THE-COMMAND", 3]);
});

test("worldbook: the GM opens an entry nobody mentioned with worldbook_read, and it stays in play in that window", async () => {
  const dir = tmp();
  writeOperatorFile(bookFile(dir), () => ({ bible: IMPROV.world, hidden: IMPROV.secrets, entries: ENTRIES, nextId: 4 }));
  const llm = new MockLlm(), original = llm.complete.bind(llm);
  let tools = null, result = null;
  llm.complete = async (req) => {
    if (req.purpose === "director" && !tools) {
      tools = req.tools.map((x) => x.name);
      return { calls: [{ id: "wb-1", name: "worldbook_read", arguments: { title: "fish market" } }], providerOutput: [{ type: "function_call" }] };
    }
    if (req.purpose === "director" && !result) result = JSON.stringify(req.messages);
    return original(req);
  };
  const { t, api } = await setup({ dir, llm, improv: { ...IMPROV, book: { revision: 1, hash: "" } } });
  await says(t, api, "Good morning.");
  await settle(t);
  assert.ok(tools.includes("worldbook_read") && tools.includes("world_state_read"), "beside the world state tools");
  assert.ok(result.includes("LORE-MARKET"), "the entry came back to the model");
  assert.match(llm.calls.find((c) => c.purpose === "director").system, /open it with worldbook_read/);
  await says(t, api, "And then?");
  await settle(t);
  assert.ok(last(llm, "director").includes("LORE-MARKET"), "opened, it stays in play without a mention");
  const kit = t.withWorldbookTool(t.primaryWindowId(), { tools: [], call: () => null });
  assert.match(kit.call("worldbook_read", { title: "no such place" }).error, /Titles: Harbour Guild; Drowned keeper; Fish market/);
  assert.equal(t.withWorldbookTool(null, { tools: [], call: () => null }).call("worldbook_read", { title: "lighthouse" }).text, ENTRIES[1].body, "the planner reads secret entries too");
});

test("worldbook: on a first start, a worldbook edited in the Web UI or by the Forge wins over the state", async () => {
  for (const by of ["web", "forge", undefined]) {
    const dir = tmp();
    writeOperatorFile(bookFile(dir), () => ({ bible: "PREPARED", hidden: "PREPARED-SECRET", entries: ENTRIES, nextId: 4, ...(by ? { updatedBy: by } : {}) }));
    const { t } = await setup({ dir });
    assert.deepEqual([t.improv.world, t.improv.secrets, t.improv.book.revision], ["PREPARED", "PREPARED-SECRET", 1], `${by ?? "hand-written"}`);
  }
});

test("worldbook: without entries a table reads exactly as before, no section and no tool", async () => {
  const llm = new MockLlm(), original = llm.complete.bind(llm);
  let tools = null;
  llm.complete = async (req) => { if (req.purpose === "director" && !tools) tools = req.tools?.map((x) => x.name) ?? []; return original(req); };
  const { t, api } = await setup({ llm });
  await says(t, api, "Hello.");
  await settle(t);
  assert.ok(!tools.includes("worldbook_read"));
  assert.ok(!last(llm, "director").includes("## Worldbook"));
  assert.ok(!llm.calls.find((c) => c.purpose === "director").system.includes("worldbook_read"));
});
