// A message's content is a string, or a list of parts {text, cache} laid out stable-first: `cache: true` marks the end
// of a prefix that stays the same across calls (a cache breakpoint). Providers that cache by explicit markers
// (Anthropic) place them there; cacheTtl: "5m" can shorten a volatile suffix. Providers that cache by prefix (OpenAI) just keep the order.
import crypto from "node:crypto";

export const partsOf = (content) => (Array.isArray(content) ? content.filter((p) => p && p.text) : [{ text: String(content ?? "") }]);
export const textOf = (content) => partsOf(content).map((p) => p.text).join("");

// Wraps a model so every call reports its token usage to `sink` and carries a stable cache key for its purpose.
export function metered(llm, { sink = () => {}, channelId = "", provider = "", model = "", now = Date.now, log = () => {}, signalOf } = {}) {
  const keys = new Map();
  const keyOf = (purpose) => {
    if (!keys.has(purpose)) keys.set(purpose, `acerciae-gm-${crypto.createHash("sha256").update(`${channelId}\n${purpose}`).digest("hex").slice(0, 32)}`);
    return keys.get(purpose);
  };
  const wrapped = Object.create(llm);
  if (signalOf) wrapped.signalOf = signalOf;
  wrapped.complete = async (req) => {
    const signal = signalOf?.() ?? req.signal;
    signal?.throwIfAborted();
    const at = now(), callId = crypto.randomUUID();
    let usage = null, status = "completed", httpStatus = null;
    try {
      const reply = await llm.complete({ ...req, signal, cacheKey: req.cacheKey ?? keyOf(req.purpose ?? ""), onUsage: (u) => {
        // Providers report a final snapshot, not deltas; do not double-count duplicate callbacks.
        usage = u;
        req.onUsage?.(u);
      } });
      signal?.throwIfAborted();   // Some providers may finish just as cancellation arrives.
      return reply;
    } catch (e) {
      status = "failed";
      httpStatus = Number.isInteger(e.status) ? e.status : null;
      throw e;
    } finally {
      const known = Number.isSafeInteger(usage?.input) && usage.input >= 0 && Number.isSafeInteger(usage?.output) && usage.output >= 0;
      const record = { ...usage, callId, requestId: req.requestId ?? callId, at,
        purpose: req.purpose || "completion", phase: req.phase ?? "", attempt: req.attempt ?? 1,
        provider: usage?.provider || provider || llm?.provider || (llm?.mock ? "mock" : ""), model: usage?.model || model || llm?.model || "",
        durationMs: Math.max(0, now() - at), status, httpStatus, usageKnown: known,
        estimated: Boolean(usage?.estimated || llm?.mock) };
      try { sink(record); } catch { log(`LLM ${record.purpose}: token usage could not be saved`); }
    }
  };
  return wrapped;
}

// Keep each completed history chunk as its own immutable provider block. Appending a chunk must not rewrite the
// previous block: Anthropic's prefix lookback can then find the previous cache write at that exact boundary.
export function historyParts(lines, render, heading, chunkSize = 50) {
  const parts = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    parts.push({ text: `${i === 0 ? `${heading}\n` : ""}${lines.slice(i, i + chunkSize).map(render).join("\n")}\n\n` });
  }
  if (parts.length) parts.at(-1).cache = true;
  return parts;
}
