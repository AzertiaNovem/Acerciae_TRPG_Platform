export const LANGUAGES = { en: "English", zh: "Simplified Chinese", "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", ja: "Japanese", ko: "Korean", es: "Spanish", fr: "French", de: "German", ru: "Russian", pt: "Portuguese", it: "Italian" };
export const languageName = (code) => LANGUAGES[code] ?? LANGUAGES[String(code ?? "").split("-")[0]] ?? (code || "English");

export const TRIGGER_KINDS = new Set(["ic", "ooc", "roll", "narration"]);
export const SPEAKER_KINDS = new Set(["ic", "roll", "narration"]);       // lines that let a player's character move (not OOC)
export const MOVE_MODES = new Set(["human", "followup", "side", "relay", "attention", "manual"]);
export const norm = (s) => String(s ?? "").trim().toLowerCase();
export const names = (v) => (Array.isArray(v) ? v : [v]).map((x) => String(x ?? "").trim()).filter(Boolean);
// Splits text at paragraph or line breaks into pieces of at most `max` characters.
export function chunk(text, max) {
  const out = [];
  let cur = "";
  for (const line of String(text).split(/(?<=\n)/)) {
    for (const piece of line.length > max ? line.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) : [line]) {
      if (cur.length + piece.length > max) { out.push(cur); cur = ""; }
      cur += piece;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

export const HOUR = 3600000;
export const EVENT_MIN_LINES = 4, EVENT_MAX_LINES = 120;
