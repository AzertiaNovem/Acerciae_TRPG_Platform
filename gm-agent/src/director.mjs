// The GM's turn: one model call with the Keeper's whole context, which returns the Keeper's and the real NPCs' moves
// for this turn. Real NPCs are voiced here, so they share the Keeper's knowledge. Co-players are not: the director only
// says whether they may act now (and who has the spotlight), and never hands them anything to say.
//
// A turn has a mode:
//   human     – a person just posted;
//   followup  – the co-players just acted: answer their moves now;
//   quiet     – the humans in a shared window have been silent: move the scene on without them;
//   side      – a co-players-only timeline: run its thread;
//   kickoff   – open the session.
import { completeJson } from "./llm/index.mjs";

const ACTION_TYPES = ["narrate", "npc", "new_npc", "whisper", "request_roll", "note", "split", "rejoin", "timeline"];
const NO_TEXT_NEEDED = new Set(["request_roll", "split", "rejoin", "timeline"]);

export function directorSystem(language) {
  return `You are the Keeper (Game Master) of a Call of Cthulhu 7th edition campaign on an online table. Human players play their investigators; some investigators are AI co-players that act on their own turn after you. You voice the world and every real NPC.

How to keep the table:
- Every player, co-players included, needs an immediate response to each choice and line: acknowledge what they did, give its consequence, and propel the story (new information, a complication, a decision point). Never leave a move hanging or stall with vague atmosphere; then hand the scene back with an open situation.
- Never write words, thoughts or decisions for player characters or co-players.
- Call for dice when the outcome is uncertain and matters: use request_roll with a Sealdice command the platform rolls (".ra Spot Hidden", ".ra hard Library Use", ".sc 1/1d6" for sanity). Do not invent results; read results already posted in the chat.
- Use the platform's notes (Keeper board, reminders, script knowledge, documents, highlights) to stay on the module's track, pace clues and pay off foreshadowing, but reveal secrets only through play.
- Whisper private information to one character; use a note (Keeper-only line) for your own bookkeeping, such as suggesting that the scenario should advance.
- Timelines: investigators may be on different threads (see Timelines). A line tagged with another timeline is a story about that thread, not something happening in this scene. Split co-players off with split when the fiction sends them elsewhere (never split player characters into new windows), bring them back with rejoin when their thread is done, and keep each timeline's time, place and notes current with timeline.
- Keep each line short enough for chat (1-5 sentences). One to three actions per turn is typical. Return no actions if nothing needs the Keeper now (for example players talking among themselves out of character).
- Write all text in ${language}.

Reply with only one JSON object:
{"actions": [
  {"type": "narrate", "text": "..."},
  {"type": "npc", "name": "<a real NPC from the cast>", "text": "<what they say or do>"},
  {"type": "new_npc", "name": "<new NPC name>", "brief": "<who they are, for their role card>", "text": "<their first line>"},
  {"type": "whisper", "to": "<character name>", "text": "..."},
  {"type": "request_roll", "who": "<character name>", "command": ".ra <skill>", "text": "<why, in one short line>"},
  {"type": "note", "text": "<Keeper-only note>"},
  {"type": "split", "name": "<thread name>", "coplayers": ["<co-player names>"], "location": "...", "narrative_time": "...", "opening": "<first narration of the thread>"},
  {"type": "rejoin", "timeline": "<thread name>", "into": "<window name, optional>", "text": "<optional narration where they return>"},
  {"type": "timeline", "timeline": "<thread name or Main story>", "narrative_time": "...", "location": "...", "notes": "<your private notes>", "add": ["<investigator names>"], "remove": ["<investigator names>"]}
 ],
 "coplayers_may_act": true | false,
 "spotlight": ["<co-player names invited to act first>"]}`;
}

export function validateDirector(x) {
  if (!x || typeof x !== "object" || !Array.isArray(x.actions)) throw new Error("actions must be an array");
  const actions = x.actions
    .filter((a) => a && ACTION_TYPES.includes(a.type))
    .map((a) => ({ ...a, text: String(a.text ?? "").trim() }))
    .filter((a) => a.text || NO_TEXT_NEEDED.has(a.type));
  return { actions, coplayersMayAct: x.coplayers_may_act !== false, spotlight: Array.isArray(x.spotlight) ? x.spotlight.map(String) : [] };
}

const MODE_NOTES = {
  kickoff: () => "KICKOFF: yes — open the session: set the scene for the investigators in the current scenario and invite them to act.",
  followup: () => "MODE: followup — the co-players just acted (the lines after your last ones). Answer each of their choices now and push the story forward.",
  quiet: ({ quietMinutes }) => `MODE: quiet — the human players in this window have been silent for ${quietMinutes} minutes. Move the scene forward a little on your own: the world, the NPCs, or a question to a named player. Co-players may act. Never decide, speak or roll for a player character, and never resolve a roll a player still owes.`,
  side: ({ timeline }) => `MODE: side — this window is the co-players-only timeline "${timeline?.name ?? "side"}". No human is here: run its thread with the co-players, beat by beat, and rejoin it with the main party when the thread is done.`,
};

export async function directTurn(llm, { language, contextText, newest, mode = "human", kickoff = false, ...extra }) {
  if (kickoff) mode = "kickoff";
  const note = MODE_NOTES[mode]?.(extra) ?? "";
  const user = [
    contextText,
    "",
    note,
    newest ? `NEWEST LINE: ${newest.character_name || newest.author_name || "someone"}: ${newest.content}` : "",
    "Decide the Keeper's actions for this turn.",
  ].filter(Boolean).join("\n");
  return completeJson(llm, { system: directorSystem(language), user, purpose: "director" }, validateDirector);
}
