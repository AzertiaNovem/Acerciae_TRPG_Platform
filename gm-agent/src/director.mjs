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
import { NPC_CONTINUITY_RULES } from "./context/npcContinuity.mjs";
import { completeJson } from "./llm/index.mjs";
import { validateWhereabouts } from "./whereabouts.mjs";

const BASE_ACTIONS = ["time_skip", "narrate", "npc", "new_npc", "whisper", "request_roll", "note", "timeline", "advance_scenario", "enter_scenario", "world_change", "date", "bond"];
const LEGACY_ACTIONS = ["split", "rejoin"];
const NO_TEXT_NEEDED = new Set(["time_skip", "request_roll", "split", "rejoin", "timeline", "advance_scenario", "enter_scenario", "date", "bond"]);

const WORLD_RULE = `- The world lives on: "The world now" is the platform's record of what is true about people, places and groups at present. Keep to it. When the world changes where play does not show it (off-screen, between visits, while the investigators are elsewhere), or something is now true that the chat never stated, record it with world_change: secret true when the investigators do not know it yet. What happens in the chat is recorded for you.`;
const TIME_RULE = (planner) => `- Time: the story has a date (see Calendar). Keep to it: weekdays, seasons, how long ago things happened. Everyday life follows its routine ("Everyday life now"): weave it into scenes, and let quiet days fill with it. When time passes in the fiction (a night's sleep, a journey, days of research), move it on with date (advance_days and the time of day, or the new date). ${planner ? "The story planner chooses the first date; until it has, keep the day vague." : "Set the date once when none is set."} It never runs backwards. A scenario change that jumps in time carries advance_days too. Let the calendar move slowly: play a day out rather than skip ahead, and keep to the Pace line of the Calendar section: while it says the date may not move on yet, move only the time of day, and never skip more days at once than it allows.`;
const PEOPLE_RULE = `- People: the Cast gives each character's gender, age and what is most striking about them (extremely good-looking, slow-witted, very large build…), and Relationships says who lives with, loves, is related to or is at odds with whom. Play them that way: a striking face turns heads, a slow wit misses things, people who live together know each other's habits. When play establishes a relationship or ends one, record it with bond (secret when the investigators do not know it). Never decide a player character's feelings: record a bond with one only when its player or its profile says so.`;
const AWAY_RULE = `- Players come and go: a player character marked "player away" keeps its place in the scene but stays passive. Never act, speak or decide for it, never make the scene wait on it, and do not have harm befall it while its player is away; it catches up when its player returns.`;
const COC_DICE = `- Call for dice when the outcome is uncertain and matters: use request_roll with a Sealdice command the platform rolls (".ra Spot Hidden", ".ra hard Library Use", ".sc 1/1d6" for sanity). Do not invent results; read results already posted in the chat.`;
const COMMON_RULES = `- Every player, co-players included, needs an immediate response to each choice and line: acknowledge what they did, give its consequence, and propel the story (new information, a complication, a decision point). Never leave a move hanging or stall with vague atmosphere; then hand the scene back with an open situation.
- For any jump over play (including a same-day cut), establish the new time BEFORE narrating the next scene. Use date, a timed scenario change or time_skip. The table posts a public handoff using this window's chat. Distinguish completed actions, by actor and time, from plans still outstanding. A planner's suggested montage does not mean anyone ate, traveled, or made a decision. Do not replay established events. If completion is unclear, leave it open or ask.
- Never write words, thoughts or decisions for player characters or co-players.
- Use the platform's notes (Keeper board, reminders, script knowledge, documents, highlights) to stay on the module's track, pace clues and pay off foreshadowing, but reveal secrets only through play.
- Whisper private information to one character; use a note (Keeper-only line) for your own bookkeeping.`;

const WHEREABOUTS_RULES = `- Whereabouts: investigators may be in different places, each place played as its own thread (see Whereabouts and Timelines). The table splits and reunites them for you; you only report facts in "whereabouts". When someone in this scene ends up somewhere out of reach of the others, where they can explore on their own, list them with thread "new", the place, own_scene true and the span ("short" when they are briefly apart, as in two rooms of one house; "long" when they are far apart, as in two cities), and an opening line for that place. When someone reaches the place of another thread, list them with that thread's handle. Leave out anyone who stays. A quick errand you can narrate in one line is not a split. Keep a shared journey together: a lobby, staircase or corridor on the way to the same destination is not a separate playable scene. Report the shared destination rather than splitting companions at intermediate waypoints; split only when they actually pursue separate scenes. When people arrive separately at the same room at compatible story times, they are now together: use the existing thread, even if they did not explicitly announce a reunion. A window title is not reliable evidence that someone is still there; use the latest established play. A shared building alone does not put people in different rooms together. A player character goes somewhere only because their own player said so: never move one yourself. Read each person's latest explicit destination or companion, including earlier commitments still in force. Resolve who ‘you’ refers to; another person's plans cannot move them. Include companions who already said they would go with a departing player. Narrate the departure here, but not the other place's scene: the table opens it in its own window.
- A line tagged with another timeline is a story about that thread, not something happening in this scene.`;

const LEGACY_TIMELINE_RULES = `- Timelines: investigators may be on different threads (see Timelines). A line tagged with another timeline is a story about that thread, not something happening in this scene. Split co-players off with split when the fiction sends them elsewhere (never split player characters into new windows), bring them back with rejoin when their thread is done, and keep each timeline's time, place and notes current with timeline.`;

const SCENARIO_RULES = `- Scenarios are the story's stages, for the whole campaign. Open the next one with advance_scenario (or enter a prepared one with enter_scenario) when the story as a whole moves on: a jump in time, the party reaching a new location for good, a stage of the module completed, or the platform's "New scenario?" reminder when you agree with it. Decide this only in the primary story scene (which may be a restricted fork). Main Chat becomes a public lobby after the party splits; never narrate a private scene there. A short split blocks it (bring the party together first); a long split carries on into the new scenario. A split or a reunion is not by itself a scenario change. Changing too often is worse than too late.`;

const IMPROV_RULES = `- Improvisation: there is no module. The story grows from the World setting, your Hidden truths, the investigators' own personalities and backgrounds, and the players' choices. Build mysteries, places and people that fit the world, and tie threads to the investigators' backgrounds. Stay consistent with the World setting and every Hidden truth. When you decide something true behind the scenes (who did it, what someone wants, what is really in the cellar), record it at once with truth, so later turns keep to it. Reveal hidden truths only through play: clues, NPCs, consequences, rolls.`;

const PLANNER_RULE = `- Story plan: your private plan from the story planner, a slower reader of the whole campaign (see Story plan). Steer toward the current beat's exit and weave the listed threads in; deviate when the players surprise you, and tell the planner what changed with planner_note. When it says the current event has run its course, close it and open the next beat instead of stretching it. Never state the plan or its twists outright.`;
const CASUAL_RULES = `- Casual mode: light, everyday and slice-of-life play is welcome alongside the story. Every player character has a phone (a private window "Phone: <name>"); texting is part of this game even when the setting has no phones, so treat it as natural. Real NPCs may text a player character or a co-player with text (from: the NPC, to: the character, delay_minutes: when it arrives): use it for hooks, invitations, news and consequences, not to flood anyone. Lines in a phone are text messages, not things said in the scene; the Phone log window holds the texts between co-players and NPCs, for you alone.`;

// Improvised campaigns are Basic Roleplaying (BRP) games on the Call of Cthulhu 7th edition presets: rules, skills and
// dice are CoC's, the genre and tone are the world's. A module-led campaign is Call of Cthulhu as such.
const framing = (improv) => (improv
  ? "the Keeper (Game Master) of a Basic Roleplaying (BRP) campaign that uses the Call of Cthulhu 7th edition presets (characteristics, skills, dice, sanity); its genre and tone follow the campaign's world setting, not necessarily horror,"
  : "the Keeper (Game Master) of a Call of Cthulhu 7th edition campaign");

// `calendar`: the story keeps a date (casual games); a solemn game has none, and no date action.
const PBTA_PLAY = `- Start with the fiction. Only an explicit action that satisfies an available move triggers it. If ambiguous, ask. To act on a declaration in this window use move with its precise source_id and character_id. Use the server for both rolled and diceless moves. For an NPC whose own declared action triggers a player move, include move_id and optionally modifier on its npc or new_npc action. NPCs otherwise need no playbook. Stop after requesting a move and read the posted result before narrating. Use its frozen outcome, even if the current pack differs. A low roll is not a generic failure.
- If the outcome gives the player a choice, use ask, quote the options and wait for their actual reply; do not choose for them. Narrate only the MC's own decisions. Use mark for mandatory effects or after the player chooses. Copy expected from initial_card (absent means 0 or false), and give the absolute resulting value. Include the reply's answer_id for a choice. Do not repeat paid costs. No dice commands inside free speech. Never take a new action on behalf of a silent human.
`;
export function directorSystem(language, { auto = true, improv = false, casual = false, planner = false, calendar = false, pbta = false } = {}) {
  return `You are ${pbta ? "the MC of a Powered by the Apocalypse campaign" : framing(improv)} on an online table. Human players play their investigators; some investigators are AI co-players that act on their own turn after you. You voice the world and every real NPC.

How to keep the table:
${COMMON_RULES}
${pbta ? PBTA_PLAY : COC_DICE}
${AWAY_RULE}
${NPC_CONTINUITY_RULES}
- Use npc for an existing named NPC; only new_npc creates a character. Check the cast before choosing new_npc.
${WORLD_RULE}
${calendar ? `${TIME_RULE(planner)}
` : ""}${PEOPLE_RULE}
${auto ? WHEREABOUTS_RULES : LEGACY_TIMELINE_RULES}
${SCENARIO_RULES}${improv ? `\n${IMPROV_RULES}` : ""}${casual ? `\n${CASUAL_RULES}` : ""}${planner ? `\n${PLANNER_RULE}` : ""}
- Keep each line short enough for chat (1-5 sentences). One to three actions per turn is typical. Return no actions if nothing needs the Keeper now (for example players talking among themselves out of character).
- Write all text in ${language}.

Reply with only one JSON object:
{"actions": [
  {"type": "narrate", "text": "..."},
  {"type": "npc", "name": "<a real NPC from the cast>", "text": "<what they say or do>"},
  {"type": "new_npc", "name": "<new NPC name>", "brief": "<who they are, for their role card>", "text": "<their first line>"},
  {"type": "whisper", "to": "<character name>", "text": "..."},
${pbta ? `  {"type":"move","source_id":"<declaration>","character_id":"<actor>","move_id":"<move>","modifier":0},
  {"type":"ask","roll_id":"<roll>","character_id":"<actor>","text":"<player options>"},
  {"type":"mark","roll_id":"<roll>","character_id":"<actor>","section":"resources | conditions","field":"<id>","expected":0,"value":1,"basis":"automatic | choice","answer_id":"<reply if choice>"},` : `  {"type": "request_roll", "who": "<character name>", "command": ".ra <skill>", "text": "<why, in one short line>"},`}
  {"type": "note", "text": "<Keeper-only note>"},
  {"type": "world_change", "text": "<what is now true in the world, e.g. 'The Harbour Guild has closed the docks at night.'>", "secret": true | false},
${calendar ? `  {"type": "date", "advance_days": 1, "time": "<time of day, e.g. early morning>", "date": "<optional: the new date, YYYY-MM-DD>", "reason": "<what passed>"},
` : ""}  {"type": "bond", "a": "<character>", "b": "<character>", "kind": "lives with | married | lovers | friends | family | colleagues | rivals | ...", "note": "<which way, since when>", "secret": false, "end": false},
${improv ? `  {"type": "truth", "text": "<a hidden fact you just decided, for your own memory>"},
` : ""}${casual ? `  {"type": "text", "from": "<a real NPC>", "to": "<a player character or a co-player>", "text": "<the text message>", "delay_minutes": <0 = now; or when it arrives>},
` : ""}${planner ? `  {"type": "planner_note", "text": "<for the story planner: what the players did that changed the plan, or what you need>", "beat_done": true | false},
` : ""}${auto ? "" : `  {"type": "split", "name": "<thread name>", "coplayers": ["<co-player names>"], "location": "...", "narrative_time": "...", "opening": "<first narration of the thread>"},
  {"type": "rejoin", "timeline": "<thread name>", "into": "<window name, optional>", "text": "<optional narration where they return>"},
`}  {"type": "timeline", "timeline": "<handle or thread name>", "narrative_time": "...", "location": "...", "notes": "<your private notes>", "span": "short" | "long"},
  {"type": "time_skip", "time": "<new public story time in this scene, for a jump without another time-changing action>"},
  {"type": "advance_scenario", "title": "...", "location": "...", "narrative_time": "...", ${calendar ? `"advance_days": 0, ` : ""}"reason": "<why now>"},
  {"type": "enter_scenario", "scenario": "<title of a prepared scenario>", "reason": "<why now>"}
 ],
 "coplayers_may_act": true | false,
 "spotlight": ["<co-player names invited to act first>"]${auto ? `,
 "whereabouts": [{"who": ["<investigator names>"], "thread": "<handle like T0>" | "new", "place": "...", "own_scene": true, "span": "short" | "long", "time": "...", "opening": "<first narration there>"}]` : ""}}`;
}

export function validateDirector(x, { auto = true, improv = false, casual = false, planner = false, calendar = false, pbta = false } = {}) {
  if (!x || typeof x !== "object" || !Array.isArray(x.actions)) throw new Error("actions must be an array");
  const allowed = [...(pbta ? ["move","ask","mark"] : []), ...BASE_ACTIONS.filter(t => (calendar || t !== "date") && (!pbta || t !== "request_roll")), ...(auto ? [] : LEGACY_ACTIONS), ...(improv ? ["truth"] : []), ...(casual ? ["text"] : []), ...(planner ? ["planner_note"] : [])];
  const actions = x.actions
    .filter((a) => a && allowed.includes(a.type))
    .map((a) => ({ ...a, text: String(a.text ?? "").trim() }))
    .filter((a) => a.text || (pbta && ["move","mark"].includes(a.type)) || NO_TEXT_NEEDED.has(a.type));
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
  arrival: ({ arrival }) => (arrival?.newcomer ? `MODE: arrival — a new player just joined the table with ${list(arrival.names)}. Bring ${arrival.names?.length > 1 ? "them" : "this character"} into the story here, naturally: who they are to the others, why they are here now, what they notice; then hand them the scene. Never decide for player characters.` : `MODE: arrival — ${list(arrival?.names)} ${arrival?.reunion ? "just rejoined the others here" : `just arrived at ${arrival?.place || "this place"}`}. Open the scene for them now: where they are, what they notice, an open situation. Do not repeat the departure${arrival?.opening ? ` or this opening, already posted: "${arrival.opening}"` : ""}. Never decide for player characters.`),
  phone: ({ phone }) => `MODE: phone — ${phone?.from ?? "a player character"} texted ${phone?.to ?? "an NPC"} on their phone${phone?.thread ? `. The thread so far (oldest first):\n${phone.thread}\n` : ": "}${JSON.stringify(phone?.text ?? "")}. Answer only as ${phone?.to ?? "the NPC"}, with one text action (from: ${phone?.to ?? "the NPC"}, to: ${phone?.from ?? "the player character"}) and delay_minutes for when they would plausibly answer; or no action if they would leave it unanswered. Nothing else happens in any scene this turn. You may add a note, truth or world_change.`,
  relay: ({ relay }) => `MODE: relay — ${relay?.speaker ?? "a player"} wrote in another window ("${relay?.window ?? "elsewhere"}"), but their character is here, in this scene. Answer them here as if they had written here: ${JSON.stringify(relay?.text ?? "")}.`,
};

// `context` is the Keeper's context as parts (gmContext.mjs) or text; this turn's notes follow it, uncached.
// `whereabouts` is the brief from whereabouts.mjs; `scenario` says whether a scenario change is possible this turn.
// `planner` is {on, moveOn, beat, why, next}: the planner's verdict, a turn note when it says the event is over.
// `between` is what the last final review left for the first turn of a new session: {days, today, offscreen, opening}.
export async function directTurn(llm, { language, context, newest, mode = "human", kickoff = false, whereabouts = "", scenario = "", auto = true, improv = false, casual = false, planner = null, between = null, calendar = false, pbta = null, ...extra }) {
  if (kickoff) mode = "kickoff";
  const note = MODE_NOTES[mode]?.(extra) ?? "";
  const arrivalNote = mode !== "arrival" && extra.arrival ? MODE_NOTES.arrival(extra) : "";   // an arrival folded into another turn
  const back = (extra.returning ?? []).map((r) => `${r.name}'s player is back after ${r.away} away.`).join(" ");
  const returningNote = back ? `RETURNING: ${back} Welcome them back into the story: where their character is now and what has moved on meanwhile, if anything, then hand them the scene.` : "";
  const plannerNote = planner?.moveOn ? `PLANNER: the story planner judges the current event ("${planner.beat}") has run its course${planner.why ? ` (${planner.why})` : ""}. Bring it to a close now or next turn and open the next beat${planner.next ? ` (${planner.next})` : ""}. The scenario pace guard is lifted while this stands.` : "";
  const betweenNote = between ? `BETWEEN SESSIONS: this is the first turn of a new session.${between.today ? ` ${between.days ? `Since the last one, ${between.days} day(s) passed in the story` : "The story resumes where it stopped"} (now: ${between.today}).` : ""}${between.offscreen?.length ? ` Meanwhile, off-screen: ${between.offscreen.map((o) => `${o.text}${o.secret ? " [secret: show only what the investigators would notice]" : ""}`).join("; ")}.` : ""}${between.opening ? ` The story planner suggests opening with: ${between.opening}` : ""} Use the public handoff: previously proposed activities remain plans unless play confirmed them. Open the session from there: where the investigators are, ${between.today ? "what day and time it is, " : ""}what changed that they would notice; then hand them the scene.` : "";
  const turn = [
    "",
    pbta ? "PbtA rules, actionable local lines and recorded rulings: "+JSON.stringify(pbta) : "",
    betweenNote,
    auto ? whereabouts : "",
    scenario,
    note,
    arrivalNote,
    returningNote,
    plannerNote,
    newest ? `NEWEST LINE: ${newest.character_name || newest.author_name || "someone"}: ${newest.content}` : "",
    "Decide the Keeper's actions for this turn.",
  ].filter(Boolean).join("\n");
  const user = [...(Array.isArray(context) ? context : [{ text: String(context ?? "") }]), { text: `\n${turn}` }];
  const on = Boolean(planner?.on);
  return completeJson(llm, { system: directorSystem(language, { auto, improv, casual, planner: on, calendar, pbta: !!pbta }), user, purpose: "director", phase: mode }, (x) => validateDirector(x, { auto, improv, casual, planner: on, calendar, pbta: !!pbta }));
}
