// Configuration: environment variables, overridden by command-line flags (--name value or --name=value).
import fs from "node:fs";
import path from "node:path";

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

const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d) => v === undefined ? d : v === true || /^(1|true|yes|on)$/i.test(String(v));
const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);

export function buildConfig(args = {}, env = process.env) {
  const pick = (flag, name, d) => args[flag] ?? env[name] ?? d;
  const provider = pick("llm-provider", "LLM_PROVIDER", env.ANTHROPIC_API_KEY ? "anthropic" : "mock");
  const cfg = {
    apiBase: String(pick("api", "ACERCIAE_API_BASE", "http://localhost:8080")).replace(/\/+$/, ""),
    username: pick("username", "GM_USERNAME", ""),
    password: pick("password", "GM_PASSWORD", ""),
    displayName: pick("display-name", "GM_DISPLAY_NAME", "AI Keeper"),
    register: bool(pick("register", "GM_REGISTER"), false),
    serverId: pick("server", "SERVER_ID", ""),
    channelId: pick("channel", "CHANNEL_ID", ""),
    serverName: pick("server-name", "SERVER_NAME", "AI Keeper's table"),
    channelName: pick("channel-name", "CHANNEL_NAME", "A campaign with an AI Keeper"),
    era: pick("era", "CAMPAIGN_ERA", ""),
    coplayers: Math.max(0, Math.min(8, int(pick("coplayers", "COPLAYERS", 2), 2))),
    coplayerWindows: list(pick("coplayer-windows", "COPLAYER_WINDOWS", "")),
    language: pick("language", "GM_LANGUAGE", ""),
    llm: {
      provider,
      apiBase: pick("llm-api-base", "LLM_API_BASE", ""),
      apiKey: pick("llm-api-key", "LLM_API_KEY", provider === "anthropic" ? env.ANTHROPIC_API_KEY ?? "" : ""),
      model: pick("llm-model", "LLM_MODEL", provider === "anthropic" ? "claude-opus-5-5" : ""),
      effort: pick("llm-effort", "LLM_EFFORT", "medium"),
      maxTokens: int(pick("llm-max-tokens", "LLM_MAX_TOKENS", 16000), 16000),
      fallbacks: bool(pick("llm-fallbacks", "LLM_FALLBACKS"), true),
      timeoutMs: int(pick("llm-timeout-ms", "LLM_TIMEOUT_MS", 600000), 600000),
      stream: bool(pick("llm-stream", "LLM_STREAM"), true),
      trace: pick("llm-trace", "LLM_TRACE", ""),
      tokenParam: pick("llm-token-param", "LLM_TOKEN_PARAM", ""),
    },
    debounceMs: int(pick("debounce-ms", "DEBOUNCE_MS", 4000), 4000),
    postDelayMs: int(pick("post-delay-ms", "POST_DELAY_MS", 1200), 1200),
    maxActionsPerTurn: Math.max(1, int(pick("max-actions", "MAX_ACTIONS_PER_TURN", 6), 6)),
    contextLines: Math.max(10, Math.min(200, int(pick("context-lines", "CONTEXT_LINES", 60), 60))),
    kickoff: bool(pick("kickoff", "KICKOFF"), false),
    stateDir: path.resolve(pick("state-dir", "STATE_DIR", path.join(process.cwd(), ".state"))),
    verbose: bool(pick("verbose", "VERBOSE"), false),
  };
  return cfg;
}
