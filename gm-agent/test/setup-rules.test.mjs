import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DND_RULES } from "./fixtures/dndRules.mjs";
import { PBTA_RULES } from "./fixtures/pbtaRules.mjs";
import { Store } from "../src/store.mjs";
import { loadState } from "../src/state.mjs";

for (const scenario of ["create D&D", "attach D&D", "review PbtA"]) {
  test(`CLI setup: ${scenario} keeps the channel's own rules and makes no character`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-rules-setup-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const pbta = scenario === "review PbtA";
    const channel = { id: "ch", server_id: "s", name: "test", my_role: "gm", rule_system: pbta ? "pbta" : "dnd2024", point_buy: true };
    let review = "pending", character = null;
    const requests = [], unexpected = [];
    const server = http.createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : null;
      const key = `${req.method} ${req.url}`;
      requests.push({ key, body });
      const routes = {
        "POST /api/auth/login": () => ({ token: "fixture", user: { id: "gm" } }),
        "POST /api/servers/s/channels": () => { assert.equal(body.rule_system, "dnd2024"); return channel; },
        "POST /api/servers/s/invites": () => ({ code: "fixture" }),
        "GET /api/channels/ch": () => channel,
        "GET /api/servers/s/settings": () => ({ language: "en", features: {} }),
        "GET /api/channels/ch/windows": () => [{ id: "main", kind: "main" }],
        "GET /api/channels/ch/characters": () => character ? [character] : [],
        "POST /api/channels/ch/characters": () => (character = { id: "cp", user_id: "gm", role_card: {}, ...body }),
        "GET /api/channels/ch/characters/cp/space": () => ({ character }),
        "PUT /api/channels/ch/characters/cp/card": () => { Object.assign(character, body); return { character }; },
        "PUT /api/channels/ch/characters/cp/appearance": () => ({ character }),
        ...(pbta ? {
          "GET /api/channels/ch/pbta": () => PBTA_RULES,
          "GET /api/channels/ch/members": () => [{ id: "gm", role: "gm" }, { id: "p1", role: "player" }],
          "GET /api/channels/ch/pbta/draft": () => ({ status: review, eligible: false, version: 1, revision: 1 }),
        } : { "GET /api/dnd/rules": () => DND_RULES }),
      };
      if (!routes[key]) unexpected.push(key);
      res.writeHead(routes[key] ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(routes[key]?.() ?? {}));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const args = [new URL("../src/cli.mjs", import.meta.url).pathname, "setup",
      "--state-dir", dir, "--config", path.join(dir, "missing.yml"),
      "--api", `http://127.0.0.1:${server.address().port}`, "--username", "fixture", "--password", "fixture",
      "--llm-provider", "mock", "--llm-trace", "",
      ...(scenario === "create D&D" ? ["--create", "--server", "s", "--rules", "dnd2024"] : ["--channel", "ch"]),
    ];
    const run = () => promisify(execFile)(process.execPath, args, { cwd: dir, timeout: 15000 });
    if (pbta) {
      const pending = await run();
      assert.match(pending.stdout, /Review the rule draft/);
      assert.equal(loadState(dir, "ch").pbtaSetup.ready, false, "play waits for the GM's review");
      review = "kept";
    }
    const done = await run();
    assert.deepEqual(unexpected, []);
    assert.match(done.stdout, /CHANNEL_ID=ch/);
    if (scenario === "create D&D") assert.ok(requests.some(r => r.key === "POST /api/servers/s/channels"), "the new channel plays D&D");
    assert.equal(character, null, "setup makes no character");
    assert.ok(!requests.some(r => r.key.startsWith("POST /api/channels/ch/characters")));
    if (pbta) assert.equal(loadState(dir, "ch").pbtaSetup.ready, true);
    const store = Store.open(dir, "ch");
    try {
      assert.deepEqual(store.usageCalls({}).map(r => r.purpose), [], "nothing to ask a model");
    } finally { store.close(); }
  });
}
