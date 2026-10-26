const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function renderHtml(payload) {
  const { snapshot, config: c, images = {}, appendices = [] } = payload;
  if (!snapshot || !Array.isArray(snapshot.events))
    throw Error("snapshot events required");
  if (
    !["classic", "dossier", "novel"].includes(c.base) ||
    !["A4", "A5", "B5"].includes(c.page_size) ||
    !["portrait", "landscape"].includes(c.orientation)
  )
    throw Error("invalid template");
  for (const [k, min, max] of [
    ["font_size", 8, 24],
    ["margin_mm", 8, 40],
    ["line_height", 1, 2.5],
  ])
    if (!Number.isFinite(c[k]) || c[k] < min || c[k] > max)
      throw Error(`invalid ${k}`);
  const img = (id) => {
    const src = images[id]?.data_uri;
    if (!src) return "";
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src))
      throw Error("invalid embedded image");
    return `<img src="${src}" alt="Illustration"/>`;
  };
  const sections = [];
  let section;
  for (const e of snapshot.events) {
    if (!c.include_ooc && e.event_type === "ooc") continue;
    if (!section || section.key !== e.scene_key) {
      section = {
        key: e.scene_key,
        title: e.scene_title || "记录",
        events: [],
      };
      sections.push(section);
    }
    section.events.push(e);
  }
  for (const a of appendices)
    sections.push({
      key: `appendix-${a.document_id}`,
      title: `附录 · ${a.title}`,
      events: a.entries.map((e) => ({
        event_type: "narration",
        speaker_display_name: e.summary,
        content: e.content + "\n来源: " + (e.source_event_ids || []).join(", "),
      })),
    });
  const colors = new Map(),
    palette = ["#355c68", "#894c38", "#3e6b45", "#785781", "#8a5d16"];
  const color = (e) => {
    const configured =
      c.character_colors?.[e.speaker_key] ||
      snapshot.character_map?.[e.speaker_key]?.color;
    if (/^#[0-9a-fA-F]{6}$/.test(configured || "")) return configured;
    if (!colors.has(e.speaker_key))
      colors.set(e.speaker_key, palette[colors.size % palette.length]);
    return colors.get(e.speaker_key);
  };
  const line = (e) =>
    `<article class="${esc(e.event_type)}"><span class="speaker" style="color:${color(e)}">${esc(e.speaker_display_name)}</span>${c.timestamps ? `<time>${esc(e.time_text || (e.timestamp ? new Date(e.timestamp * 1000).toISOString() : ""))}</time>` : ""}<div class="speech">${esc(e.content)}</div>${e.dice && c.dice_style !== "hide" ? `<aside class="dice ${c.dice_style === "inline" ? "inline" : ""}">${esc(e.metadata?.dice_result?.text || e.dice.raw || "")}</aside>` : ""}</article>`;
  const css = `@page { size: ${c.page_size} ${c.orientation}; margin: ${c.margin_mm}mm; @top-center { content: ${JSON.stringify(c.header || "").replace(/</g, "\\3c ")}; font-size:8pt; } @bottom-left {content: ${JSON.stringify(c.footer || "").replace(/</g, "\\3c ")};font-size:8pt} @bottom-center { content: ${c.page_numbers ? "counter(page)" : `""`}; font-size:8pt; } } * {box-sizing:border-box} body {font: ${c.font_size}pt/${c.line_height} ${c.font === "sans" ? '"Noto Sans CJK SC", sans-serif' : '"Noto Serif CJK SC", serif'}; color:#243139; line-break:strict; overflow-wrap:anywhere;} h1,h2 {line-height:1.3; break-after:avoid} h2 {border-bottom:1px solid #8c9c9e; padding-bottom:6mm;} p,article {orphans:3;widows:3} .cover {min-height:70vh;display:flex;flex-direction:column;justify-content:center;break-after:page} .cover h1 {font-size:28pt} img {max-width:100%;max-height:65vh;object-fit:contain;display:block;margin:5mm auto} nav {break-after:page} nav a {color:inherit; text-decoration:none} nav li {margin:3mm 0} nav a::after {content:leader('.') target-counter(attr(href),page)} section {${c.chapter_breaks ? "break-before:page;" : ""}} article {margin:0 0 4mm;} .speaker {font-weight:600;} .speech {white-space:pre-wrap} time {font:7pt sans-serif;color:#667;float:right} .dice {font-size:9pt;background:#eef1ec;padding:2mm 3mm;border-left:2px solid #81998b;white-space:pre-wrap;break-inside:avoid} .dice.inline{background:none;border:0;padding:0} .ooc {color:#6a737c;font-size:90%} .narration .speaker{font-style:italic} ${c.base === "dossier" ? "body {background:#faf7ed} h2 {text-transform:uppercase;letter-spacing:.06em} article {border-bottom:1px dotted #c5bfa9;padding-bottom:3mm} .cover {border:2px solid #788678;padding:10mm}" : ""} ${c.base === "novel" ? ".speaker {display:block;font-size:85%} .speech {text-indent:1em} article {margin-bottom:5mm} h2 {text-align:center;border:0;margin:18mm 0}" : ""}`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'self' data:"><title>${esc(c.title || snapshot.title)}</title><style>${css}</style><body><div class="cover">${img(c.cover_asset_id)}<h1>${esc(c.title || snapshot.title)}</h1><p>${esc(c.subtitle)}</p><small>Acerciae · ${esc(snapshot.scope)} · v${esc(snapshot.version)}</small></div>${c.toc ? `<nav role="doc-toc"><h2>目录</h2><ol>${sections.map((s, i) => `<li><a href="#s${i}">${esc(s.title)}</a></li>`).join("")}</ol></nav>` : ""}${sections.map((s, i) => `<section id="s${i}"><h2>${esc(s.title)}</h2>${img(c.scene_images?.[s.key])}${s.events.map(line).join("")}</section>`).join("")}</body></html>`;
}
