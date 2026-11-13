import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig, configPath, loadConfigFile } from "../src/config.mjs";
import { describeModels, routeFor } from "../src/llm/routes.mjs";

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

test('co-player participation thresholds are configurable and the check can be disabled', () => {
  const cfg = buildConfig({}, {}, file({ autonomy: { coplayer_idle_lines: 0, coplayer_idle_minutes: 45 } }));
  assert.equal(cfg.coplayerIdleLines, 0); assert.equal(cfg.coplayerIdleMinutes, 45);
  assert.deepEqual(cfg.warnings, []);
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

test("named providers and the model of each function: defaults, keys, routes and what is refused", () => {
  const env = { ANTHROPIC_API_KEY: "k-anthropic", LLM_API_KEY: "k-llm" };
  const cfg = buildConfig({}, env, file({
    llm: { provider: "anthropic", model: "claude-opus-5-5", effort: "medium", cache_ttl: "5m" },
    providers: { gw: { provider: "openai_compatible", api_base: "https://gw.test/v1", model: "gpt-x", max_tokens: 4000 }, fast: { provider: "anthropic", model: "claude-haiku-5-5", api_key: "k-fast", effort: "low", cache_ttl: "off" } },
    models: { coplayers: "gw", memory: { provider: "fast" }, coplayer_phone: { provider: "fast", model: "claude-sonnet-5-5", effort: "high", max_tokens: 800 }, default: { provider: "default", effort: "high" } },
  }));
  assert.deepEqual(cfg.warnings, []);
  assert.deepEqual([cfg.providers.gw.apiKey, cfg.providers.gw.maxTokens, cfg.providers.gw.cacheTtl, cfg.providers.gw.effort], ["k-llm", 4000, "5m", "medium"], "a provider takes the llm settings it does not give; its key from the environment");
  assert.deepEqual([cfg.providers.fast.apiKey, cfg.providers.fast.cacheTtl, cfg.providers.default.apiKey], ["k-fast", "off", "k-llm"], "the llm settings read LLM_API_KEY first, as before");
  // A purpose named directly outranks its function; a function not named runs on models.default; the planner keeps its own section.
  assert.deepEqual([routeFor(cfg, "coplayer_turn").name, routeFor(cfg, "coplayer_turn").model, routeFor(cfg, "coplayer_phone").model, routeFor(cfg, "coplayer_phone").maxTokens], ["gw", "gpt-x", "claude-sonnet-5-5", 800]);
  assert.deepEqual([routeFor(cfg, "compact").name, routeFor(cfg, "compact").effort, routeFor(cfg, "director").name, routeFor(cfg, "director").effort, routeFor(cfg, "planner").effort, routeFor(cfg, "planner").function], ["fast", "low", "default", "high", "high", "planner"]);
  assert.deepEqual(describeModels(cfg).map((r) => [r.function, r.provider, r.model, r.effort]), [["coplayers", "gw", "gpt-x", "medium"], ["planner", "anthropic", "claude-opus-5-5", "high"], ["memory", "fast", "claude-haiku-5-5", "low"], ["default", "anthropic", "claude-opus-5-5", "high"]]);
  // models.planner outranks the planner section; without either, the planner runs on the default route.
  const planned = buildConfig({}, env, file({ llm: { provider: "anthropic" }, providers: { fast: { provider: "anthropic", model: "claude-haiku-5-5" } }, models: { planner: "fast" } }));
  assert.deepEqual([routeFor(planned, "planner").name, routeFor(planned, "planner").model], ["fast", "claude-haiku-5-5"]);
  assert.deepEqual(routeFor(planned, 'planner_daily'), routeFor(planned, 'planner'));
  const dailyRoute = buildConfig({}, env, file({ llm: { provider: 'mock' }, models: { planner_daily: { model: 'small-planner', max_tokens: 800 } } }));
  assert.deepEqual(dailyRoute.warnings, []);
  assert.equal(routeFor(dailyRoute, 'planner_daily').maxTokens, 800);
  assert.equal(routeFor(dailyRoute, 'planner_daily').model, 'small-planner');
  assert.equal(routeFor(buildConfig({}, env, file({ llm: { provider: "anthropic" }, planner: { effort: "medium" } })), "planner").function, null, "a planner section equal to llm is no route of its own");
  // What is refused, each with a word of help.
  const bad = buildConfig({}, env, file({ llm: { provider: "mock" }, providers: { default: { provider: "mock" }, "bad name": { provider: "mock" }, gw: { provider: "openai_compatible" }, odd: { provider: "mock", colour: "red" }, nope: { provider: "nowhere" } },
    models: { singer: "gw", director: "missing", coplayers: { provider: "odd", effort: "extreme", size: 1 } } }));
  for (const re of [/"default" is the llm section/, /"bad name" is not a name/, /providers\.gw \(openai_compatible\) needs api_base/, /needs a model/, /unknown key "providers\.odd\.colour"/, /providers\.nope\.provider must be/, /unknown function "singer"/, /models\.director: no provider "missing"/, /models\.coplayers\.effort must be/, /unknown key "models\.coplayers\.size"/]) assert.ok(bad.warnings.some((w) => re.test(w)), String(re));
  assert.equal(buildConfig({}, {}, file({ llm: { provider: "mock" } })).providers.default.name, "default");
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

test("the GM's calendar pace: defaults, the calendar section, flags, and 0 for no limit", () => {
  const d = buildConfig({}, {});
  assert.deepEqual([d.calendarMinMinutes, d.calendarMinLines, d.calendarMaxDays], [30, 30, 2]);
  const f = buildConfig({}, {}, file({ calendar: { min_minutes: 60, min_lines: 50, max_days: 1 } }));
  assert.deepEqual([f.calendarMinMinutes, f.calendarMinLines, f.calendarMaxDays], [60, 50, 1]);
  assert.deepEqual(f.warnings, []);
  const flags = buildConfig({ "calendar-min-minutes": "0", "calendar-min-lines": "0", "calendar-max-days": "0" }, {}, file({ calendar: { min_minutes: 60 } }));
  assert.deepEqual([flags.calendarMinMinutes, flags.calendarMinLines, flags.calendarMaxDays], [0, 0, 0]);
  assert.equal(buildConfig({}, {}, file({ calendar: { min_minutes: -5 } })).calendarMinMinutes, 0);
});

test("the rule system of a new channel and the level of new D&D co-players", () => {
  assert.equal(buildConfig({}, {}, file({})).ruleSystem, "coc7e"); assert.equal(buildConfig({}, {}, file({})).level, 1);
  assert.equal(buildConfig({}, {}, file({ channel: { rule_system: "dnd2024" }, table: { level: 5 } })).ruleSystem, "dnd2024");
  assert.equal(buildConfig({ rules: "dnd2024", level: "30" }, {}, file({})).level, 20, "clamped to 1–20");
  assert.throws(() => buildConfig({ rules: "dnd5e" }, {}, file({})), /must be coc7e, dnd2024 or pbta/);
});

test("PbtA rules and the existing channel.rules configuration remain supported", () => {
  for (const key of ["rules", "rule_system"]) {
    const cfg = buildConfig({}, {}, file({ channel: { [key]: "pbta" } }));
    assert.equal(cfg.ruleSystem, "pbta");
    assert.deepEqual(cfg.warnings, []);
    assert.equal(buildConfig({ rules: "dnd2024" }, {}, file({ channel: { [key]: "pbta" } })).ruleSystem, "dnd2024");
  }
  assert.equal(buildConfig({}, {}, file({ channel: { rules: "pbta", rule_system: "dnd2024" } })).ruleSystem, "dnd2024");
});
