// Improvisation mode: no module. The story grows from a world setting the GM writes, the investigators' own
// personalities and backgrounds, and the players' choices.
//   world   – the public setting (the worldbook's bible): given to the GM, the real NPCs and every co-player;
//   secrets – the GM's own hidden layer (what is really going on), given to the GM and the real NPCs only;
//   truths  – hidden facts the GM decides during play (the `truth` action), kept so the story stays consistent.
// The texts come from the GM's own files (`--world`, `--secrets`), the Forge or the worldbook the host's Web UI edits
// (worldbook.mjs), and are kept in the state file. Nothing of the world is posted in the chat: players read the
// worldbook where the agent runs. `book` records which revision of the worldbook file the texts were last synced with.
import crypto from "node:crypto";
import fs from "node:fs";

export const WORLD_MAX = 30000;
export const SECRETS_MAX = 20000;
const TRUTHS_KEPT = 100;
const TRUTH_MAX = 500;

export function improvState(s) {
  const x = s && typeof s === "object" ? s : {};
  return {
    on: Boolean(x.on),
    world: String(x.world ?? ""),
    secrets: String(x.secrets ?? ""),
    truths: Array.isArray(x.truths) ? x.truths.filter((t) => t && t.text).slice(-TRUTHS_KEPT) : [],
    published: { hash: x.published?.hash ?? null, ids: Array.isArray(x.published?.ids) ? x.published.ids : [] },
    declared: x.declared && typeof x.declared === "object" ? { ...x.declared } : {},   // text hashes handed to the platform's world record
    book: x.book && typeof x.book === "object" && Number.isInteger(x.book.revision) ? { revision: x.book.revision, hash: String(x.book.hash ?? "") } : null,
  };
}

export const hashText = (t) => crypto.createHash("sha256").update(String(t)).digest("hex").slice(0, 16);

// Reads one of the GM's setting files: plain text or Markdown, used as written.
export function readSetting(file, { what, max }) {
  let text;
  try { text = fs.readFileSync(file, "utf8").trim(); } catch (e) { throw new Error(`cannot read the ${what} file ${file}: ${e.message}`); }
  if (!text) throw new Error(`the ${what} file ${file} is empty`);
  if (text.length > max) throw new Error(`the ${what} file is ${text.length} characters; at most ${max}`);
  return text;
}

export function addTruth(improv, text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, TRUTH_MAX);
  if (!t || improv.truths.some((x) => x.text === t)) return false;
  improv.truths.push({ text: t, at: new Date().toISOString() });
  improv.truths = improv.truths.slice(-TRUTHS_KEPT);
  return true;
}

// The GM's sections: the shared world and the hidden layer.
export function improvSections(improv) {
  if (!improv?.on) return [];
  const out = [`## World setting (the world bible: everyone in the story knows this, and the co-players have it)\n${improv.world || "(none written yet)"}`];
  const hidden = [improv.secrets, ...improv.truths.map((t) => `- ${t.text}`)].filter(Boolean);
  out.push(`## Hidden truths (yours alone: never state them outright; let the investigators uncover them through play)\n${hidden.join("\n") || "(none yet: decide them as the story needs, and record them with truth)"}`);
  return out;
}
