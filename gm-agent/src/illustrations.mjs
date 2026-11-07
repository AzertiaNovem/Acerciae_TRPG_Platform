// Illustrations: the platform draws a moment of the story with the server's image provider (POST
// /windows/{w}/illustrations) and posts the picture in the window as the requester's out-of-character line ("🖼️ " and
// the description), so it never starts a turn. Uses here (and plotArt.mjs for a player's request):
//   * in play, at the end of every small event (the GM's `event_done`), the table draws that event's most striking
//     moment where it was played; the GM may also illustrate a breathtaking moment in the middle of one
//     (`illustrate`). The table caps both at illustrations.max_per_hour, and the platform at one picture in flight and
//     20 an hour per account;
//   * every time the story enters its next scenario, the table always illustrates the most brilliant, beautiful,
//     artistic moment of the scenario that has just ended, chosen by a model call from what that window's readers
//     saw (no whisper, GM-only note or other window, so the picture reveals nothing they did not witness).
// Every choice is told what was already drawn in the scenario, so no moment is drawn twice.
import { completeJson } from "./llm/index.mjs";

export const MAX_PROMPT = 1500, MAX_CHARACTERS = 4;
export const ORIENTATIONS = ["landscape", "portrait", "square"];

export const ILLUSTRATE_RULE = `- Pictures: the story moves in small events: a conversation that reaches its point, a search that turns something up, a fight or a chase, an arrival somewhere new, a ritual, a farewell. When your actions this turn bring one to its end, add event_done naming it, after the lines that end it and before any scenario change: the table then has the event's most striking moment drawn for the players here. Only at the real end of an event, once for each; never in the middle of one, and never for players chatting out of character. Separately, for a breathtaking moment in the middle of an event (a place revealed, a charged meeting), you may have it drawn at once with illustrate: one frozen moment for a painter, with who is there and what they do, the place, the light, the colours and the mood; no dialogue and no words in the picture, and only what everyone in this window has seen. Name up to four characters in it, so their portraits guide the painter, and choose landscape (places, groups), portrait (one figure) or square. Use illustrate rarely. A picture is posted a little later, as yours, and costs no line.`;
export const ILLUSTRATE_SCHEMA = `  {"type": "event_done", "text": "<the small event your lines just brought to its end, in a few words>"},
  {"type": "illustrate", "text": "<one frozen moment: who does what, where, the light and mood>", "who": ["<up to four character names in it>"], "orientation": "landscape | portrait | square"},`;

const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const names = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => clip(x, 120)).filter(Boolean);

// The GM's illustrate action, or the scenario moment, made safe to send.
export function normalizeIllustration(x) {
  const text = clip(x?.text ?? x?.moment, MAX_PROMPT);
  const orientation = ORIENTATIONS.includes(x?.orientation) ? x.orientation : "landscape";
  return { text, who: [...new Set(names(x?.who))].slice(0, MAX_CHARACTERS), orientation };
}

// What a request's failure means: the platform cannot draw at all here (no provider, no route yet), the account is
// busy with a picture still being drawn, or it is over the hourly cap.
export function illustrationFailure(e) {
  const message = String(e?.message ?? e);
  if (e?.status === 404 || /disabled or not configured|not configured/i.test(message)) return "unavailable";
  if (e?.status === 409 && /still being drawn/i.test(message)) return "busy";
  if (e?.status === 429) return "rate_limited";
  return "error";
}

const SCENARIO_SYSTEM = (language) => `You are the GM's art director for an online tabletop roleplaying campaign. A stage of the story (a scenario) has just ended. From its play, choose the single most brilliant, beautiful and artistic moment: the image the players would hang on a wall. It may be a vista, a gesture, a confrontation or a quiet beat in striking light; prefer what is visually remarkable over what is merely important.

${PAINT(language)}`;

// How to describe the chosen moment, for both the scenario's and a small event's picture.
const PAINT = (language) => `Some moments of this scenario may already have been drawn (listed as ALREADY DRAWN): choose a different one, another beat, place or image, never one of those again.

Describe it for a painter as one frozen moment: who is there and what they are doing, the place, the light, the colours and the mood, in at most 120 words. Use only what happens in the lines you are given (the players saw all of them); invent no event, reveal no secret, and put no dialogue or words in the picture. Name the characters who appear in it, at most four, exactly as they are named in the cast. Choose the frame: landscape for places and groups, portrait for a single figure, square otherwise.

Write the description in ${language}. Reply with only one JSON object:
{"moment": "<the description>", "who": ["<character names>"], "orientation": "landscape" | "portrait" | "square", "why": "<one short line: why this moment>"}`;

const EVENT_SYSTEM = (language) => `You are the GM's art director for an online tabletop roleplaying campaign. A small event of the story has just come to its end (named below). From its play, choose its single most striking, beautiful and artistic moment: the image the players will remember this event by. Prefer what is visually remarkable over what is merely important, and the heart of the event over its last line.

${PAINT(language)}`;

// The pictures already drawn in the scenario, for the art director to avoid.
const drawnBlock = (drawn) => (drawn?.length ? `ALREADY DRAWN IN THIS SCENARIO (choose a different moment):\n${drawn.map((d) => `- ${clip(d, 300)}`).join("\n")}` : "");
const moment = (x) => {
  const n = normalizeIllustration(x);
  if (!n.text) throw new Error("moment is required");
  return { ...n, why: clip(x.why, 300) };
};

// The lines a scenario's illustration may draw on, oldest first, as compact text within `budget` characters: every
// line is kept when they fit, otherwise each is shortened, then the oldest go.
export function scenarioLines(lines, nameOf, budget = 40000) {
  const rows = lines.map((m) => ({ who: m.character_id ? nameOf(m.character_id) : m.author_role === "gm" ? "GM" : (m.author_name || "a player"), text: String(m.dice?.text ?? m.content ?? "").replace(/\s+/g, " ").trim() })).filter((r) => r.text);
  let width = 600;
  const render = () => rows.map((r) => `${r.who}: ${r.text.slice(0, width)}`);
  let out = render();
  while (out.join("\n").length > budget && width > 160) { width = Math.floor(width * 0.7); out = render(); }
  while (out.join("\n").length > budget && out.length > 1) out.shift();
  return out.join("\n");
}

// The moment to draw for the scenario that just ended: {text, who, orientation, why}. `drawn`: the descriptions of the
// pictures already drawn in it.
export async function pickScenarioMoment(llm, { language, title, place, time, era, cast, lines, drawn = [] }) {
  const user = [
    `SCENARIO: ${title || "(untitled)"}${place ? ` — ${place}` : ""}${time ? `, ${time}` : ""}`,
    era ? `ERA: ${era}` : "",
    `CAST: ${cast.join(", ") || "(none named)"}`,
    drawnBlock(drawn),
    `PLAY (oldest first):\n${lines}`,
  ].filter(Boolean).join("\n\n");
  return completeJson(llm, { system: SCENARIO_SYSTEM(language), user, purpose: "scenario_illustration" }, moment);
}

// The moment to draw for a small event that just ended (the GM's event_done): {text, who, orientation, why}.
export async function pickEventMoment(llm, { language, event, scenario = "", place, time, era, cast, lines, drawn = [] }) {
  const user = [
    `THE EVENT THAT JUST ENDED: ${event || "(unnamed)"}`,
    scenario ? `SCENARIO: ${scenario}` : "",
    place || time ? `WHERE AND WHEN: ${[place, time].filter(Boolean).join(", ")}` : "",
    era ? `ERA: ${era}` : "",
    `CAST: ${cast.join(", ") || "(none named)"}`,
    drawnBlock(drawn),
    `PLAY (oldest first):\n${lines}`,
  ].filter(Boolean).join("\n\n");
  return completeJson(llm, { system: EVENT_SYSTEM(language), user, purpose: "event_illustration" }, moment);
}
