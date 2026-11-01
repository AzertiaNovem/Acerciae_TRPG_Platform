// Improvisation mode: no module. The story grows from a world setting the Keeper writes, the investigators' own
// personalities and backgrounds, and the players' choices.
//   world   – the public setting: posted in the Main Chat for the human players, given to the GM, the real NPCs and
//             every co-player;
//   secrets – the Keeper's own hidden layer (what is really going on), given to the GM and the real NPCs only;
//   truths  – hidden facts the GM decides during play (the `truth` action), kept so the story stays consistent.
// The texts come from the Keeper's own files (`--world`, `--secrets`) and are kept in the state file.
import crypto from "node:crypto";
import fs from "node:fs";

export const WORLD_MAX = 30000;
export const SECRETS_MAX = 20000;
const TRUTHS_KEPT = 100;
const TRUTH_MAX = 500;
const CHUNK = 4000;

export function improvState(s) {
  const x = s && typeof s === "object" ? s : {};
  return {
    on: Boolean(x.on),
    world: String(x.world ?? ""),
    secrets: String(x.secrets ?? ""),
    truths: Array.isArray(x.truths) ? x.truths.filter((t) => t && t.text).slice(-TRUTHS_KEPT) : [],
    published: { hash: x.published?.hash ?? null, ids: Array.isArray(x.published?.ids) ? x.published.ids : [] },
  };
}

export const hashText = (t) => crypto.createHash("sha256").update(String(t)).digest("hex").slice(0, 16);

// Reads one of the Keeper's setting files: plain text or Markdown, used as written.
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

// The world setting as chat messages: split at paragraph (then line) breaks, each under the platform's message limit.
export function worldMessages(world) {
  const parts = [];
  let cur = "";
  for (const para of String(world).split(/\n{2,}/)) {
    for (const piece of para.length > CHUNK ? para.match(new RegExp(`[\\s\\S]{1,${CHUNK}}`, "g")) : [para]) {
      if (cur && cur.length + piece.length + 2 > CHUNK) { parts.push(cur); cur = ""; }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) parts.push(cur);
  return parts.map((p, i) => `World setting${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ""}\n\n${p}`);
}

// The GM's sections: the shared world and the hidden layer.
export function improvSections(improv) {
  if (!improv?.on) return [];
  const out = [`## World setting (everyone knows this: it is posted in the Main Chat, and the co-players have it)\n${improv.world || "(none written yet)"}`];
  const hidden = [improv.secrets, ...improv.truths.map((t) => `- ${t.text}`)].filter(Boolean);
  out.push(`## Hidden truths (yours alone: never state them outright; let the investigators uncover them through play)\n${hidden.join("\n") || "(none yet: decide them as the story needs, and record them with truth)"}`);
  return out;
}
