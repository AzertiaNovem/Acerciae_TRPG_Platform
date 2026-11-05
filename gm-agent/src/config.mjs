// Configuration. Ordinary settings live in a YAML file (gm-agent.yml; see gm-agent.example.yml); the environment
// (or .env) holds only secrets and deployment: GM_PASSWORD, ANTHROPIC_API_KEY, LLM_API_KEY, PLANNER_API_KEY,
// ACERCIAE_API_BASE, CHANNEL_ID, STATE_DIR (and GM_AGENT_CONFIG, where the file is). Precedence: command-line flag
// (--name value or --name=value) › environment (those names only) › file › default. Other variables older versions
// read are ignored, with a warning naming the file key to use instead.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

// Loads KEY=VALUE lines from a .env file without overriding variables already set in the environment.
export function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// The environment variables still read: secrets, and what differs between deployments.
export const ENV_KEYS = ["GM_PASSWORD", "ANTHROPIC_API_KEY", "LLM_API_KEY", "PLANNER_API_KEY", "ACERCIAE_API_BASE", "CHANNEL_ID", "STATE_DIR", "GM_AGENT_CONFIG"];

// Where the configuration file is: --config, GM_AGENT_CONFIG, ./gm-agent.yml, or the client's own directory.
export function configPath(args = {}, env = process.env, here = process.cwd(), own = null) {
  const given = args.config ?? env.GM_AGENT_CONFIG;
  if (given) return path.resolve(String(given));
  for (const p of [path.join(here, "gm-agent.yml"), path.join(here, "gm-agent.yaml"), own && path.join(own, "gm-agent.yml")].filter(Boolean)) if (fs.existsSync(p)) return p;
  return null;
}

// Reads the YAML file: {file, dir, data}; a missing file is empty, a malformed one is an error.
export function loadConfigFile(file) {
  if (!file) return { file: null, dir: process.cwd(), data: {} };
  if (!fs.existsSync(file)) return { file, dir: path.dirname(file), data: {} };
  const data = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
  if (typeof data !== "object" || Array.isArray(data)) throw new Error(`${file}: the configuration must be a YAML mapping`);
  return { file, dir: path.dirname(file), data };
}

const int = (v, d) => { const n = typeof v === "number" ? Math.trunc(v) : Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d) => v === undefined || v === null ? d : v === true || /^(1|true|yes|on)$/i.test(String(v));
const list = (v) => (Array.isArray(v) ? v.map(String) : v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const str = (v, d = "") => (v === undefined || v === null ? d : String(v));
const get = (obj, dotted) => dotted.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

// Every setting: flag, file key, and (for the few that still come from the environment) its variable. Older variable
// names map to file keys for the warning.
const SETTINGS = [
  ["api", "ACERCIAE_API_BASE", null], ["username", null, "account.username"], ["password", "GM_PASSWORD", null], ["display-name", null, "account.display_name"],
  ["register", null, "account.register"], ["create", null, "channel.create"], ["rules", null, "channel.rule_system"], ["server", null, "channel.server_id"], ["channel", "CHANNEL_ID", null],
  ["server-name", null, "channel.server_name"], ["channel-name", null, "channel.channel_name"], ["era", null, "channel.era"],
  ["level", null, "table.level"], ["coplayers", null, "table.coplayers"], ["coplayer-windows", null, "table.coplayer_windows"], ["language", null, "table.language"], ["kickoff", null, "table.kickoff"], ["verbose", null, "table.verbose"],
  ["llm-provider", null, "llm.provider"], ["llm-api-base", null, "llm.api_base"], ["llm-api-key", "LLM_API_KEY", null], ["llm-model", null, "llm.model"], ["llm-effort", null, "llm.effort"],
  ["llm-max-tokens", null, "llm.max_tokens"], ["llm-fallbacks", null, "llm.fallbacks"], ["llm-timeout-ms", null, "llm.timeout_ms"], ["llm-stream", null, "llm.stream"], ["llm-trace", null, "llm.trace"], ["llm-cache-ttl", null, "llm.cache_ttl"],
  ["planner", null, "planner.enabled"], ["planner-provider", null, "planner.provider"], ["planner-api-base", null, "planner.api_base"], ["planner-api-key", "PLANNER_API_KEY", null], ["planner-model", null, "planner.model"], ["planner-effort", null, "planner.effort"],
  ["planner-interval-minutes", null, "planner.interval_minutes"], ["planner-min-lines", null, "planner.min_lines"], ["planner-cooldown-minutes", null, "planner.cooldown_minutes"], ["planner-stall-turns", null, "planner.stall_turns"],
  ["planner-max-runs-per-hour", null, "planner.max_runs_per_hour"], ["planner-impulse-lines", null, "planner.impulse_lines"], ["planner-plan-tokens", null, "planner.plan_tokens"],
  ["planner-window", null, "planner.wish_window"],
  ["casual-ai-texts-per-hour", null, "modes.casual_ai_texts_per_hour"], ["casual-ai-chain", null, "modes.casual_ai_chain"],
  ["final-review", null, "planner.final_review"], ["final-review-min-lines", null, "planner.final_review_min_lines"], ["final-review-max-days", null, "planner.final_review_max_days"],
  ["debounce-ms", null, "pacing.debounce_ms"], ["post-delay-ms", null, "pacing.post_delay_ms"], ["max-actions", null, "pacing.max_actions_per_turn"],
  ["context-recall-tokens", null, "context.recall_tokens"], ["gm-context-tokens", null, "context.gm_tokens"], ["coplayer-context-tokens", null, "context.coplayer_tokens"], ["context-lines", null, "context.page_lines"], ["history-backfill-lines", null, "context.backfill_lines"], ["llm-daily-token-budget", null, "context.daily_token_budget"],
  ["autonomy", null, "autonomy.enabled"], ["autonomy-tick-ms", null, "autonomy.tick_ms"], ["autonomy-side-interval-ms", null, "autonomy.side_interval_ms"], ["autonomy-quiet-ms", null, "autonomy.quiet_ms"], ["autonomy-quiet-turns", null, "autonomy.quiet_turns"],
  ["autonomy-max-turns-per-hour", null, "autonomy.max_turns_per_hour"], ["autonomy-idle-minutes", null, "autonomy.idle_minutes"], ["away-side-interval-ms", null, "autonomy.away_side_interval_ms"],
  ["timeline-auto", null, "timelines.auto"], ["timeline-guard-turns", null, "timelines.guard_turns"], ["timeline-guard-ms", null, "timelines.guard_ms"], ["timeline-max-active", null, "timelines.max_active"], ["timeline-pc-cooldown-ms", null, "timelines.pc_cooldown_ms"], ["timeline-max-arrivals-per-hour", null, "timelines.max_arrivals_per_hour"],
  ["scenario-auto", null, "scenarios.auto"], ["scenario-min-minutes", null, "scenarios.min_minutes"], ["scenario-min-lines", null, "scenarios.min_lines"],
  ["calendar-min-minutes", null, "calendar.min_minutes"], ["calendar-min-lines", null, "calendar.min_lines"], ["calendar-max-days", null, "calendar.max_days"],
  ["improv", null, "modes.improv"], ["world", null, "modes.world_file"], ["secrets", null, "modes.secrets_file"], ["casual", null, "modes.casual"], ["casual-max-delay-minutes", null, "modes.casual_max_delay_minutes"],
  ["state-dir", "STATE_DIR", null],
];
const LEGACY_ENV = {
  GM_USERNAME: "account.username", GM_DISPLAY_NAME: "account.display_name", GM_REGISTER: "account.register", CREATE_CHANNEL: "channel.create", SERVER_ID: "channel.server_id",
  SERVER_NAME: "channel.server_name", CHANNEL_NAME: "channel.channel_name", CAMPAIGN_ERA: "channel.era", COPLAYERS: "table.coplayers", COPLAYER_WINDOWS: "table.coplayer_windows",
  GM_LANGUAGE: "table.language", KICKOFF: "table.kickoff", VERBOSE: "table.verbose", LLM_PROVIDER: "llm.provider", LLM_API_BASE: "llm.api_base", LLM_MODEL: "llm.model", LLM_EFFORT: "llm.effort",
  LLM_MAX_TOKENS: "llm.max_tokens", LLM_FALLBACKS: "llm.fallbacks", LLM_TIMEOUT_MS: "llm.timeout_ms", LLM_STREAM: "llm.stream", LLM_TRACE: "llm.trace", LLM_CACHE_TTL: "llm.cache_ttl",
  DEBOUNCE_MS: "pacing.debounce_ms", POST_DELAY_MS: "pacing.post_delay_ms", MAX_ACTIONS_PER_TURN: "pacing.max_actions_per_turn", GM_CONTEXT_TOKENS: "context.gm_tokens",
  COPLAYER_CONTEXT_TOKENS: "context.coplayer_tokens", CONTEXT_LINES: "context.page_lines", HISTORY_BACKFILL_LINES: "context.backfill_lines", LLM_DAILY_TOKEN_BUDGET: "context.daily_token_budget",
  AUTONOMY: "autonomy.enabled", AUTONOMY_TICK_MS: "autonomy.tick_ms", AUTONOMY_SIDE_INTERVAL_MS: "autonomy.side_interval_ms", AUTONOMY_QUIET_MS: "autonomy.quiet_ms", AUTONOMY_QUIET_TURNS: "autonomy.quiet_turns",
  AUTONOMY_MAX_TURNS_PER_HOUR: "autonomy.max_turns_per_hour", AUTONOMY_IDLE_MINUTES: "autonomy.idle_minutes", AWAY_SIDE_INTERVAL_MS: "autonomy.away_side_interval_ms",
  TIMELINE_AUTO: "timelines.auto", TIMELINE_GUARD_TURNS: "timelines.guard_turns", TIMELINE_GUARD_MS: "timelines.guard_ms", TIMELINE_MAX_ACTIVE: "timelines.max_active",
  TIMELINE_PC_COOLDOWN_MS: "timelines.pc_cooldown_ms", TIMELINE_MAX_ARRIVALS_PER_HOUR: "timelines.max_arrivals_per_hour", SCENARIO_AUTO: "scenarios.auto", SCENARIO_MIN_MINUTES: "scenarios.min_minutes",
  SCENARIO_MIN_LINES: "scenarios.min_lines", IMPROV: "modes.improv", WORLD_FILE: "modes.world_file", SECRETS_FILE: "modes.secrets_file", CASUAL: "modes.casual", CASUAL_MAX_DELAY_MINUTES: "modes.casual_max_delay_minutes",
};
const SECTIONS = ["account", "channel", "table", "llm", "planner", "pacing", "context", "autonomy", "timelines", "scenarios", "calendar", "modes"];

const TTL = (v) => (["1h", "5m", "off"].includes(String(v)) ? String(v) : "1h");
// true/false, or undefined when nothing says (a mode kept in the state file is then left as it is).
const tri = (v) => (v === undefined || v === null || v === "" ? undefined : bool(v, false));

// `file` is loadConfigFile()'s result (or its data). `cfg.warnings` lists what was ignored or unknown.
export function buildConfig(args = {}, env = process.env, file = {}) {
  const data = file?.data ?? file ?? {};
  const dir = file?.dir ?? process.cwd();
  const warnings = [];
  for (const [name, key] of Object.entries(LEGACY_ENV)) if (env[name] !== undefined) warnings.push(`${name} is no longer read; set ${key} in gm-agent.yml (or pass --${SETTINGS.find((s) => s[2] === key)?.[0] ?? key})`);
  for (const section of Object.keys(data)) {
    if (!SECTIONS.includes(section)) { warnings.push(`gm-agent.yml: unknown section "${section}"`); continue; }
    for (const key of Object.keys(data[section] ?? {})) if (`${section}.${key}` !== "channel.rules" && !SETTINGS.some((s) => s[2] === `${section}.${key}`)) warnings.push(`gm-agent.yml: unknown key "${section}.${key}"`);
  }
  // flag › environment (allowed names only) › file › default
  const pick = (flag, d) => {
    const [, envName, key] = SETTINGS.find((s) => s[0] === flag) ?? [];
    const fromFile = flag === "rules" ? get(data, "channel.rule_system") ?? get(data, "channel.rules") : key ? get(data, key) : undefined;
    const v = args[flag] ?? (envName ? env[envName] : undefined) ?? (fromFile === null ? undefined : fromFile) ?? d;
    return v;
  };
  // A file given in the configuration file is relative to that file; on the command line, to the working directory.
  const where = (flag, v) => (v ? path.resolve(args[flag] !== undefined ? process.cwd() : dir, String(v)) : null);

  const provider = str(pick("llm-provider", env.ANTHROPIC_API_KEY ? "anthropic" : "mock"));
  const llm = {
    provider,
    apiBase: str(pick("llm-api-base", "")),
    apiKey: str(pick("llm-api-key", provider === "anthropic" ? env.ANTHROPIC_API_KEY ?? "" : "")),
    model: str(pick("llm-model", provider === "anthropic" ? "claude-opus-5-5" : "")),
    effort: str(pick("llm-effort", "medium")),
    maxTokens: int(pick("llm-max-tokens", 16000), 16000),
    fallbacks: bool(pick("llm-fallbacks"), true),
    timeoutMs: int(pick("llm-timeout-ms", 600000), 600000),
    stream: bool(pick("llm-stream"), true),
    trace: str(pick("llm-trace", "")),
    // Prompt caching (Anthropic markers): 1h keeps a campaign's prefix warm across short breaks, 5m is cheaper to
    // write, off sends no markers.
    cacheTtl: TTL(pick("llm-cache-ttl", "1h")),
  };
  // The story planner's own model: every empty field falls back to the GM's, the key to PLANNER_API_KEY or the GM's
  // provider's key.
  const pProvider = str(pick("planner-provider", "")) || llm.provider;
  const planner = {
    enabled: bool(pick("planner"), true),
    provider: pProvider,
    apiBase: str(pick("planner-api-base", "")) || (pProvider === llm.provider ? llm.apiBase : ""),
    apiKey: str(pick("planner-api-key", "")) || (pProvider === llm.provider ? llm.apiKey : pProvider === "anthropic" ? env.ANTHROPIC_API_KEY ?? "" : env.LLM_API_KEY ?? ""),
    model: str(pick("planner-model", "")) || (pProvider === llm.provider ? llm.model : pProvider === "anthropic" ? "claude-opus-5-5" : ""),
    effort: str(pick("planner-effort", "high")),
    maxTokens: llm.maxTokens, fallbacks: llm.fallbacks, timeoutMs: llm.timeoutMs, stream: llm.stream, trace: llm.trace, cacheTtl: llm.cacheTtl,
    intervalMs: Math.max(0, int(pick("planner-interval-minutes", 30), 30)) * 60000,
    minLines: Math.max(0, int(pick("planner-min-lines", 40), 40)),
    cooldownMs: Math.max(0, int(pick("planner-cooldown-minutes", 10), 10)) * 60000,
    stallTurns: Math.max(2, int(pick("planner-stall-turns", 6), 6)),
    maxRunsPerHour: Math.max(1, int(pick("planner-max-runs-per-hour", 4), 4)),
    impulseLines: Math.max(1, int(pick("planner-impulse-lines", 60), 60)),
    planTokens: Math.max(300, int(pick("planner-plan-tokens", 1500), 1500)),
    // The final review after a session of human play (planner.mjs): on unless turned off, from this many player lines.
    // The planner window, where the players write wishes and corrections for the planner's next run (wishes.mjs).
    wishWindow: bool(pick("planner-window"), true),
    finalReview: bool(pick("final-review"), true),
    finalReviewMinLines: Math.max(1, int(pick("final-review-min-lines", 10), 10)),
    finalReviewMaxDays: Math.max(0, int(pick("final-review-max-days", 30), 30)),
  };
  const cfg = {
    warnings,
    configFile: file?.file ?? null,
    apiBase: str(pick("api", "http://localhost:8080")).replace(/\/+$/, ""),
    username: str(pick("username", "")),
    password: str(pick("password", "")),
    displayName: str(pick("display-name", "AI Keeper")),
    register: bool(pick("register"), false),
    // The client never creates a server or channel unless asked (`setup --create`): it keeps one the account is GM of.
    create: bool(pick("create"), false),
    ruleSystem: (() => { const v = str(pick("rules", "coc7e")) || "coc7e"; if (!["coc7e", "dnd2024", "pbta"].includes(v)) throw new Error(`--rules (channel.rule_system) must be coc7e, dnd2024 or pbta, not "${v}"`); return v; })(),
    requestedPbta: args.rules === "pbta",
    serverId: str(pick("server", "")),
    channelId: str(pick("channel", "")),
    serverName: str(pick("server-name", "AI Keeper's table")),
    channelName: str(pick("channel-name", "A campaign with an AI Keeper")),
    era: str(pick("era", "")),
    coplayersSpecified: pick("coplayers") != null,
    coplayers: Math.max(0, Math.min(8, int(pick("coplayers", 2), 2))),
    level: Math.max(1, Math.min(20, int(pick("level", 1), 1))),   // D&D: the level of new co-players
    coplayerWindows: list(pick("coplayer-windows", "")),
    language: str(pick("language", "")),
    llm,
    planner,
    debounceMs: int(pick("debounce-ms", 4000), 4000),
    postDelayMs: int(pick("post-delay-ms", 1200), 1200),
    maxActionsPerTurn: Math.max(1, int(pick("max-actions", 6), 6)),
    // Lines fetched per page when the table syncs its local copy of the chat (store.mjs); the models' context is set by
    // the token budgets, with older history compacted into chapters (memory.mjs).
    contextLines: Math.max(10, Math.min(200, int(pick("context-lines", 100), 100))),
    gmContextTokens: Math.max(8000, int(pick("gm-context-tokens", 60000), 60000)),
    coplayerContextTokens: Math.max(4000, int(pick("coplayer-context-tokens", 24000), 24000)),
    recallTokens: Math.max(0, Math.min(4000, int(pick("context-recall-tokens", 1200), 1200))),
    historyBackfillLines: Math.max(0, int(pick("history-backfill-lines", 1000), 1000)),
    // Billable-equivalent tokens a day (cache reads count a tenth); spent, the table stops its own autonomous turns.
    dailyTokenBudget: Math.max(0, int(pick("llm-daily-token-budget", 0), 0)),
    kickoff: bool(pick("kickoff"), false),
    // Autonomy: the table moves on its own clock (side timelines, quiet shared windows) while humans are around.
    autonomy: bool(pick("autonomy"), true),
    autonomyTickMs: Math.max(1000, int(pick("autonomy-tick-ms", 30000), 30000)),
    autonomySideIntervalMs: int(pick("autonomy-side-interval-ms", 90000), 90000),
    autonomyQuietMs: int(pick("autonomy-quiet-ms", 180000), 180000),
    // Away mode: once nobody has posted for idle_minutes, co-players-only threads still move, this rarely (0 = they
    // wait too). Fragmented play keeps going between visits without spending much.
    awaySideIntervalMs: Math.max(0, int(pick("away-side-interval-ms", 21600000), 21600000)),
    autonomyQuietTurns: Math.max(0, int(pick("autonomy-quiet-turns", 2), 2)),
    autonomyMaxTurnsPerHour: Math.max(0, int(pick("autonomy-max-turns-per-hour", 20), 20)),
    autonomyIdleMinutes: Math.max(1, int(pick("autonomy-idle-minutes", 30), 30)),
    // Proactive timelines: the GM reports where investigators are; the table splits and reunites them.
    timelineAuto: bool(pick("timeline-auto"), true),
    timelineGuardTurns: Math.max(0, int(pick("timeline-guard-turns", 2), 2)),
    timelineGuardMs: Math.max(0, int(pick("timeline-guard-ms", 180000), 180000)),
    timelineMaxActive: Math.max(1, int(pick("timeline-max-active", 4), 4)),
    timelinePcCooldownMs: Math.max(0, int(pick("timeline-pc-cooldown-ms", 300000), 300000)),
    timelineMaxArrivalsPerHour: Math.max(0, int(pick("timeline-max-arrivals-per-hour", 12), 12)),
    // Scenario changes decided by the GM, from the Main Chat only.
    scenarioAuto: bool(pick("scenario-auto"), true),
    scenarioMinMinutes: Math.max(0, int(pick("scenario-min-minutes", 20), 20)),
    scenarioMinLines: Math.max(0, int(pick("scenario-min-lines", 30), 30)),
    // The GM's pace on the story's calendar (casual games): after the date moves, the GM may move it on again only
    // after this long and this many player lines, by at most this many days at once (0: no limit). The operator's
    // `date` and the final review are not held to it.
    calendarMinMinutes: Math.max(0, int(pick("calendar-min-minutes", 30), 30)),
    calendarMinLines: Math.max(0, int(pick("calendar-min-lines", 30), 30)),
    calendarMaxDays: Math.max(0, int(pick("calendar-max-days", 2), 2)),
    // Improvisation and casual modes are kept in the state file; these only change them when given (`setup`, `world`,
    // `casual`).
    improv: tri(pick("improv")),
    casual: tri(pick("casual")),
    casualMaxDelayMinutes: Math.max(0, int(pick("casual-max-delay-minutes", 240), 240)),
    // Texts between AI characters (co-players and NPCs): answered at most this many an hour, and an exchange between
    // two of them stops after this many messages until a person writes again.
    casualAiTextsPerHour: Math.max(0, int(pick("casual-ai-texts-per-hour", 12), 12)),
    casualAiChain: Math.max(1, int(pick("casual-ai-chain", 4), 4)),
    worldFile: where("world", pick("world", "")),
    secretsFile: where("secrets", pick("secrets", "")),
    stateDir: path.resolve(args["state-dir"] !== undefined || env.STATE_DIR ? process.cwd() : dir, str(pick("state-dir", path.join(process.cwd(), ".state")))),
    verbose: bool(pick("verbose"), false),
  };
  return cfg;
}
