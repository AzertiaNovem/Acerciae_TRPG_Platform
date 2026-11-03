// Local lexical recall, never another model/embedding call. Callers must filter candidates by visibility first.
import { estimateTokens } from "../memory.mjs";

const STOP = new Set("the and that this with from have what when where who how about into your you are was were will would could should does did not for our but then just again something someone there here 我们 你们 他们 这个 那个 什么 怎么 现在 然后 一个 没有 可以 已经 还是 自己 这里 那里".split(" "));
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
function terms(text) {
  const out = new Set();
  for (const { segment, isWordLike } of segmenter.segment(String(text ?? "").normalize("NFKC").toLowerCase())) {
    if (!isWordLike || segment.length < 2 || STOP.has(segment) || /^\d+$/.test(segment)) continue;
    out.add(segment);
    // Also match Chinese names/phrases whose word segmentation differs between sentences.
    if (/^\p{Script=Han}+$/u.test(segment)) for (let i = 0; i < segment.length - 1; i++) out.add(segment.slice(i, i + 2));
  }
  return out;
}

// A hard ceiling in the same approximate token units as the rest of the client; never split a surrogate pair.
export function clipTokens(value, budget) {
  const text = String(value ?? "");
  if (estimateTokens(text) <= budget) return text;
  if (budget <= 1) return "";
  const chars = Array.from(text);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(chars.slice(0, mid).join("") + "…") <= budget) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("") + "…";
}

// Candidates: {text (source-labelled), match (searchable content)}. Prefer rare shared terms, then original order.
// Only relevant excerpts are returned; no filler when the query has no matches. Duplicates count once.
export function recall(query, candidates, budget, { heading = "## Relevant earlier records", limit = 6 } = {}) {
  if (budget <= 0) return "";
  const wanted = terms(String(query ?? "").slice(-4000));
  if (!wanted.size) return "";
  const seen = new Set();
  const rows = [];
  for (const c of candidates) {
    const key = String(c.match ?? c.text).replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const text = String(c.text);
    const chars = Array.from(key);
    const source = c.source ?? (text.endsWith(c.match ?? text) ? text.slice(0, text.length - String(c.match ?? text).length) : "");
    for (let i = 0; i < chars.length; i += 448) {
      const chunk = chars.slice(i, i + 512).join("");
      const found = [...terms(chunk)].filter((t) => wanted.has(t));
      if (found.length) rows.push({ source, chunk, offset: i, found, order: rows.length });
    }
  }
  const counts = new Map();
  for (const row of rows) for (const t of row.found) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const row of rows) row.score = row.found.reduce((n, t) => n + Math.log(1 + seen.size / counts.get(t)), 0);
  rows.sort((a, b) => b.score - a.score || a.order - b.order);
  const intro = `${heading}\nSource excerpts, not new events. Earlier statements may be outdated; current records and recent corrections take precedence. Do not infer missing facts.\n`;
  let result = intro, kept = 0;
  for (const row of rows) {
    if (kept >= limit) break;
    const remaining = budget - estimateTokens(result) - 2;
    if (remaining < 40) break;
    const cap = Math.min(remaining, Math.max(80, Math.floor(budget / 3)));
    const strongest = [...row.found].sort((a, b) => counts.get(a) - counts.get(b) || b.length - a.length);
    const at = row.chunk.toLowerCase().indexOf(strongest[0]);
    // Keep the actual hit when a long record only mentions the subject near its end.
    const start = estimateTokens(row.source + row.chunk) > cap ? Math.max(0, at - 40) : 0;
    const focused = row.chunk.slice(start).replace(/^[\uDC00-\uDFFF]/, "");
    const excerpt = clipTokens(`${row.source}${row.offset || start ? "…" : ""}${focused}`, cap);
    result += `${excerpt}\n`;
    kept++;
  }
  return kept ? clipTokens(result, budget) : "";
}
