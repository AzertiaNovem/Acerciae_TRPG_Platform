// Long context with compaction. The table keeps a local copy of the chat (History, in the store) and gives the models
// as much of it as fits a token budget: the newest lines word for word, older ones compacted into chapters.
//   * The GM (scope "gm") has chapters per window. When a window's lines since its last chapter pass ~60% of
//     GM_CONTEXT_TOKENS, the oldest half becomes a chapter; when a window's chapters pass ~25%, the oldest half of them
//     merge into one chapter a level up. A window whose scene is over is compacted whole.
//   * Each co-player (scope "coplayer:<id>") has its own chapters, written in the first person from the lines it
//     witnessed (its seats, its timeline) and nothing else, with the same thresholds on COPLAYER_CONTEXT_TOKENS.
// Compacting half at a time keeps the models' cached prefix stable between compactions (see context layout in
// gmContext.mjs and coplayer.mjs). Compaction runs beside the turns, one job per scope at a time.
import { COC_VOCAB } from "./rules/vocab.mjs";
import { completeJson } from "./llm/index.mjs";

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/g;
// A cheap token estimate: CJK characters count one each, other text about 3.5 characters a token.
export function estimateTokens(text) {
  const s = String(text ?? "");
  const cjk = (s.match(CJK) ?? []).length;
  return Math.ceil(cjk + (s.length - cjk) / 3.5);
}

export const CHUNK_LINES = 50;   // raw lines are frozen in chunks of this size, so the cached prefix grows in steps

// The chat as the GM account reads it, kept in the store. Live lines arrive through `add`; `sync` refreshes a
// window's newest page, fills any gap since its last sync and, the first time, backfills up to HISTORY_BACKFILL_LINES
// older lines.
export class History {
  constructor({ api, store, channelId, pageSize = 100, backfill = 1000, log = () => {} }) {
    Object.assign(this, { api, store, channelId, pageSize, backfill, log });
  }

  add(m) { if (m && Number.isFinite(m.seq) && m.chat_window_id) this.store.putLines([m]); }

  // `synced:<window>` is the newest line a sync has fetched with everything before it (back to the backfill bound);
  // lines that arrive live are stored too but do not move it, so a gap behind them (a dropped connection, the table
  // being down) is still found and filled.
  async sync(windowId) {
    const synced = this.store.get(`synced:${windowId}`);
    let page = (await this.api.messages(this.channelId, windowId, this.pageSize).catch(() => null)) ?? [];
    this.store.putLines(page);
    const newest = page.length ? Math.max(...page.map((m) => m.seq)) : synced;
    let fetched = page.length;
    while (page.length >= this.pageSize && fetched < this.backfill) {
      const oldest = Math.min(...page.map((m) => m.seq));
      if (synced !== null && oldest <= synced) break;
      page = (await this.api.messages(this.channelId, windowId, this.pageSize, oldest).catch(() => null)) ?? [];
      this.store.putLines(page);
      fetched += page.length;
    }
    if (newest !== null && newest !== undefined) this.store.set(`synced:${windowId}`, Math.max(newest, synced ?? 0));
  }

  lines(windowId, opts) { return this.store.lines(windowId, opts); }
}

const chapterText = (c) => c.text;
const words = (tokens) => Math.max(120, Math.min(1500, Math.round(tokens * 0.6)));

export class Memory {
  constructor({ store, llm, language = "English", gmBudget = 60000, coplayerBudget = 24000, log = () => {} }) {
    Object.assign(this, { store, llm, language, gmBudget, coplayerBudget, log });
    this.vocab = COC_VOCAB;   // the rule system's words for the prompts (rules/vocab.mjs); the table sets it
    this.jobs = new Map();   // scope → running compaction
  }

  // Waits for every running compaction (tests, shutdown).
  async idle() { while (this.jobs.size) await Promise.allSettled([...this.jobs.values()]); }

  // One job per scope; a second request while one runs is dropped (the next turn asks again).
  run(scope, fn) {
    if (this.jobs.has(scope)) return this.jobs.get(scope);
    const job = Promise.resolve().then(fn).catch((e) => this.log(`memory ${scope}: ${e.message}`)).finally(() => this.jobs.delete(scope));
    this.jobs.set(scope, job);
    return job;
  }

  // ---- the GM's memory of a window
  gmChapters(windowId) { return this.store.chapters("gm", windowId); }
  // Raw lines since the window's last chapter.
  gmRaw(windowId, lines) {
    const chapters = this.gmChapters(windowId);
    const after = chapters.length ? Math.max(...chapters.map((c) => c.toSeq)) : 0;
    return lines.filter((m) => m.seq > after);
  }

  // Compacts a window when it has grown past its thresholds. `render` turns a line into the text the GM reads.
  maintainGm(windowId, lines, render, { windowName = "this window", whole = false } = {}) {
    return this.run(`gm:${windowId}`, async () => {
      const raw = this.gmRaw(windowId, lines);
      const rawTokens = estimateTokens(raw.map(render).join("\n"));
      if (raw.length && (whole || rawTokens > this.gmBudget * 0.6)) {
        const take = whole ? raw : oldestHalf(raw, render);
        const prev = this.gmChapters(windowId).at(-1);
        const summary = await this.summarise("compact", gmSystem(this.language, words(estimateTokens(take.map(render).join("\n")) * 0.25), windowName, false, this.vocab), [
          prev ? `PREVIOUS CHAPTER (for continuity; do not repeat it):\n${prev.text}` : "",
          `LINES:\n${take.map(render).join("\n")}`,
        ]);
        this.store.addChapter({ scope: "gm", windowId, fromSeq: take[0].seq, toSeq: take.at(-1).seq, level: 0, text: summary });
        this.log(`memory: "${windowName}" lines #${take[0].seq}–#${take.at(-1).seq} compacted into a chapter`);
      }
      await this.mergeIfLong("gm", windowId, this.gmBudget, `"${windowName}"`);
    });
  }

  // ---- a co-player's own memory (scope coplayer:<id>; not per window: it follows the character)
  coplayerScope(coplayer) { return `coplayer:${coplayer.characterId}`; }
  coplayerChapters(coplayer) { return this.store.chapters(this.coplayerScope(coplayer), ""); }
  coplayerRaw(coplayer, witnessed) {
    const chapters = this.coplayerChapters(coplayer);
    const after = chapters.length ? Math.max(...chapters.map((c) => c.toSeq)) : 0;
    return witnessed.filter((m) => m.seq > after);
  }

  maintainCoplayer(coplayer, witnessed, render) {
    const scope = this.coplayerScope(coplayer);
    return this.run(scope, async () => {
      const raw = this.coplayerRaw(coplayer, witnessed);
      if (raw.length && estimateTokens(raw.map(render).join("\n")) > this.coplayerBudget * 0.6) {
        const take = oldestHalf(raw, render);
        const prev = this.coplayerChapters(coplayer).at(-1);
        const summary = await this.summarise("coplayer_memory", coplayerSystem(this.language, coplayer.name, words(estimateTokens(take.map(render).join("\n")) * 0.25), false, this.vocab), [
          prev ? `WHAT YOU ALREADY REMEMBER (for continuity; do not repeat it):\n${prev.text}` : "",
          `LINES:\n${take.map(render).join("\n")}`,
        ]);
        this.store.addChapter({ scope, fromSeq: take[0].seq, toSeq: take.at(-1).seq, level: 0, text: summary });
        this.log(`memory: ${coplayer.name} remembers lines #${take[0].seq}–#${take.at(-1).seq} as a chapter`);
      }
      await this.mergeIfLong(scope, "", this.coplayerBudget, coplayer.name, coplayer.name);
    });
  }

  // Chapters past ~25% of the budget: the oldest half merge into one chapter a level up.
  async mergeIfLong(scope, windowId, budget, label, firstPerson = null) {
    const chapters = this.store.chapters(scope, windowId);
    if (chapters.length < 2 || estimateTokens(chapters.map(chapterText).join("\n")) <= budget * 0.25) return;
    const take = chapters.slice(0, Math.max(2, Math.floor(chapters.length / 2)));
    const system = firstPerson ? coplayerSystem(this.language, firstPerson, words(budget * 0.08), true, this.vocab) : gmSystem(this.language, words(budget * 0.08), label, true, this.vocab);
    const summary = await this.summarise(firstPerson ? "coplayer_memory" : "compact", system, [`CHAPTERS:\n${take.map((c) => `[#${c.fromSeq}–#${c.toSeq}]\n${c.text}`).join("\n\n")}`]);
    this.store.mergeChapters(take.map((c) => c.id), { scope, windowId, fromSeq: take[0].fromSeq, toSeq: take.at(-1).toSeq, level: Math.max(...take.map((c) => c.level)) + 1, text: summary });
    this.log(`memory: ${label}: ${take.length} chapters merged`);
  }

  async summarise(purpose, system, blocks) {
    const out = await completeJson(this.llm, { system, user: blocks.filter(Boolean).join("\n\n"), purpose }, (x) => {
      const s = String(x?.summary ?? "").trim();
      if (!s) throw new Error("summary is empty");
      return s;
    });
    return out;
  }
}

// The oldest lines making up about half the tokens (at least one line, never all but when there is just one).
function oldestHalf(lines, render) {
  const total = estimateTokens(lines.map(render).join("\n"));
  let sum = 0, n = 0;
  while (n < lines.length - 1 && sum < total / 2) sum += estimateTokens(render(lines[n++]));
  return lines.slice(0, Math.max(1, n));
}

const gmSystem = (language, maxWords, where, merge = false, v = COC_VOCAB) => `You keep the ${v.gm}'s memory of a long tabletop roleplaying campaign. ${merge ? "Merge the chapters below into one chapter, oldest first" : `Summarise the chat lines below from ${where} into a chapter of the story so far`}, in ${language}.
Keep what later play depends on: who did what, people and places by name, clues found, promises, debts and threats, decisions, open questions, ${v.losses}, and where each ${v.pc} ended up. Keep the line numbers (#seq) of key moments. Keep anything marked [${v.gm} only] or whispered marked the same way: it stays in the ${v.gm}'s memory and must not read as public. Leave out table chatter, and dice mechanics except their outcomes.
Write compact prose or short bullet points, at most ${maxWords} words. Reply with only {"summary": "..."}.`;

const coplayerSystem = (language, name, maxWords, merge = false, v = COC_VOCAB) => `You are ${name}, an ${v.pc} in a long tabletop roleplaying campaign. ${merge ? "Merge these memories of yours into one, oldest first" : "Write what you remember of the moments below"}, in the first person, in ${language}.
Only what you saw, heard, said and did: the lines are exactly what you witnessed. Keep people and places by name, what you learned, promises you made or were made, who you trust or fear, your injuries and fears, and where you ended up. Keep the line numbers (#seq) of key moments. Leave out table chatter and dice mechanics except their outcomes.
At most ${maxWords} words. Reply with only {"summary": "..."}.`;
