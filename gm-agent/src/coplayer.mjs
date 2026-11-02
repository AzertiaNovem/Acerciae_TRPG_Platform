// A co-player's turn. Its model is given its own role card and persona, its companions' basic details and
// backgrounds (profiles.mjs), and the chat log its character witnessed (coplayerContext.mjs). It gets nothing from the
// Keeper's side: no Keeper notes, no platform AI tips, no real NPC's details, no other window and no other character's
// whispers.
import { completeJson } from "./llm/index.mjs";
import { renderLine } from "./context/coplayerContext.mjs";
import { renderProfile } from "./context/profiles.mjs";
import { CHUNK_LINES } from "./memory.mjs";

// Co-players may roll checks and sanity against their own sheet; they never edit sheets (.st / .en) or roll hidden.
const ROLL = /^\.(ra|rc|r|sc)(\s|$)/i;

// `improv`: a Basic Roleplaying game on the CoC presets, its tone the world's. `casual`: the co-player may also text a
// player character on their phone (casual.mjs).
export function coplayerSystem(language, { improv = false, casual = false } = {}) {
  return `You play one investigator in ${improv ? "a Basic Roleplaying (BRP) game using the Call of Cthulhu 7th edition presets, whose genre and tone follow its world setting," : "a Call of Cthulhu 7th edition game"} on an online table, alongside human players. The Keeper (GM) runs the world. You are a fellow player, not the Keeper and not the protagonist.

How to play:
- Stay in character, true to your persona and role card. Know only what your character saw or heard in the chat log below.
- You know your companions' basic details and backgrounds, what anyone would notice about the people you have met (gender, age, what is most striking about them) and the relationships you know of: let them shape how you treat each other in character, but do not recite them.
- Keep to the story's date (TODAY IN THE STORY): weekdays, seasons, how long ago things happened. When time has passed, you lived through it too. Everyday life (school, work, seasons, festivals) goes on around you: let it fill your days and your talk.
- Companions may have lived through scenes you were not part of. When one tells you about something, it happened where and when they were, not here and now; you know only what they tell you.
- Be a good tablemate: support the human players, follow up on their ideas, do not take over the scene or solve the mystery alone. Short lines (1-3 sentences).
- Never narrate outcomes, the world or other characters' actions; that is the Keeper's job.
- If the Keeper asked you to roll, or an uncertain action needs a check, reply with a roll using a Sealdice command such as ".ra Spot Hidden" (the platform rolls it against your sheet).
- Pass when you have nothing useful to add, or when the last lines were addressed to someone else.
- Write all text in ${language}.${casual ? `
- This is a casual game: everyone has a phone, even if the setting has none. Now and then, when it fits, you may text a player character instead of speaking in the scene (a plan, a joke, something you noticed), never to flood them.` : ""}

Reply with only one JSON object: {"action": "speak", "kind": "ic" | "ooc", "text": "..."} or {"action": "roll", "command": ".ra <skill>", "text": "<optional short line>"}${casual ? ` or {"action": "text", "to": "<a player character>", "text": "<the text message>"}` : ""} or {"action": "pass"}`;
}

// Who the co-player is: the stable head of every prompt it gets.
export function coplayerSelf({ coplayer, card, world = "" }) {
  return [
    `YOU ARE: ${coplayer.name}`,
    `PERSONA: ${coplayer.persona || "(none)"}`,
    `SPEAKING STYLE: ${coplayer.speakingStyle || "(natural)"}`,
    `YOUR ROLE CARD:\n${cardSummary(card)}`,
    world ? `THE WORLD (the setting everyone at the table shares; your persona and background are your own story in it):\n${world}` : "",
  ].filter(Boolean).join("\n");
}

export function validateCoplayer(x, { casual = false } = {}) {
  if (!x || typeof x !== "object") throw new Error("expected an object");
  if (x.action === "pass") return { action: "pass" };
  if (x.action === "text" && casual) {
    const text = String(x.text ?? "").trim();
    return text && x.to ? { action: "text", to: String(x.to), text } : { action: "pass" };
  }
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

// `timeline` is the co-player's own thread (name, time, place; never the GM's notes). `side` is true in a
// co-players-only window, where no human player is there to lead.
// `companions` are the other investigators; those in `withYou` (character ids) are in the same scene right now.
// `world` is the improvisation mode's public world setting (empty otherwise). `memories` are the co-player's own
// compacted chapters (memory.mjs); `log` the lines it witnessed since them.
// The prompt is laid out stable-first (llm/parts.mjs): who it is, then its memories and older lines in frozen chunks
// (cached), then what changes every turn.
// `impulse` is the story planner's one private urge for this co-player (planner.mjs renderImpulse), uncached.
// `today` is the story's date as this co-player lives it (calendar.mjs), `timePassed` a line when the calendar moved
// on since it last acted; `met` the NPCs it has met (rendered), `bonds` the relationships it knows (bonds.mjs).
export async function coplayerTurn(llm, { language, coplayer, card, companions = [], withYou = null, log, memories = [], spotlight, timeline = null, side = false, world = "", improv = false, casual = false, phone = "", impulse = "", today = "", routine = "", timePassed = "", met = "", bonds = "" }) {
  const here = withYou ? companions.filter((c) => withYou.includes(c.id)) : companions;
  const away = withYou ? companions.filter((c) => !withYou.includes(c.id)) : [];
  const newest = log[log.length - 1];
  const frozen = log.slice(0, Math.floor(log.length / CHUNK_LINES) * CHUNK_LINES);
  const recent = log.slice(frozen.length);
  const self = coplayerSelf({ coplayer, card, world });
  const past = [
    memories.length ? `WHAT YOU REMEMBER (your own memories of earlier play, oldest first):\n${memories.join("\n\n")}` : "",
    frozen.length ? `CHAT LOG YOUR CHARACTER WITNESSED, earlier part (oldest first):\n${frozen.map((m) => renderLine(m)).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const now = [
    phone ? `YOUR PHONE (recent text messages, oldest first):\n${phone}` : "",
    today ? `TODAY IN THE STORY: ${today}` : "",
    routine ? `${routine} (common knowledge: everyone in the story knows it)` : "",
    timePassed,
    timeline ? `YOUR TIMELINE: ${timeline.name}${timeline.narrativeTime ? `; time: ${timeline.narrativeTime}` : ""}${timeline.location ? `; place: ${timeline.location}` : ""}` : "",
    side ? "No human player is with you here: you and your companions drive this thread yourselves. Choose, investigate, talk to the people you meet; still never narrate outcomes." : "",
    `THE OTHER INVESTIGATORS (what you know about your companions)${withYou ? " — WITH YOU HERE" : ""}:\n${here.map((c) => renderProfile(c)).join("\n") || "(none)"}`,
    away.length ? `ELSEWHERE (not in this scene; talk to them only when you meet again):\n${away.map((c) => renderProfile(c)).join("\n")}` : "",
    met,
    bonds,
    impulse,
    "",
    `CHAT LOG YOUR CHARACTER WITNESSED${frozen.length ? ", latest part" : ""} (newest last):\n${recent.map((m) => renderLine(m)).join("\n") || (frozen.length ? "(see above)" : "(nothing yet)")}`,
    newest ? `NEWEST LINE: ${renderLine(newest)}` : "",
    spotlight ? "The Keeper turned to you: it is a good moment to act." : "",
    "Your move?",
  ].filter(Boolean).join("\n");
  const user = [{ text: `${self}\n\n`, cache: true }, ...(past ? [{ text: `${past}\n\n`, cache: true }] : []), { text: now }];
  return completeJson(llm, { system: coplayerSystem(language, { improv, casual }), user, purpose: "coplayer_turn" }, (x) => validateCoplayer(x, { casual }));
}
