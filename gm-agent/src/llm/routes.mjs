// Which model answers which call. Every model call names its purpose (the usage list shows them: director,
// coplayer_turn, planner, compact…). The purposes fall into functions, and `models` (a channel's setting) says for
// each function which provider (a named endpoint with its key, from `providers` in the shared configuration) and which
// model answer it. A purpose named directly outranks its function; a function not named runs on `models.default`,
// else on the `llm` settings (the provider called "default"). The planner's own `planner.provider/model/effort`
// settings still name its route when `models.planner` does not.
export const MODEL_FUNCTIONS = {
  director: ["director"],
  coplayers: ["coplayer_turn", "coplayer_phone", "standin_turn"],
  planner: ["planner", "planner_daily"],
  memory: ["compact", "coplayer_memory", "day_summary"],
  readers: ["scene_presence", "movement_evidence", "placement_correction", "scene_handoff", "away_rule"],
  pictures: ["scenario_illustration", "event_illustration", "plot_search", "plot_illustration"],
  cards: ["coplayer_card", "npc_card", "coplayer_repair", "coplayer_points", "coplayer_build", "pbta_design", "pbta_card"],
};
export const FUNCTION_NAMES = Object.keys(MODEL_FUNCTIONS);
export const PURPOSES = Object.values(MODEL_FUNCTIONS).flat();
export const DEFAULT_PROVIDER = "default";
export const PROVIDER_TYPES = ["anthropic", "openai_compatible", "mock"];

export const functionOf = (purpose) => FUNCTION_NAMES.find((f) => MODEL_FUNCTIONS[f].includes(purpose)) ?? null;

// The full model settings for a purpose: the provider's connection and defaults, with the function's model, effort and
// output limit over them. `name` is the provider's name ("default" for the llm settings); `function` what chose it.
export function routeFor(cfg, purpose = "") {
  const providers = cfg.providers ?? { [DEFAULT_PROVIDER]: { ...cfg.llm, name: DEFAULT_PROVIDER } };
  const models = cfg.models ?? {};
  const fn = functionOf(purpose);
  let pick = models[purpose] ? { ...models[purpose], function: purpose } : fn && models[fn] ? { ...models[fn], function: fn } : null;
  // The planner's own settings (planner.provider, .model, .effort) are its route unless `models` names one.
  if (!pick && fn === "planner" && cfg.planner && plannerDiffers(cfg)) {
    const p = cfg.planner;
    return { name: p.provider, provider: p.provider, apiBase: p.apiBase, apiKey: p.apiKey, model: p.model, effort: p.effort, maxTokens: p.maxTokens, fallbacks: p.fallbacks, timeoutMs: p.timeoutMs, stream: p.stream, cacheTtl: p.cacheTtl, function: "planner" };
  }
  if (!pick && models.default) pick = { ...models.default, function: "default" };
  const base = providers[pick?.provider ?? DEFAULT_PROVIDER] ?? providers[DEFAULT_PROVIDER];
  const { trace, ...rest } = base;
  return { ...rest, name: base.name ?? DEFAULT_PROVIDER, model: pick?.model || base.model, effort: pick?.effort || base.effort, maxTokens: pick?.maxTokens || base.maxTokens, function: pick?.function ?? null };
}

// Whether the planner section asks for anything other than the llm settings (an effort of its own counts).
export const plannerDiffers = (cfg) => ["provider", "apiBase", "apiKey", "model", "effort"].some((k) => cfg.planner?.[k] !== cfg.llm?.[k]);

// How a route's provider is shown: a named provider by its name, the llm settings by their type (anthropic, mock…).
export const providerLabel = (route) => (route.name && route.name !== DEFAULT_PROVIDER ? route.name : route.provider);

// The connection and model of a route, for telling instances apart and for the logs.
export const routeKey = (r) => JSON.stringify([r.provider, r.apiBase, r.apiKey, r.model, r.effort, r.maxTokens, r.fallbacks, r.timeoutMs, r.stream, r.cacheTtl]);

// One line per function: {function, provider (name), model, effort}; the default route last, for the functions not
// listed. What the status page and the start-up log show.
export function describeModels(cfg) {
  const def = routeFor(cfg, "");
  const rows = FUNCTION_NAMES.map((fn) => ({ fn, route: routeFor(cfg, MODEL_FUNCTIONS[fn][0]) }))
    .filter(({ route }) => routeKey(route) !== routeKey(def) || (route.function && route.function !== "default"))
    .map(({ fn, route }) => ({ function: fn, provider: providerLabel(route), model: route.model || route.provider, effort: route.effort }));
  return [...rows, { function: "default", provider: providerLabel(def), model: def.model || def.provider, effort: def.effort }];
}
