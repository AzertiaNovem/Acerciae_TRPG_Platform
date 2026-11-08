import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/store.mjs";
import { metered } from "../src/llm/parts.mjs";

test("a metered call records the provider and model its usage names, over the table's defaults", async () => {
  const records = [];
  const llm = metered({ async complete({ onUsage }) { onUsage({ provider: "gw", model: "gpt-x", input: 5, cacheRead: 0, cacheWrite: 0, output: 1 }); return "x"; } }, { sink: (r) => records.push(r), provider: "anthropic", model: "claude-opus-5-5" });
  await llm.complete({ purpose: "coplayer_turn" });
  assert.deepEqual([records[0].provider, records[0].model, records[0].purpose], ["gw", "gpt-x", "coplayer_turn"]);
});
import { completeJson } from "../src/llm/index.mjs";
import { withProgress } from "../src/llm/progress.mjs";
import { usageOptions, usageReport, printUsageReport, usageSink } from "../src/usage.mjs";

const req = { system: "PRIVATE PROMPT", messages: [{ role: "user", content: "PRIVATE CONTENT" }], purpose: "director", phase: "human" };

test("each completed, missing-usage and failed call gets one durable record, never prompts or error bodies", async () => {
  const store = new Store();
  try {
    const logs = []; let clock = 1000, attempt = 0;
    const llm = metered({ async complete({ onUsage }) {
      const n = attempt++; clock += 25;
      if (n === 0) {
        onUsage({ model: "actual-model", input: 100, cacheRead: 80, cacheWrite: 0, output: 12 });
        onUsage({ model: "actual-model", input: 100, cacheRead: 80, cacheWrite: 0, output: 12 });
      }
      if (n === 2) throw Object.assign(new Error("PRIVATE ERROR BODY api-key-secret"), { status: 504 });
      return "PRIVATE REPLY";
    } }, { sink: usageSink(store, (s) => logs.push(s)), channelId: "ch", provider: "openai_compatible", model: "requested-model", now: () => clock });
    await llm.complete(req); await llm.complete(req);
    await assert.rejects(llm.complete(req), /PRIVATE ERROR/);
    const rows = store.usageCalls({});
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((r) => r.callId)).size, 3);
    assert.deepEqual(rows.map((r) => [r.status, r.usageKnown, r.durationMs]), [["failed", false, 25], ["completed", false, 25], ["completed", true, 25]]);
    assert.equal(rows[0].httpStatus, 504);
    assert.equal(rows[0].model, "requested-model"); assert.equal(rows[2].model, "actual-model");
    assert.equal(rows[2].total, 112, "cache reads are already part of input, not added again");
    assert.doesNotMatch(JSON.stringify(rows) + logs.join("\n"), /PRIVATE|api-key-secret/);
    assert.match(logs[1], /unknown/);
  } finally { store.close(); }
});

test("JSON repair is recorded separately, with the original request id and category", async () => {
  const store = new Store();
  try {
    let calls = 0;
    const llm = metered({ async complete({ onUsage }) {
      onUsage({ input: 50, output: ++calls * 10 }); return calls === 1 ? "not JSON" : '{"ok":true}';
    } }, { sink: (r) => store.recordUsage(r) });
    assert.deepEqual(await completeJson(llm, { system: "rules", user: "go", purpose: "coplayer_card", phase: "generate" }), { ok: true });
    const [repair, first] = store.usageCalls({});
    assert.equal(repair.requestId, first.requestId); assert.notEqual(repair.callId, first.callId);
    assert.deepEqual([first.attempt, repair.attempt], [1, 2]);
    const [summary] = store.usageByPurpose();
    assert.equal(summary.purpose, "coplayer_card"); assert.equal(summary.phase, "generate");
    assert.equal(summary.calls, 2); assert.equal(summary.output, 30); assert.equal(summary.averageOutput, 15);
  } finally { store.close(); }
});

test("usage survives reopening and old schema migration, groups phases/models and pages calls", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-usage-"));
  const file = path.join(dir, "ch.db");
  let store;
  try {
    // Recreate the pre-upgrade usage table and its historical row.
    store = new Store(file);
    store.db.exec(`DROP TABLE usage; CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      purpose TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', input INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0);
      INSERT INTO usage(at,purpose,model,input,output) VALUES(1,'director','old-model',20,7);`);
    store.close(); store = new Store(file);
    store.recordUsage({ at: 100, purpose: "planner", phase: "draft", model: "m", input: 100, output: 20 });
    store.recordUsage({ at: 101, purpose: "planner", phase: "revise", model: "m", input: 200, output: 30 });
    store.recordUsage({ at: 102, purpose: "planner", phase: "revise", model: "m", usageKnown: false, status: "failed" });
    store.recordUsage({ at: 103, purpose: "coplayer_turn", model: "mock", input: 10, output: 50 });
    store.recordUsage({ at: 104, purpose: "large_counter", input: 3_000_000_000, output: 4_000_000_000 });
    store.close(); store = new Store(file);
    const report = usageReport(store, { since: 100, purpose: "planner", limit: 1 });
    assert.equal(report.calls.length, 1); assert.equal(report.nextBeforeId, 4);
    assert.equal(report.summary.length, 2);
    const revise = report.summary.find((r) => r.phase === "revise");
    assert.deepEqual([revise.calls, revise.failed, revise.unknown, revise.output, revise.averageOutput], [2, 1, 1, 30, 30]);
    const page = store.usageCalls({ purpose: "planner", beforeId: report.nextBeforeId });
    assert.deepEqual(page.map((r) => r.id), [3, 2]);
    assert.equal(store.usageCalls({ purpose: "director" })[0].output, 7);
    assert.equal(store.usageCalls({ purpose: "large_counter" })[0].total, 7_000_000_000);
    assert.equal(store.usageByPurpose(0, "coplayer_turn")[0].estimated, 1);
    const printed = []; printUsageReport(report, (s) => printed.push(s));
    assert.match(printed.join("\n"), /usage.*unknown/);
  } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("progress wrapping preserves provider identity, and a logging failure does not discard a response", async () => {
  const logs = [], records = [];
  const llm = metered(withProgress({ model: "mock", provider: "mock", mock: true,
    async complete({ onUsage }) { onUsage({ input: 5, output: 10 }); return "ok"; },
  }, () => {}), { sink: (r) => records.push(r) });
  assert.equal(await llm.complete(req), "ok");
  assert.equal(records[0].provider, "mock"); assert.equal(records[0].estimated, true);
  const broken = metered({ async complete() { return "ok"; } }, { sink: () => { throw new Error("db full"); }, log: (s) => logs.push(s) });
  assert.equal(await broken.complete(req), "ok"); assert.match(logs[0], /could not be saved/);
});

test("usage CLI reads local statistics as JSON without platform login, including filtering and pagination", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-usage-cli-"));
  const store = Store.open(dir, "ch");
  store.recordUsage({ purpose: "planner", phase: "draft", model: "m", input: 100, output: 40 });
  store.recordUsage({ purpose: "coplayer_card", model: "m", input: 10, output: 9 });
  store.close();
  try {
    const cli = new URL("../src/cli.mjs", import.meta.url);
    const { stdout } = await promisify(execFile)(process.execPath, [cli.pathname, "usage", "--channel", "ch", "--state-dir", dir,
      "--config", path.join(dir, "missing.yml"), "--api", "http://127.0.0.1:1", "--days", "all", "--purpose", "planner", "--limit", "1", "--json"], { cwd: dir });
    const report = JSON.parse(stdout);
    assert.equal(report.summary[0].purpose, "planner"); assert.equal(report.calls[0].output, 40);
    assert.equal(report.calls.length, 1); assert.equal(report.since, 0);
    assert.throws(() => usageOptions({ days: true }), /integer/);
    assert.throws(() => usageOptions({ limit: "-1" }), /integer/);
    assert.throws(() => usageOptions({ purpose: true }), /call type/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("setup records character generation in the same channel database even before run", async () => {
  const { default: http } = await import("node:http");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-usage-setup-"));
  const unexpected = [];
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request, never log its password */ }
    const routes = {
      "POST /api/auth/login": { token: "fixture", user: { id: "gm" } },
      "GET /api/channels/ch": { id: "ch", server_id: "s", name: "test", my_role: "gm", rule_system: "coc7e" },
      "GET /api/servers/s/settings": { language: "en", features: {} },
      "GET /api/coc7/rules": { skills: [], families: [] },
      "GET /api/channels/ch/windows": [{ id: "main", kind: "main" }],
      "GET /api/channels/ch/characters": [],
      "POST /api/channels/ch/characters": { id: "cp" },
      "PUT /api/channels/ch/characters/cp/card": {},
      "PUT /api/channels/ch/characters/cp/appearance": {},
    };
    const key = `${req.method} ${req.url}`;
    if (!(key in routes)) unexpected.push(key);
    res.writeHead(key in routes ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(routes[key] ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [new URL("../src/cli.mjs", import.meta.url).pathname,
      "setup", "--channel", "ch", "--state-dir", dir, "--config", path.join(dir, "missing.yml"),
      "--api", `http://127.0.0.1:${server.address().port}`, "--username", "fixture", "--password", "fixture",
      "--llm-provider", "mock", "--llm-trace", "", "--coplayers", "1"], { cwd: dir });
    assert.deepEqual(unexpected, []);
    assert.match(stdout, /LLM tokens #1 coplayer_card/);
    const store = Store.open(dir, "ch");
    try {
      const rows = store.usageCalls({});
      assert.equal(rows.length, 1); assert.equal(rows[0].purpose, "coplayer_card");
      assert.equal(rows[0].usageKnown, true); assert.equal(rows[0].estimated, true); assert.equal(rows[0].output, 50);
    } finally { store.close(); }
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
