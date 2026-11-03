// A message's content is a string, or a list of parts {text, cache} laid out stable-first: `cache: true` marks the end
// of a prefix that stays the same across calls (a cache breakpoint). Providers that cache by explicit markers
// (Anthropic) place them there; cacheTtl: "5m" can shorten a volatile suffix. Providers that cache by prefix (OpenAI) just keep the order.
import crypto from "node:crypto";

export const partsOf = (content) => (Array.isArray(content) ? content.filter((p) => p && p.text) : [{ text: String(content ?? "") }]);
export const textOf = (content) => partsOf(content).map((p) => p.text).join("");

// Wraps a model so every call reports its token usage to `sink` and carries a stable cache key for its purpose.
export function metered(llm, { sink = () => {}, channelId = "" } = {}) {
  const keys = new Map();
  const keyOf = (purpose) => {
    if (!keys.has(purpose)) keys.set(purpose, `acerciae-gm-${crypto.createHash("sha256").update(`${channelId}\n${purpose}`).digest("hex").slice(0, 32)}`);
    return keys.get(purpose);
  };
  const wrapped = Object.create(llm);
  wrapped.complete = (req) => llm.complete({ ...req, cacheKey: req.cacheKey ?? keyOf(req.purpose ?? ""), onUsage: (u) => { try { sink({ purpose: req.purpose ?? "", ...u }); } catch { /* usage is best effort */ } req.onUsage?.(u); } });
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
