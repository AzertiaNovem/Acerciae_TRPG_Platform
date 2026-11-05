// Claude through the official Anthropic SDK, with prompt caching: the system prompt and the parts of the user message
// marked `cache` (parts.mjs) get cache_control markers (at most 4 per request; the newest win), with a 1-hour TTL by
// default (LLM_CACHE_TTL=5m|1h|off).
import Anthropic from "@anthropic-ai/sdk";
import { readJson, streamEvents, withResponseTimeout } from "./stream.mjs";
import { partsOf } from "./parts.mjs";

const MAX_BREAKPOINTS = 4;

export class AnthropicLlm {
  constructor({ apiKey, apiBase, model, effort, maxTokens, fallbacks, timeoutMs = 600000, stream = true, cacheTtl = "1h" }) {
    this.client = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(apiBase ? { baseURL: apiBase } : {}), timeout: timeoutMs });
    this.model = model || "claude-opus-5-5";
    this.effort = effort || "medium";
    this.maxTokens = maxTokens || 16000;
    this.fallbacks = fallbacks;
    this.stream = stream;
    this.timeoutMs = timeoutMs;
    this.cacheTtl = cacheTtl;
  }

  async complete({ system, messages, onUsage, signal }) {
    const cc = this.cacheTtl === "off" ? null : { type: "ephemeral", ...(this.cacheTtl === "1h" ? { ttl: "1h" } : {}) };
    const blocks = messages.map((m) => ({ role: m.role, content: Array.isArray(m.content) ? partsOf(m.content).map((p) => ({ type: "text", text: p.text, mark: Boolean(p.cache), shortCache: p.cacheTtl === "5m" })) : m.content }));
    let left = cc ? MAX_BREAKPOINTS - 1 : 0;   // one goes to the system prompt
    for (const m of [...blocks].reverse()) {
      if (!Array.isArray(m.content)) continue;
      for (const b of [...m.content].reverse()) { if (b.mark && left > 0) { b.cache_control = cc; left--; } delete b.mark; }
    }
    // Mixed TTLs must be ordered long before short. Once a volatile part starts the 5m region, later repair or
    // planner messages also use 5m, even if their caller requested the default 1h lifetime.
    let short = this.cacheTtl === "5m";
    for (const m of blocks) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.cache_control) {
          short ||= b.shortCache;
          if (short) b.cache_control = { type: "ephemeral" };
        }
        delete b.shortCache;
      }
    }
    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: cc ? [{ type: "text", text: system, cache_control: cc }] : system,
      messages: blocks,
      stream: this.stream,
      output_config: { effort: this.effort },
    };
    // On a policy decline the API re-runs the request on Anthropic's recommended fallback model.
    const response = await withResponseTimeout(this.timeoutMs, signal, this.stream, async (requestSignal, activity) => {
      const options = { signal: requestSignal };
      const request = this.fallbacks
        ? this.client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, options)
        : this.client.messages.create(params, options);
      const res = await request.asResponse();
      activity();
      return res.headers.get("content-type")?.includes("text/event-stream")
        ? readMessage(res.body, activity) : readJson(res.body, activity);
    });
    const u = response.usage ?? {};
    const cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0;
    // input_tokens is only the uncached remainder: the whole prompt is the three together.
    if (response.usage) onUsage?.({ model: response.model ?? this.model, input: Number.isSafeInteger(u.input_tokens) ? u.input_tokens + cacheRead + cacheWrite : null, cacheRead, cacheWrite, output: u.output_tokens ?? null });
    if (response.stop_reason === "refusal") throw new Error(`the model declined (${response.stop_details?.category ?? "refusal"})`);
    if (response.stop_reason === "max_tokens") throw new Error("LLM output was truncated by the token limit; increase llm.max_tokens or request a shorter response.");
    return response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
}

// Only visible text is used by the agent. Thinking and ping frames still count as activity.
async function readMessage(body, activity) {
  let message;
  for await (const event of streamEvents(body, activity)) {
    if (event.type === "ping") continue;
    if (event.type === "message_start") {
      if (message) throw new Error("LLM stream started a second message before completion.");
      message = event.message;
      continue;
    }
    if (!message) throw new Error("LLM stream is missing message_start.");
    if (event.type === "content_block_start") {
      const block = event.content_block;
      message.content[event.index] = block;
      if (block.type === "fallback" && block.to?.model) message.model = block.to.model;
    }
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      const block = message.content[event.index];
      if (block?.type !== "text") throw new Error("LLM stream is missing a text block.");
      block.text += event.delta.text;
    }
    if (event.type === "message_delta") {
      Object.assign(message, event.delta);
      for (const [key, value] of Object.entries(event.usage ?? {})) {
        if (value != null) (message.usage ??= {})[key] = value;
      }
    }
    if (event.type === "message_stop") {
      if (!message.stop_reason) throw new Error("LLM stream ended without a stop reason.");
      return message;
    }
  }
}
