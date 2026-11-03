import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig, configPath, loadConfigFile } from "../src/config.mjs";

const file = (data, dir = "/campaign") => ({ file: path.join(dir, "gm-agent.yml"), dir, data });

test("precedence: flag, then the environment for secrets and deployment only, then the file, then the default", () => {
  const data = { account: { username: "from-file" }, pacing: { debounce_ms: 1 }, llm: { provider: "openai_compatible", model: "gpt-x", api_base: "https://gw.test/v1" } };
  const env = { GM_PASSWORD: "pw", ACERCIAE_API_BASE: "https://api.test/", CHANNEL_ID: "ch-env", STATE_DIR: "/tmp/state", LLM_API_KEY: "k-llm" };
  const cfg = buildConfig({ "debounce-ms": "7" }, env, file(data));
  assert.equal(cfg.debounceMs, 7, "the flag wins");
  assert.equal(cfg.username, "from-file"); assert.equal(cfg.password, "pw");
  assert.equal(cfg.apiBase, "https://api.test"); assert.equal(cfg.channelId, "ch-env"); assert.equal(cfg.stateDir, "/tmp/state");
  assert.equal(cfg.llm.provider, "openai_compatible"); assert.equal(cfg.llm.model, "gpt-x"); assert.equal(cfg.llm.apiKey, "k-llm");
  assert.equal(cfg.postDelayMs, 1200, "the default otherwise");
  assert.deepEqual(cfg.warnings, []);
});

test("old environment variables are ignored, with a warning naming the file key", () => {
  const cfg = buildConfig({}, { DEBOUNCE_MS: "1", GM_USERNAME: "old", LLM_PROVIDER: "mock" }, file({}));
  assert.equal(cfg.debounceMs, 4000); assert.equal(cfg.username, "");
  assert.ok(cfg.warnings.some((w) => /DEBOUNCE_MS is no longer read; set pacing\.debounce_ms/.test(w)));
  assert.ok(cfg.warnings.some((w) => /GM_USERNAME.*account\.username/.test(w)));
  assert.equal(cfg.warnings.length, 3);
});

test("unknown sections and keys in the file are reported, known ones are not", () => {
  const cfg = buildConfig({}, {}, file({ table: { coplayers: 3, colour: "red" }, misc: { a: 1 } }));
  assert.equal(cfg.coplayers, 3);
  assert.deepEqual(cfg.warnings.sort(), ['gm-agent.yml: unknown key "table.colour"', 'gm-agent.yml: unknown section "misc"']);
});

test("the planner falls back to the GM's provider, endpoint, model and key unless given its own", () => {
  const env = { ANTHROPIC_API_KEY: "k-anthropic", PLANNER_API_KEY: "" };
  const same = buildConfig({}, env, file({ llm: { provider: "anthropic", model: "claude-opus-5-5" } }));
  assert.deepEqual([same.planner.provider, same.planner.model, same.planner.apiKey, same.planner.effort], ["anthropic", "claude-opus-5-5", "k-anthropic", "high"]);
  const other = buildConfig({}, { ...env, LLM_API_KEY: "k-llm" }, file({ llm: { provider: "anthropic" }, planner: { provider: "openai_compatible", api_base: "https://gw.test/v1", model: "o-plan", effort: "medium" } }));
  assert.deepEqual([other.planner.provider, other.planner.apiBase, other.planner.model, other.planner.apiKey, other.planner.effort], ["openai_compatible", "https://gw.test/v1", "o-plan", "k-llm", "medium"]);
  const keyed = buildConfig({ "planner-model": "flag-model" }, { ...env, PLANNER_API_KEY: "k-plan" }, file({}));
  assert.equal(keyed.planner.apiKey, "k-plan"); assert.equal(keyed.planner.model, "flag-model");
  assert.equal(buildConfig({}, {}, file({ planner: { enabled: false, interval_minutes: 45 } })).planner.enabled, false);
  assert.equal(buildConfig({}, {}, file({ planner: { interval_minutes: 45 } })).planner.intervalMs, 45 * 60000);
});

test("files named in the configuration are relative to it; on the command line, to the working directory", () => {
  const cfg = buildConfig({}, {}, file({ modes: { world_file: "world.md" } }, "/campaign"));
  assert.equal(cfg.worldFile, path.resolve("/campaign", "world.md"));
  assert.equal(buildConfig({ world: "w.md" }, {}, file({}, "/campaign")).worldFile, path.resolve(process.cwd(), "w.md"));
  assert.equal(buildConfig({}, {}, file({}, "/campaign")).stateDir, path.join(process.cwd(), ".state"), "the default state directory is beside the working directory");
  assert.equal(buildConfig({}, { STATE_DIR: "st" }, file({}, "/campaign")).stateDir, path.resolve(process.cwd(), "st"));
});

test("modes are three-valued: unset leaves the state file alone", () => {
  assert.equal(buildConfig({}, {}, file({})).improv, undefined);
  assert.equal(buildConfig({}, {}, file({ modes: { improv: true, casual: false } })).improv, true);
  assert.equal(buildConfig({}, {}, file({ modes: { improv: true, casual: false } })).casual, false);
  assert.equal(buildConfig({ casual: true }, {}, file({})).casual, true);
});

test("the file is found by flag, variable or beside the working directory, and read as YAML", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-cfg-"));
  fs.writeFileSync(path.join(dir, "gm-agent.yml"), "table:\n  coplayers: 4\nllm:\n  provider: mock\n");
  assert.equal(configPath({}, {}, dir), path.join(dir, "gm-agent.yml"));
  assert.equal(configPath({}, {}, "/nowhere", dir), path.join(dir, "gm-agent.yml"), "the client's own directory as a fallback");
  assert.equal(configPath({ config: "x.yml" }, {}, dir), path.resolve("x.yml"));
  assert.equal(configPath({}, { GM_AGENT_CONFIG: "/etc/gm.yml" }, dir), "/etc/gm.yml");
  assert.equal(configPath({}, {}, "/nowhere"), null);
  const loaded = loadConfigFile(path.join(dir, "gm-agent.yml"));
  assert.equal(buildConfig({}, {}, loaded).coplayers, 4);
  assert.equal(buildConfig({}, {}, loadConfigFile(null)).coplayers, 2, "no file: defaults");
  assert.equal(buildConfig({}, {}, loadConfigFile(path.join(dir, "missing.yml"))).coplayers, 2);
  fs.writeFileSync(path.join(dir, "bad.yml"), "- a\n- b\n");
  assert.throws(() => loadConfigFile(path.join(dir, "bad.yml")), /YAML mapping/);
});

test("recall budget defaults, YAML, flag, disabling and ceiling", () => {
  assert.equal(buildConfig({}, {}).recallTokens, 1200);
  assert.equal(buildConfig({}, {}, file({ context: { recall_tokens: 600 } })).recallTokens, 600);
  assert.equal(buildConfig({ "context-recall-tokens": "0" }, {}, file({ context: { recall_tokens: 600 } })).recallTokens, 0);
  assert.equal(buildConfig({ "context-recall-tokens": "99999" }, {}).recallTokens, 4000);
  assert.deepEqual(buildConfig({}, {}, file({ context: { recall_tokens: 600 } })).warnings, []);
});
