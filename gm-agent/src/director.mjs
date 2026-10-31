// The GM's turn: one model call with the Keeper's whole context, which returns the Keeper's and the real NPCs' moves
// for this turn. Real NPCs are voiced here, so they share the Keeper's knowledge. Co-players are not: the director only
// says whether they may act now (and who has the spotlight), and never hands them anything to say.
//
// A turn has a mode:
//   human     – a person just posted;
//   followup  – the co-players just acted: answer their moves now;
//   quiet     – the humans in a shared window have been silent: move the scene on without them;
//   side      – a co-players-only timeline: run its thread;
//   arrival   – investigators just arrived somewhere (a new scene, or back with the others): open the scene for them;
//   relay     – a player wrote in another window while their character is here: answer them here;
//   kickoff   – open the session.
//
// With TIMELINE_AUTO (the default) the director reports where investigators are (`whereabouts`, see whereabouts.mjs)
// and the table splits and reunites them; without it the older split/rejoin actions are used.
import { completeJson } from "./llm/index.mjs";
import { validateWhereabouts } from "./whereabouts.mjs";

const BASE_ACTIONS = ["narrate", "npc", "new_npc", "whisper", "request_roll", "note", "timeline", "advance_scenario", "enter_scenario"];
const LEGACY_ACTIONS = ["split", "rejoin"];
const NO_TEXT_NEEDED = new Set(["request_roll", "split", "rejoin", "timeline", "advance_scenario", "enter_scenario"]);

const COMMON_RULES = `- Every player, co-players included, needs an immediate response to each choice and line: acknowledge what they did, give its consequence, and propel the story (new information, a complication, a decision point). Never leave a move hanging or stall with vague atmosphere; then hand the scene back with an open situation.
- Never write words, thoughts or decisions for player characters or co-players.
- Call for dice when the outcome is uncertain and matters: use request_roll with a Sealdice command the platform rolls (".ra Spot Hidden", ".ra hard Library Use", ".sc 1/1d6" for sanity). Do not invent results; read results already posted in the chat.
- Use the platform's notes (Keeper board, reminders, script knowledge, documents, highlights) to stay on the module's track, pace clues and pay off foreshadowing, but reveal secrets only through play.
- Whisper private information to one character; use a note (Keeper-only line) for your own bookkeeping.`;

const WHEREABOUTS_RULES = `- Whereabouts: investigators may be in different places, each place played as its own thread (see Whereabouts and Timelines). The table splits and reunites them for you; you only report facts in "whereabouts". When someone in this scene ends up somewhere out of reach of the others, where they can explore on their own, list them with thread "new", the place, own_scene true and the span ("short" when they are briefly apart, as in two rooms of one house; "long" when they are far apart, as in two cities), and an opening line for that place. When someone reaches the place of another thread, list them with that thread's handle. Leave out anyone who stays. A quick errand you can narrate in one line is not a split. A player character goes somewhere only because their own player said so: never move one yourself. Co-players go where their own lines take them. Narrate the departure here, but not the other place's scene: the table opens it in its own window.
- A line tagged with another timeline is a story about that thread, not something happening in this scene.`;

const LEGACY_TIMELINE_RULES = `- Timelines: investigators may be on different threads (see Timelines). A line tagged with another timeline is a story about that thread, not something happening in this scene. Split co-players off with split when the fiction sends them elsewhere (never split player characters into new windows), bring them back with rejoin when their thread is done, and keep each timeline's time, place and notes current with timeline.`;

const SCENARIO_RULES = `- Scenarios are the story's stages, for the whole campaign. Open the next one with advance_scenario (or enter a prepared one with enter_scenario) when the story as a whole moves on: a jump in time, the party reaching a new location for good, a stage of the module completed, or the platform's "New scenario?" reminder when you agree with it. Decide this only in the Main Chat. A short split blocks it (bring the party together first); a long split carries on into the new scenario. A split or a reunion is not by itself a scenario change. Changing too often is worse than too late.`;

export function directorSystem(language, { auto = true } = {}) {
  return `You are the Keeper (Game Master) of a Call of Cthulhu 7th edition campaign on an online table. Human players play their investigators; some investigators are AI co-players that act on their own turn after you. You voice the world and every real NPC.

How to keep the table:
${COMMON_RULES}
${auto ? WHEREABOUTS_RULES : LEGACY_TIMELINE_RULES}
${SCENARIO_RULES}
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
${auto ? "" : `  {"type": "split", "name": "<thread name>", "coplayers": ["<co-player names>"], "location": "...", "narrative_time": "...", "opening": "<first narration of the thread>"},
  {"type": "rejoin", "timeline": "<thread name>", "into": "<window name, optional>", "text": "<optional narration where they return>"},
`}  {"type": "timeline", "timeline": "<handle or thread name>", "narrative_time": "...", "location": "...", "notes": "<your private notes>", "span": "short" | "long"},
  {"type": "advance_scenario", "title": "...", "location": "...", "narrative_time": "...", "reason": "<why now>"},
  {"type": "enter_scenario", "scenario": "<title of a prepared scenario>", "reason": "<why now>"}
 ],
 "coplayers_may_act": true | false,
 "spotlight": ["<co-player names invited to act first>"]${auto ? `,
 "whereabouts": [{"who": ["<investigator names>"], "thread": "<handle like T0>" | "new", "place": "...", "own_scene": true, "span": "short" | "long", "time": "...", "opening": "<first narration there>"}]` : ""}}`;
}

export function validateDirector(x, { auto = true } = {}) {
  if (!x || typeof x !== "object" || !Array.isArray(x.actions)) throw new Error("actions must be an array");
  const allowed = auto ? BASE_ACTIONS : [...BASE_ACTIONS, ...LEGACY_ACTIONS];
  const actions = x.actions
    .filter((a) => a && allowed.includes(a.type))
    .map((a) => ({ ...a, text: String(a.text ?? "").trim() }))
    .filter((a) => a.text || NO_TEXT_NEEDED.has(a.type));
  return {
    actions,
    coplayersMayAct: x.coplayers_may_act !== false,
    spotlight: Array.isArray(x.spotlight) ? x.spotlight.map(String) : [],
    whereabouts: auto ? validateWhereabouts(x.whereabouts) : [],
  };
}

const list = (names) => (names ?? []).join(", ");
const MODE_NOTES = {
  kickoff: () => "KICKOFF: yes — open the session: set the scene for the investigators in the current scenario and invite them to act.",
  followup: () => "MODE: followup — the co-players just acted (the lines after your last ones). Answer each of their choices now and push the story forward.",
  quiet: ({ quietMinutes }) => `MODE: quiet — the human players in this window have been silent for ${quietMinutes} minutes. Move the scene forward a little on your own: the world, the NPCs, or a question to a named player. Co-players may act. Never decide, speak or roll for a player character, and never resolve a roll a player still owes.`,
  side: ({ timeline }) => `MODE: side — this window is the co-players-only timeline "${timeline?.name ?? "side"}". No human is here: run its thread with the co-players, beat by beat. When the co-players head back to the others, report it in whereabouts.`,
  arrival: ({ arrival }) => `MODE: arrival — ${list(arrival?.names)} ${arrival?.reunion ? "just rejoined the others here" : `just arrived at ${arrival?.place || "this place"}`}. Open the scene for them now: where they are, what they notice, an open situation. Do not repeat the departure${arrival?.opening ? ` or this opening, already posted: "${arrival.opening}"` : ""}. Never decide for player characters.`,
  relay: ({ relay }) => `MODE: relay — ${relay?.speaker ?? "a player"} wrote in another window ("${relay?.window ?? "elsewhere"}"), but their character is here, in this scene. Answer them here as if they had written here: ${JSON.stringify(relay?.text ?? "")}.`,
};

// `whereabouts` is the brief from whereabouts.mjs; `scenario` says whether a scenario change is possible this turn.
export async function directTurn(llm, { language, contextText, newest, mode = "human", kickoff = false, whereabouts = "", scenario = "", auto = true, ...extra }) {
  if (kickoff) mode = "kickoff";
  const note = MODE_NOTES[mode]?.(extra) ?? "";
  const arrivalNote = mode !== "arrival" && extra.arrival ? MODE_NOTES.arrival(extra) : "";   // an arrival folded into another turn
  const user = [
    contextText,
    "",
    auto ? whereabouts : "",
    scenario,
    note,
    arrivalNote,
    newest ? `NEWEST LINE: ${newest.character_name || newest.author_name || "someone"}: ${newest.content}` : "",
    "Decide the Keeper's actions for this turn.",
  ].filter(Boolean).join("\n");
  return completeJson(llm, { system: directorSystem(language, { auto }), user, purpose: "director" }, (x) => validateDirector(x, { auto }));
}
