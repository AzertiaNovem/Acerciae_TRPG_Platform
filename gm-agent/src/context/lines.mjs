// How a chat line reads in a prompt: "#seq Speaker (tags): text", one line per message.
import { pictureText } from "../pictureLines.mjs";

// `gm` is the GM's title in this rule system (rules/*.mjs): the label this client gives the GM account's lines.
export function speakerOf(m, gm = "GM") {
  if (m.character_name) return m.character_name;
  if (m.author_role === "gm") return gm;
  return m.author_name || "someone";
}

// `markVisibility` shows GM-only lines and whispers as such (the GM's view); `timeline` names the timeline the line
// comes from (the GM sees it; see timelines.mjs).
// An interactive message (kind hypertext, docs/HYPERTEXT.md) reads as its plain-text fallback (`content`), never its
// card (`m.hypertext`: buttons, state, a script); a line one produced is marked so, with the reader who acted when that
// is someone else than its author (a card's reply, posted as the card's sender).
export function renderLine(m, { markVisibility = false, timeline = "", gm = "GM" } = {}) {
  // A picture (uploaded or drawn) reaches the model as words only: its caption, and that there is a picture at all.
  const text = m.media_asset_id ? pictureText(m) : m.kind === "roll" && m.dice?.text ? `${m.content} → ${m.dice.text}` : m.content;
  const who = m.kind === "narration" ? `${m.character_name ? m.character_name : gm} (narration)` : speakerOf(m, gm);
  let tag = m.kind === "ooc" ? " (out of character)" : m.kind === "hypertext" ? " (interactive message)" : "";
  if (m.via_hypertext_id) tag += " (via interactive message)";
  if (m.via_hypertext_id && m.via_user_id && m.via_user_id !== m.author_id) tag += ` (answering ${m.via_user_name || "a player"})`;
  let vis = "";
  if (markVisibility && m.visibility === "gm_only") vis = ` [${gm} only]`;
  if (markVisibility && m.visibility === "whisper") vis = ` [whisper to ${(m.whisper_to_names ?? m.whisper_to ?? []).join(", ")}]`;
  const tl = timeline ? ` [timeline: ${timeline}]` : "";
  return `#${m.seq} ${who}${tag}${vis}${tl}: ${String(text).replace(/\s+/g, " ").trim()}`;
}
