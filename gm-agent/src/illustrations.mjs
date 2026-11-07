// Illustrations: the platform draws a moment of the story with the server's image provider (POST
// /windows/{w}/illustrations) and posts the picture in the window as the requester's out-of-character line ("🖼️ " and
// the description), so it never starts a turn. Two uses here:
//   * in play, the GM may illustrate a truly evocative, beautiful moment (`illustrate`), rarely: the table caps it at
//     illustrations.max_per_hour, and the platform at one picture in flight and 20 an hour per account;
//   * every time the story enters its next scenario, the table always illustrates the most brilliant, beautiful,
//     artistic moment of the scenario that has just ended, chosen by a model call from what that window's readers
//     saw (no whisper, GM-only note or other window, so the picture reveals nothing they did not witness).
import { completeJson } from "./llm/index.mjs";

export const MAX_PROMPT = 1500, MAX_CHARACTERS = 6;
export const ORIENTATIONS = ["landscape", "portrait", "square"];

export const ILLUSTRATE_RULE = `- Illustrations: when a moment is truly evocative and beautiful (a breathtaking place revealed, a charged meeting, a striking image the players will remember), you may have it drawn with illustrate. Describe one frozen moment for a painter: who is there and what they do, the place, the light, the colours and the mood; no dialogue and no words in the picture, and only what everyone in this window has seen. Name up to ${MAX_CHARACTERS} characters in it, so their portraits guide the painter, and choose landscape (places, groups), portrait (one figure) or square. Use it rarely: at most once in a scene, never for routine moments. It is drawn and posted a little later, as your picture, and costs no line.`;
export const ILLUSTRATE_SCHEMA = `  {"type": "illustrate", "text": "<one frozen moment: who does what, where, the light and mood>", "who": ["<up to ${MAX_CHARACTERS} character names in it>"], "orientation": "landscape | portrait | square"},`;

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

Describe it for a painter as one frozen moment: who is there and what they are doing, the place, the light, the colours and the mood, in at most 120 words. Use only what happens in the lines you are given (the players saw all of them); invent no event, reveal no secret, and put no dialogue or words in the picture. Name the characters who appear in it, at most ${MAX_CHARACTERS}, exactly as they are named in the cast. Choose the frame: landscape for places and groups, portrait for a single figure, square otherwise.

Write the description in ${language}. Reply with only one JSON object:
{"moment": "<the description>", "who": ["<character names>"], "orientation": "landscape" | "portrait" | "square", "why": "<one short line: why this moment>"}`;

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

// The moment to draw for the scenario that just ended: {text, who, orientation, why}.
export async function pickScenarioMoment(llm, { language, title, place, time, era, cast, lines }) {
  const user = [
    `SCENARIO: ${title || "(untitled)"}${place ? ` — ${place}` : ""}${time ? `, ${time}` : ""}`,
    era ? `ERA: ${era}` : "",
    `CAST: ${cast.join(", ") || "(none named)"}`,
    `PLAY (oldest first):\n${lines}`,
  ].filter(Boolean).join("\n\n");
  return completeJson(llm, { system: SCENARIO_SYSTEM(language), user, purpose: "scenario_illustration" }, (x) => {
    const n = normalizeIllustration(x);
    if (!n.text) throw new Error("moment is required");
    return { ...n, why: clip(x.why, 300) };
  });
}
