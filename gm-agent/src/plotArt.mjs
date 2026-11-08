// Pictures of past plots, on request: a player writes "/画 <the moment>" (or /插画, /draw, /illustrate) in the planner
// window. The request never reaches the story planner: the table finds the stretch of play the player means, however
// long ago it was, and has the platform draw it into the planner window at once. The search goes by meaning:
//   1. A model call (`plot_search`) reads an index of the whole story (the scenarios, the GM's summaries of earlier
//      play, excerpts of recent play) and names the entries most likely to hold the moment, however the player put it.
//   2. An entry too long to read in full is split into parts, and the model names the part (`plot_search/zoom`).
//   3. A second call (`plot_illustration`) reads those lines and picks the moment, or says it is not there; then the
//      next entry named is tried.
// What may be drawn: lines of any window of play, other players' and co-players' scenes too, posted for the whole
// window; never a whisper, a GM-only note, a phone or another table window.
import { completeJson } from "./llm/index.mjs";
import { MAX_CHARACTERS, normalizeIllustration, outfitBlock, withOutfits } from "./illustrations.mjs";

const COMMAND = /^\/(?:插画|画|draw|illustrate)(?=$|\s|[^\x00-\x7f])\s*([\s\S]*)$/i;
export const REQUEST_MAX = 500;
const MARKS = ["🎨", "🖼️", "🖼"];

// The player's request (possibly empty) when `text` is the command, else null.
export function artRequest(text) {
  const m = COMMAND.exec(String(text ?? "").trim());
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, REQUEST_MAX) : null;
}

// A line the table posted about a picture (its own replies, and the platform's picture line): kept out of every context.
export function isArtLine(m) {
  const text = String(m?.content ?? "").trim();
  return Boolean(m?.media_asset_id) || MARKS.some((mark) => text.startsWith(mark));
}

// A line a picture may draw on: said for the whole window, in play.
export function drawable(m) {
  return Boolean(m) && !m.recalled_at && m.visibility === "window" && ["ic", "narration", "roll"].includes(m.kind) && !m.media_asset_id &&
    !isArtLine(m) && Boolean(String(m.content ?? "").trim());
}

const TEXT = {
  en: {
    usage: "🎨 Write what to draw after the command, for example: /draw the moment we reached the lighthouse at dusk",
    searching: "🎨 Looking for that moment in the story; the picture will appear here when it is drawn.",
    notFound: "🎨 I could not find that moment in the story. Add a detail or two: who was there, where it was, what happened.",
    unavailable: "🎨 Pictures cannot be drawn on this server right now.",
    off: "🎨 Picture requests are turned off for this table.",
    busy: "🎨 Your previous picture is still on its way; ask again once it has arrived.",
    limit: ({ n }) => `🎨 That is ${n} pictures in the last hour; please ask again a little later.`,
    rateLimited: "🎨 The server has drawn as many pictures as it may this hour; please ask again later.",
    failed: "🎨 The picture could not be drawn this time.",
  },
  hans: {
    usage: "🎨 请在命令后写下想画的场面，例如：/画 我们黄昏时抵达灯塔的那一刻",
    searching: "🎨 正在翻找那段剧情，画好后会发在这里。",
    notFound: "🎨 没能在聊天记录里找到这段剧情。可以再补充一两个细节：有谁在场、在哪里、发生了什么。",
    unavailable: "🎨 服务器目前无法绘制插画。",
    off: "🎨 本桌已关闭插画请求。",
    busy: "🎨 你上一张插画还在绘制中，送达后再来吧。",
    limit: ({ n }) => `🎨 最近一小时已经画了 ${n} 张，请稍后再试。`,
    rateLimited: "🎨 服务器本小时的绘图次数已用完，请稍后再试。",
    failed: "🎨 这次没能画出来。",
  },
  hant: {
    usage: "🎨 請在指令後寫下想畫的場面，例如：/畫 我們黃昏時抵達燈塔的那一刻",
    searching: "🎨 正在翻找那段劇情，畫好後會發在這裡。",
    notFound: "🎨 沒能在聊天紀錄裡找到這段劇情。可以再補充一兩個細節：有誰在場、在哪裡、發生了什麼。",
    unavailable: "🎨 伺服器目前無法繪製插畫。",
    off: "🎨 本桌已關閉插畫請求。",
    busy: "🎨 你上一張插畫還在繪製中，送達後再來吧。",
    limit: ({ n }) => `🎨 最近一小時已經畫了 ${n} 張，請稍後再試。`,
    rateLimited: "🎨 伺服器本小時的繪圖次數已用完，請稍後再試。",
    failed: "🎨 這次沒能畫出來。",
  },
};
// The table's reply in its language (Simplified or Traditional Chinese, else English).
export function artText(language, key, vars = {}) {
  const set = /traditional/i.test(language) ? TEXT.hant : /chinese|中文|汉语|漢語/i.test(language) ? TEXT.hans : TEXT.en;
  const v = set[key] ?? TEXT.en[key];
  return typeof v === "function" ? v(vars) : v;
}

const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// The search reads by meaning: the model is shown an index of the whole story and names the entries that hold the
// moment, however differently the player put it. Entries: {key, label, text} (a summary) or {key, label, rows} (a run
// of consecutive lines, shown shortened to fit the budget).
export const PART_LINES = 30;          // recent play and a zoomed stretch are shown in parts of this many lines
export const INDEX_BUDGET = 40000;     // characters of index the model reads at once
export const PICK_BUDGET = 40000;      // characters of play the picker reads (scenarioLines' budget)

// Consecutive runs of `size` lines; with `most`, never more than that many runs (they grow instead).
export function parts(lines, size = PART_LINES, most = Infinity) {
  const n = Math.max(size, Math.ceil(lines.length / most));
  const out = [];
  for (let i = 0; i < lines.length; i += n) out.push(lines.slice(i, i + n));
  return out;
}

// How long a run of rows is when read in full.
export const playLength = (rows) => rows.reduce((n, r) => n + r.who.length + r.text.length + 3, 0);

// The index as text within `budget` characters: summaries as given; runs of lines with each line shortened (to 160
// characters, then less), then with every other line left out, until it fits.
export function renderEntries(entries, budget = INDEX_BUDGET) {
  const shown = (width, step) => entries.map((e) => `${e.key} [${e.label}] ${e.rows ? e.rows.filter((_, i) => i % step === 0).map((r) => `${r.who}: ${clip(r.text, width)}`).join(" / ") : e.text}`).join("\n");
  let width = 160, step = 1, text = shown(width, step);
  while (text.length > budget && width > 40) { width = Math.floor(width * 0.7); text = shown(width, step); }
  while (text.length > budget && step < 16) { step *= 2; text = shown(width, step); }
  return text;
}

const CHOOSE_SYSTEM = (zoom) => `You help find a moment from earlier play in an online tabletop roleplaying campaign. A player wants a picture of it and described it in their own words. ${zoom
  ? "Below is the stretch of play the search found, in consecutive parts (P…), each shortened."
  : "Below is an index of the whole story: the scenarios (S…), the GM's summaries of earlier play (C…, by window, oldest first) and excerpts of more recent play (R…, runs of consecutive lines, shortened)."}

Judge by meaning, not by shared words: the player may describe the moment with other words than the play used, from another character's point of view, in another language, or by what it felt like rather than what was said. Use what the entries tell you about the cast and the story to connect them. Name the ${zoom ? "parts" : "entries"} most likely to hold the moment, best first, at most ${zoom ? "two" : "three"}; an empty list if none fits at all.

Reply with only one JSON object:
{"entries": ["<key>", ...], "why": "<one short line>"}`;

// The entries that hold the moment the player means, best first: {keys, why}.
export async function chooseEntries(llm, { request, requester = [], cast = [], entries, zoom = false }) {
  const user = [
    `THE PLAYER'S REQUEST: ${request}`,
    requester.length ? `THE PLAYER'S CHARACTER: ${requester.join(", ")}` : "",
    cast.length ? `CAST: ${cast.join(", ")}` : "",
    `${zoom ? "PARTS" : "ENTRIES"}:\n${renderEntries(entries)}`,
  ].filter(Boolean).join("\n\n");
  const known = new Set(entries.map((e) => e.key));
  return completeJson(llm, { system: CHOOSE_SYSTEM(zoom), user, purpose: "plot_search", phase: zoom ? "zoom" : "" }, (x) => ({
    keys: [...new Set((Array.isArray(x?.entries) ? x.entries : []).map(String).filter((k) => known.has(k)))].slice(0, zoom ? 2 : 3),
    why: clip(x?.why, 300),
  }));
}

const PICK_SYSTEM = (language) => `You are the art director of an online tabletop roleplaying campaign. A player asked for a picture of a moment from earlier play, in their own words. You are given the stretch of play a search found; the player has seen all of it.

Find the moment the player means in these lines. If it is not there, reply {"found": false}. Otherwise describe it for a painter as one frozen moment: who is there and what they are doing, the place, the light, the colours and the mood, in at most 120 words. Use only what happens in the lines; follow the player's wishes about framing and style where the lines allow, but invent no event, reveal no secret, and put no dialogue or words in the picture. Name the characters who appear in it, at most ${MAX_CHARACTERS}, exactly as they are named in the cast. Choose the frame: landscape for places and groups, portrait for a single figure, square otherwise.

Write the description in ${language}. Reply with only one JSON object:
{"found": true, "moment": "<the description>", "who": ["<character names>"], "orientation": "landscape" | "portrait" | "square", "why": "<one short line: which part of the play it is>"}`;

// The requested moment: {found, text, who, orientation, why}.
export async function pickRequestedMoment(llm, { language, request, era = "", cast = [], window = "", lines, wardrobe = [] }) {
  const user = [
    `THE PLAYER'S REQUEST: ${request}`,
    era ? `ERA: ${era}` : "",
    `CAST: ${cast.join(", ") || "(none named)"}`,
    outfitBlock(wardrobe),
    `PLAY${window ? ` in "${window}"` : ""} (oldest first):\n${lines}`,
  ].filter(Boolean).join("\n\n");
  return completeJson(llm, { system: withOutfits(PICK_SYSTEM(language), wardrobe), user, purpose: "plot_illustration" }, (x) => {
    if (x?.found === false) return { found: false, text: "", who: [], orientation: "landscape", outfits: {}, why: "" };
    const n = normalizeIllustration(x);
    if (!n.text) throw new Error("moment is required, or found: false");
    return { found: true, ...n, why: clip(x.why, 300) };
  });
}
