// Pictures in chat, as the table reads them. A picture line is a chat line with `media_asset_id`: one a member
// uploaded (a handout, a map, a photo) or one the platform's image AI drew. Its text is the "🖼️" mark and then the
// caption, if it has one. The table's models cannot see pictures: the caption is all they know of one.
const MARKS = ["🖼️", "🖼"];

// The caption of a picture line (its text without the mark); "" for a picture posted without one.
export function captionOf(m) {
  let text = String(m?.content ?? "").trim();
  for (const mark of MARKS) if (text.startsWith(mark)) { text = text.slice(mark.length); break; }
  return text.trim();
}

// A picture posted with no caption: there is nothing in it the table can read or answer.
export function pictureOnly(m) {
  return Boolean(m?.media_asset_id) && !captionOf(m);
}

// How a picture line reads in a model's log.
export function pictureText(m) {
  const caption = captionOf(m);
  return caption ? `[posts a picture; you cannot see it, its caption says:] ${caption}` : "[posts a picture without a caption; you cannot see pictures]";
}
