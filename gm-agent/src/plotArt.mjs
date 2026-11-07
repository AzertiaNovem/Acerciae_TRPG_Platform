// Pictures of past plots, on request: a player writes "/画 <the moment>" (or /插画, /draw, /illustrate) in the planner
// window. The request never reaches the story planner: the table finds the stretch of play the player means, however
// long ago it was, and has the platform draw it into the planner window at once.
//   1. A model call (`plot_search`) reads the scenarios and the GM's chapters of the windows this player can read, and
//      says which scenario or chapter it is most likely in and which words its lines will contain.
//   2. Those words are looked up in the local copy of the chat and in the platform's message search (the whole
//      history); only lines the player can read count. The densest cluster of matches is the place.
//   3. A second call (`plot_illustration`) reads the lines around it and picks the moment, or says it is not there.
// What may be drawn: lines of the windows the player is a member of (and the Main Chat), posted for the whole window,
// never a whisper, a GM-only note, a phone or another table window.
import { completeJson } from "./llm/index.mjs";
import { normalizeIllustration } from "./illustrations.mjs";

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
    notFound: "🎨 I could not find that moment in the chat you can read. Add a detail or two: who was there, where it was, what happened.",
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
    notFound: "🎨 没能在你看得到的聊天记录里找到这段剧情。可以再补充一两个细节：有谁在场、在哪里、发生了什么。",
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
    notFound: "🎨 沒能在你看得到的聊天紀錄裡找到這段劇情。可以再補充一兩個細節：有誰在場、在哪裡、發生了什麼。",
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

const LOCATE_SYSTEM = `You help find a moment from earlier play in the chat history of an online tabletop roleplaying campaign. A player wants a picture of it and described it in their own words. You get the campaign's scenarios and the GM's chapter summaries of the windows this player can read.

Work out which moment they mean. Give search terms that will find its lines in the chat: the names of the people, places and things involved, and distinctive words likely to appear word for word in those lines, in the chat's own language and spelling. Give 2 to 6 terms of one to four words each; never generic words (the, said, 我们, 然后). Say which scenario (S…) and which chapter (C…) it is most likely in, or null when you cannot tell.

Reply with only one JSON object:
{"terms": ["<term>", ...], "scenario": "S1" | null, "chapter": "C1" | null}`;

// Where to look: {terms, scenario, chapter} (scenario and chapter are the keys given, or null).
export async function locatePlot(llm, { request, requester = [], cast = [], scenarios = [], chapters = [] }) {
  const user = [
    `THE PLAYER'S REQUEST: ${request}`,
    requester.length ? `THE PLAYER'S CHARACTER: ${requester.join(", ")}` : "",
    cast.length ? `CAST: ${cast.join(", ")}` : "",
    scenarios.length ? `SCENARIOS (oldest first):\n${scenarios.map((s) => `${s.key} ${s.title || "(untitled)"}${s.location ? ` @ ${s.location}` : ""}${s.time ? ` (${s.time})` : ""}${s.summary ? `: ${clip(s.summary, 600)}` : ""}`).join("\n")}` : "SCENARIOS: (none recorded)",
    chapters.length ? `CHAPTERS (the GM's summaries of earlier play, by window, oldest first):\n${chapters.map((c) => `${c.key} [${c.window}] ${clip(c.text, 900)}`).join("\n")}` : "CHAPTERS: (none yet: the play is recent enough to be read in full)",
  ].filter(Boolean).join("\n\n");
  const keys = new Set([...scenarios, ...chapters].map((x) => x.key));
  return completeJson(llm, { system: LOCATE_SYSTEM, user, purpose: "plot_search" }, (x) => {
    const terms = [...new Set((Array.isArray(x?.terms) ? x.terms : []).map((t) => clip(t, 40)).filter((t) => t.length >= 1))].slice(0, 8);
    const key = (v) => (keys.has(String(v ?? "")) ? String(v) : null);
    return { terms, scenario: key(x?.scenario), chapter: key(x?.chapter) };
  });
}

// The best place among `hits` ([{windowId, seq, terms: Set}]): where the most different terms meet within `span`
// seqs of each other in one window, then the most matches; a tie goes to the newer place. Its seq is the middle match.
export function bestPlace(hits, span = 400) {
  let best = null;
  for (const h of hits) {
    const near = hits.filter((o) => o.windowId === h.windowId && Math.abs(o.seq - h.seq) <= span).map((o) => o.seq).sort((a, b) => a - b);
    const terms = new Set(hits.filter((o) => o.windowId === h.windowId && Math.abs(o.seq - h.seq) <= span).flatMap((o) => [...o.terms]));
    const score = terms.size * 1000 + near.length;
    if (!best || score > best.score || (score === best.score && h.seq > best.at)) best = { windowId: h.windowId, seq: near[Math.floor((near.length - 1) / 2)], at: h.seq, score };
  }
  return best && { windowId: best.windowId, seq: best.seq, score: best.score };
}

const PICK_SYSTEM = (language) => `You are the art director of an online tabletop roleplaying campaign. A player asked for a picture of a moment from earlier play, in their own words. You are given the stretch of play a search found; the player has seen all of it.

Find the moment the player means in these lines. If it is not there, reply {"found": false}. Otherwise describe it for a painter as one frozen moment: who is there and what they are doing, the place, the light, the colours and the mood, in at most 120 words. Use only what happens in the lines; follow the player's wishes about framing and style where the lines allow, but invent no event, reveal no secret, and put no dialogue or words in the picture. Name the characters who appear in it, at most four, exactly as they are named in the cast. Choose the frame: landscape for places and groups, portrait for a single figure, square otherwise.

Write the description in ${language}. Reply with only one JSON object:
{"found": true, "moment": "<the description>", "who": ["<character names>"], "orientation": "landscape" | "portrait" | "square", "why": "<one short line: which part of the play it is>"}`;

// The requested moment: {found, text, who, orientation, why}.
export async function pickRequestedMoment(llm, { language, request, era = "", cast = [], window = "", lines }) {
  const user = [
    `THE PLAYER'S REQUEST: ${request}`,
    era ? `ERA: ${era}` : "",
    `CAST: ${cast.join(", ") || "(none named)"}`,
    `PLAY${window ? ` in "${window}"` : ""} (oldest first):\n${lines}`,
  ].filter(Boolean).join("\n\n");
  return completeJson(llm, { system: PICK_SYSTEM(language), user, purpose: "plot_illustration" }, (x) => {
    if (x?.found === false) return { found: false, text: "", who: [], orientation: "landscape", why: "" };
    const n = normalizeIllustration(x);
    if (!n.text) throw new Error("moment is required, or found: false");
    return { found: true, ...n, why: clip(x.why, 300) };
  });
}
