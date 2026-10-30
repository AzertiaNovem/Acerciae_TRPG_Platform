// A co-player's turn. Its model is given its own role card and persona, its companions' basic details and
// backgrounds (profiles.mjs), and the chat log its character witnessed (coplayerContext.mjs). It gets nothing from the
// Keeper's side: no Keeper notes, no platform AI tips, no real NPC's details, no other window and no other character's
// whispers.
import { completeJson } from "./llm/index.mjs";
import { renderLine } from "./context/coplayerContext.mjs";
import { renderProfile } from "./context/profiles.mjs";

// Co-players may roll checks and sanity against their own sheet; they never edit sheets (.st / .en) or roll hidden.
const ROLL = /^\.(ra|rc|r|sc)(\s|$)/i;

export function coplayerSystem(language) {
  return `You play one investigator in a Call of Cthulhu 7th edition game on an online table, alongside human players. The Keeper (GM) runs the world. You are a fellow player, not the Keeper and not the protagonist.

How to play:
- Stay in character, true to your persona and role card. Know only what your character saw or heard in the chat log below.
- You know your companions' basic details and backgrounds: let them shape how you treat each other in character, but do not recite them.
- Be a good tablemate: support the human players, follow up on their ideas, do not take over the scene or solve the mystery alone. Short lines (1-3 sentences).
- Never narrate outcomes, the world or other characters' actions; that is the Keeper's job.
- If the Keeper asked you to roll, or an uncertain action needs a check, reply with a roll using a Sealdice command such as ".ra Spot Hidden" (the platform rolls it against your sheet).
- Pass when you have nothing useful to add, or when the last lines were addressed to someone else.
- Write all text in ${language}.

Reply with only one JSON object: {"action": "speak", "kind": "ic" | "ooc", "text": "..."} or {"action": "roll", "command": ".ra <skill>", "text": "<optional short line>"} or {"action": "pass"}`;
}

export function validateCoplayer(x) {
  if (!x || typeof x !== "object") throw new Error("expected an object");
  if (x.action === "pass") return { action: "pass" };
  if (x.action === "speak") {
    const text = String(x.text ?? "").trim();
    if (!text) return { action: "pass" };
    return { action: "speak", kind: x.kind === "ooc" ? "ooc" : "ic", text };
  }
  if (x.action === "roll") {
    const command = String(x.command ?? "").trim();
    if (!ROLL.test(command)) throw new Error(`unsupported roll command "${command}"`);
    return { action: "roll", command, text: String(x.text ?? "").trim() };
  }
  throw new Error(`unknown action "${x.action}"`);
}

function cardSummary(card) {
  if (!card) return "(not available)";
  const ch = Object.entries(card.characteristics ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  const sk = Object.entries(card.skills ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${v}`).join(", ");
  const d = card.derived ?? {};
  const b = card.basic ?? {};
  return [
    `occupation: ${b.occupation ?? ""}, age ${b.age ?? ""}, ${b.sex ?? ""}, from ${b.birthplace ?? ""}, lives in ${b.residence ?? ""}`,
    `characteristics: ${ch}`,
    `HP ${d.hp ?? "?"}/${d.hp_max ?? "?"}, SAN ${d.san ?? "?"}, MP ${d.mp ?? "?"}, MOV ${d.mov ?? "?"}, damage bonus ${d.db ?? "0"}`,
    `skills: ${sk}`,
    `background: ${Object.entries(card.background ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ")}`,
    `carrying: ${(card.items ?? []).map((i) => i.name).join(", ")}`,
  ].join("\n");
}

export async function coplayerTurn(llm, { language, coplayer, card, companions = [], log, spotlight }) {
  const newest = log[log.length - 1];
  const user = [
    `YOU ARE: ${coplayer.name}`,
    `PERSONA: ${coplayer.persona || "(none)"}`,
    `SPEAKING STYLE: ${coplayer.speakingStyle || "(natural)"}`,
    `YOUR ROLE CARD:\n${cardSummary(card)}`,
    `THE OTHER INVESTIGATORS (what you know about your companions):\n${companions.map((c) => renderProfile(c)).join("\n") || "(none)"}`,
    "",
    `CHAT LOG YOUR CHARACTER WITNESSED (newest last):\n${log.map((m) => renderLine(m)).join("\n") || "(nothing yet)"}`,
    newest ? `NEWEST LINE: ${renderLine(newest)}` : "",
    spotlight ? "The Keeper turned to you: it is a good moment to act." : "",
    "Your move?",
  ].filter(Boolean).join("\n");
  return completeJson(llm, { system: coplayerSystem(language), user, purpose: "coplayer_turn" }, validateCoplayer);
}
