// A co-player's turn. Its model is given its own role card and persona, its companions' basic details and
// backgrounds (profiles.mjs), and the chat log its character witnessed (coplayerContext.mjs). It gets nothing from the
// GM's side: no GM notes, no platform AI tips, no real NPC's details, no other window and no other character's
// whispers.
import { completeJson } from "./llm/index.mjs";
import { renderLine } from "./context/coplayerContext.mjs";
import { renderProfile } from "./context/profiles.mjs";
import { historyParts } from "./llm/parts.mjs";
import { CHUNK_LINES } from "./memory.mjs";
import { COC7E } from "./rules/coc7e.mjs";

// The profile supplies each game's vocabulary and dice commands. `improv` follows the public world's tone;
// `casual` lets a co-player text another character on their phone (casual.mjs).
export function coplayerSystem(language, { improv = false, casual = false, pbta = null, profile = COC7E, daily = false, unattended = false } = {}) {
  const { gm, pc } = profile.vocab;
  return `You play one ${pc} in ${pbta ? "a Powered by the Apocalypse game" : profile.coplayerGame(improv)} on an online table, alongside human players. The ${gm} runs the world. You are a fellow player, not the ${gm} and not the protagonist.

How to play:
- Stay in character, true to your persona and role card. Know only what your character saw or heard in the chat log below.
- Keep your most recent choice of destination and companion until you change it. If the table corrects a placement, discard actions that depended on the wrong placement. A proposed activity is pending until it actually happens.
- You know your companions' basic details and backgrounds, what anyone would notice about the people you have met (gender, age, what is most striking about them) and the relationships you know of: let them shape how you treat each other in character, but do not recite them.
- Keep to the story's date (TODAY IN THE STORY): weekdays, seasons, how long ago things happened. When time has passed, you lived through it too. Everyday life (school, work, seasons, festivals) goes on around you: let it fill your days and your talk.
- Companions may have lived through scenes you were not part of. When one tells you about something, it happened where and when they were, not here and now; you know only what they tell you.
${unattended ? '- This unattended exchange follows your own ordinary interests and relationships. Talk to another present co-player or NPC, or enjoy a quiet activity. An absent human character is not the default audience. Do not turn every line into a question, repeat their name, or add an agreement to every remark; passing and a natural ending are welcome. Short lines (1-3 sentences).' : '- Be a good tablemate: support the human players, follow up on their ideas, do not take over the scene or solve the mystery alone. Short lines (1-3 sentences).'}
- Never narrate outcomes, the world or other characters' actions; that is the ${gm}'s job.
- ${pbta ? "Describe your own action in text. Trigger an available move only when its trigger fits. For a roll action supply the .move ID and the fictional declaration in text. Wait for the actual result. Answer choices only for yourself." : `If the ${gm} asked you to roll, or an uncertain action needs a check, reply with a roll using ${profile.dice.coplayerHelp} (the platform rolls it against your sheet).`}
- Pass when you have nothing useful to add, or when the last lines were addressed to someone else.
- Write all text in ${language}.${casual ? `
- This is a casual game: everyone has a phone, even if the setting has none. Now and then, when it fits, you may text someone you know instead of speaking in the scene (a plan, a joke, something you noticed): a player character, a companion, or someone you have met. Never flood anyone.` : ""}

Reply with only one JSON object: {"action": "speak", "kind": "ic" | "ooc", "text": "..."${daily ? ', "needs_reply_from": []' : ''}} or {"action": "roll", "command": "${pbta ? ".move <move-id>" : profile.dice.coplayerShape}", "text": "<optional short line>"}${casual ? ` or {"action": "text", "to": "<someone you know>", "text": "<the text message>"}` : ""} or {"action": "pass"}${daily ? '\nneeds_reply_from is normally empty. List a character\'s full name only when this line actually asks that person a direct question or makes a request needing an answer now. A mention, greeting, anecdote, shared observation or polite agreement needs no reply. Do not manufacture a question to solicit a passive character.' : ''}`;
}

// Who the co-player is: the stable head of every prompt it gets.
export function coplayerSelf({ coplayer, card, world = "", stable = false, profile = COC7E, attrs = {} }) {
  return [
    `YOU ARE: ${coplayer.name}`,
    `PERSONA: ${coplayer.persona || "(none)"}`,
    `SPEAKING STYLE: ${coplayer.speakingStyle || "(natural)"}`,
    `YOUR ROLE CARD:\n${cardSummary(card, { stable, profile, attrs })}`,
    world ? `THE WORLD (the setting everyone at the table shares; your persona and background are your own story in it):\n${world}` : "",
  ].filter(Boolean).join("\n");
}

export function validateCoplayer(x, { casual = false, pbta = null, roll = COC7E.roll, daily = false } = {}) {
  if (!x || typeof x !== "object") throw new Error("expected an object");
  if (x.action === "pass") return { action: "pass" };
  if (x.action === "text" && casual) {
    const text = String(x.text ?? "").trim();
    return text && x.to ? { action: "text", to: String(x.to), text } : { action: "pass" };
  }
  if (x.action === "speak") {
    const text = String(x.text ?? "").trim();
    if (!text) return { action: "pass" };
    const needsReplyFrom = daily && Array.isArray(x.needs_reply_from) ? [...new Set(x.needs_reply_from.filter(n => typeof n === 'string').map(n => n.trim()).filter(Boolean))].slice(0, 5) : [];
    return { action: "speak", kind: x.kind === "ooc" ? "ooc" : "ic", text, ...(needsReplyFrom.length ? { needsReplyFrom } : {}) };
  }
  if (x.action === "roll") {
    const command = String(x.command ?? "").trim();
    if (pbta ? (!/^\.move [a-z][a-z0-9_-]*(?: [+-]?\d{1,2})?$/.test(command) || !String(x.text ?? "").trim() || !pbta.moves.some(m=>m.id===command.split(" ")[1])) : !roll.test(command)) throw new Error(`unsupported roll command "${command}"`);
    return { action: "roll", command, text: String(x.text ?? "").trim() };
  }
  throw new Error(`unknown action "${x.action}"`);
}

function cardState(card, profile = COC7E, attrs = {}) {
  if (!card) return "(not available)";
  if (card.pbta) return JSON.stringify(card.pbta);
  if (profile.id === "dnd2024") return profile.cardState(card, attrs);
  const d = card.derived ?? {};
  return `HP ${d.hp ?? "?"}/${d.hp_max ?? "?"}, SAN ${d.san ?? "?"}, MP ${d.mp ?? "?"}, MOV ${d.mov ?? "?"}, damage bonus ${d.db ?? "0"}\ncarrying: ${(card.items ?? []).map((i) => i.name).join(", ")}`;
}

function cardSummary(card, { stable = false, profile = COC7E, attrs = {} } = {}) {
  if (!card) return "(not available)";
  if (card.pbta) return JSON.stringify({ basic:card.basic, background:card.background, sheet:card.pbta });
  if (profile.id === "dnd2024") return profile.cardSummary(card, attrs, { stable });
  const ch = Object.entries(card.characteristics ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  const sk = Object.entries(card.skills ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${v}`).join(", ");
  const b = card.basic ?? {};
  return [
    `occupation: ${b.occupation ?? ""}, age ${b.age ?? ""}, ${b.sex ?? ""}, from ${b.birthplace ?? ""}, lives in ${b.residence ?? ""}`,
    `characteristics: ${ch}`,
    ...(!stable ? [cardState(card)] : []),
    `skills: ${sk}`,
    `background: ${Object.entries(card.background ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ")}`,
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
export async function coplayerTurn(llm, { language, coplayer, card, companions = [], withYou = null, log, memories = [], recalled = "", spotlight, timeline = null, side = false, spark = false, whistle = false, gentle = false, attentionNote = "", daily = false, dailyNote = "", world = "", improv = false, casual = false, phone = "", impulse = "", today = "", routine = "", timePassed = "", corrections = "", met = "", bonds = "", pbta = null, profile = COC7E, attrs = {} }) {
  const here = withYou ? companions.filter((c) => withYou.includes(c.id)) : companions;
  const away = withYou ? companions.filter((c) => !withYou.includes(c.id)) : [];
  const newest = log[log.length - 1];
  const frozen = log.slice(0, Math.floor(log.length / CHUNK_LINES) * CHUNK_LINES);
  const recent = log.slice(frozen.length);
  const self = coplayerSelf({ coplayer, card, world, stable: true, profile, attrs });
  const gm = profile.vocab.gm, PCS = profile.vocab.pcs.toUpperCase();
  const line = (m) => renderLine(m, { gm });
  const past = [
    memories.length ? `WHAT YOU REMEMBER (your own memories of earlier play, oldest first):\n${memories.join("\n\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const now = [
    spark ? "SPARK: Nobody has spoken for a while. Start a small daily-life topic fitting this hour, place and routine. Never advance a plot, reveal a secret, start danger, change relationships or move anyone. Speak one short line only; no roll or text." : whistle ? "WHISTLE: Reply once to this small daily-life topic, or pass. No plot development, secrets, danger, relationship changes, movement, rolls or texts." : "",
    dailyNote,
    attentionNote,
    gentle ? 'UNATTENDED PERSONAL SCENE: choose only ordinary daily-life activities for yourself. You may explicitly leave for your own routine or accept an immediate invitation. No player-dependent plot, secrets, danger, relationship escalation, rolls or phone texts. Do not move, summon or demand a response from passive humans. Speak briefly or pass.' : '',
    `YOUR CURRENT CONDITION AND INVENTORY:\n${cardState(card, profile, attrs)}`,
    recalled,
    phone ? `YOUR PHONE (recent text messages, oldest first):\n${phone}` : "",
    ...(pbta ? ["Your available moves and playbook: " + JSON.stringify(pbta)] : [
      today ? `TODAY IN THE STORY: ${today}` : "",
      routine ? `${routine} (common knowledge: everyone in the story knows it)` : "",
      timePassed,
    ]),
    timeline ? `YOUR TIMELINE: ${timeline.name}${timeline.narrativeTime ? `; time: ${timeline.narrativeTime}` : ""}${timeline.location ? `; place: ${timeline.location}` : ""}` : "",
    side ? "No human player is with you here: you and your companions drive this thread yourselves. Choose, investigate, talk to the people you meet; still never narrate outcomes." : "",
    `THE OTHER ${PCS} (what you know about your companions)${withYou ? " — WITH YOU HERE" : ""}:\n${here.map(c => pbta ? c.name : renderProfile(c, "", profile)).join("\n") || "(none)"}`,
    away.length ? `ELSEWHERE (not in this scene; talk to them only when you meet again):\n${away.map(c => pbta ? c.name : renderProfile(c, "", profile)).join("\n")}` : "",
    ...(!pbta ? [met, bonds, corrections, spark || whistle || gentle ? '' : impulse] : []),
    "",
    `CHAT LOG YOUR CHARACTER WITNESSED${frozen.length ? ", latest part" : ""} (newest last):\n${recent.map(line).join("\n") || (frozen.length ? "(see above)" : "(nothing yet)")}`,
    newest ? `NEWEST LINE: ${line(newest)}` : "",
    spotlight && !spark ? `The ${gm} turned to you: it is a good moment to act.` : "",
    "Your move?",
  ].filter(Boolean).join("\n");
  const user = [{ text: `${self}\n\n`, cache: true }, ...(past ? [{ text: `${past}\n\n`, cache: true }] : []), ...historyParts(frozen, line, "CHAT LOG YOUR CHARACTER WITNESSED, earlier part (oldest first):", CHUNK_LINES), { text: now }];
  return completeJson(llm, { system: coplayerSystem(language, { improv, casual, pbta, profile, daily, unattended: spark || whistle || gentle }), user, purpose: "coplayer_turn" }, (x) => validateCoplayer(x, { casual, pbta, roll: profile.roll, daily }));
}
