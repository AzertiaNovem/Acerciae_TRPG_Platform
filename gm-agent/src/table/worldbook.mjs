// worldbook: table is the explicit runtime context supplied by Table; no service singleton.
//
// The worldbook file (`<channel>.worldbook.json` in the state directory) is what the host's Web UI edits; the table's
// state keeps its bible and hidden layer too (improv.world, improv.secrets), so every older reader of the world
// keeps working. `improv.book` records the file revision and the texts they were last synced at:
//   * the file moved on (an edit in the Web UI): its bible and hidden layer become the state's;
//   * the state moved on while the file did not (the Forge, the `world` command, a state from before the worldbook):
//     the state's texts are written into the file, its entries kept;
//   * both moved: the file wins, since that is where a person edited it last.
// Every write says who made it (`updatedBy`: "agent", "web" or "forge"). With no record yet (the first start, or a
// state replaced since), the file wins unless the agent itself wrote it last.
// A table without a state directory (tests, read-only commands) reads the state alone and has no entries.
import { operatorPath, readOperatorFile, writeOperatorFile, watchOperatorFile } from "../operator-files.mjs";
import { worldbookState, entriesInPlay, findEntry, renderIndex, renderInPlay, WORLDBOOK_DEFAULTS, WORLDBOOK_TOOL, WORLDBOOK_TOOL_RULE } from "../worldbook.mjs";
import { hashText } from "../improv.mjs";

const textsHash = (im) => hashText(`${im.world}\u0000${im.secrets}`);
const settings = (table) => ({ ...WORLDBOOK_DEFAULTS, ...(table.cfg.worldbook ?? {}) });

export function worldbookFile(table) { return table.operatorDir ? operatorPath(table.operatorDir, table.channelId, "worldbook") : null; }

function adopt(table, book) {
  const im = table.improv;
  const changed = im.world !== book.bible || im.secrets !== book.hidden;
  im.world = book.bible; im.secrets = book.hidden;
  im.book = { revision: book.revision, hash: textsHash(im) };
  table.save();
  table.log(`worldbook: revision ${book.revision} in use (bible ${book.bible.length} characters, hidden ${book.hidden.length}, ${book.entries.length} entries)`);
  if (changed && table.ready) Promise.resolve(table.seedWorld()).catch((e) => table.log(`world record: ${e.message}`));
}

// The book in use. The file is read again only when it changed.
export function worldbook(table) {
  const file = worldbookFile(table);
  if (!file) return worldbookState({ bible: table.improv.world, hidden: table.improv.secrets });
  table.readWorldbook ??= watchOperatorFile(file, worldbookState, (m) => table.log(`worldbook: ${m}`));
  const book = table.readWorldbook();
  if (!book.revision) return worldbookState({ bible: table.improv.world, hidden: table.improv.secrets });
  // Only once `run` has brought file and state together: before that, a newer world in the state (the Forge) must win.
  if (table.improv.on && table.worldbookSynced && table.improv.book?.revision !== book.revision) adopt(table, book);
  return book;
}

// A bible and hidden layer into a channel's worldbook file, keeping its entries. Returns the sync record for the state
// ({revision, hash}). The Forge uses it too when play starts.
export function writeWorldbookTexts(stateDir, channelId, { world = "", secrets = "" }, by = "agent") {
  const written = writeOperatorFile(operatorPath(stateDir, channelId, "worldbook"), (cur) => {
    const book = worldbookState(cur);
    return { bible: world, hidden: secrets, entries: book.entries, nextId: book.nextId, updatedBy: by };
  });
  return { revision: written.revision, hash: textsHash({ world, secrets }) };
}

// The state's bible and hidden layer into the file.
export function writeBible(table) {
  const im = table.improv;
  if (!table.operatorDir || !im.on) return;
  try { im.book = writeWorldbookTexts(table.operatorDir, table.channelId, im); table.save(); }
  catch (e) { table.log(`worldbook: ${e.message}`); }
}

// When `run` starts: bring the file and the state together (see the top of this file).
export function syncWorldbook(table) {
  const file = worldbookFile(table), im = table.improv;
  table.worldbookSynced = true;
  if (!file || !im.on) return;
  let raw;
  try { raw = readOperatorFile(file); } catch (e) { table.log(`worldbook: ${e.message}; it is not used until it is fixed`); return; }
  if (!raw) {
    if (!im.world && !im.secrets) return;
    writeBible(table);
    table.log(`worldbook: ${file} created from the world setting`);
    return;
  }
  const book = worldbookState(raw);
  if (im.world === book.bible && im.secrets === book.hidden) { im.book = { revision: book.revision, hash: textsHash(im) }; table.save(); return; }
  const stateWins = !im.book
    ? raw.updatedBy === "agent" && Boolean(im.world || im.secrets)
    : im.book.hash !== textsHash(im) && im.book.revision === book.revision;
  if (stateWins) { writeBible(table); table.log("worldbook: the world setting changed outside the Web UI; written into the worldbook"); return; }
  if (im.book && im.book.hash !== textsHash(im)) table.log("worldbook: both the worldbook and the world setting changed; the worldbook wins");
  adopt(table, book);
}

// ---- in play

// Entries the GM opened with the tool stay in play in that window for the next `recent_lines` lines there.
function requested(table, windowId) {
  const asked = table.loreRequests?.get(windowId);
  if (!asked) return [];
  const now = table.history.lines(windowId).length, keep = settings(table).recent_lines;
  for (const [id, at] of asked) if (now - at >= keep) asked.delete(id);
  return [...asked.keys()];
}

const lineTexts = (lines, n) => lines.slice(-n).reverse().map((m) => m.dice?.text ?? m.content).filter(Boolean);

// The GM's sections, built with its context: the index (cached with the campaign) and the entries in play here (a
// part that changes every few turns). `lines` are this window's lines the GM reads; null without entries.
export function gmWorldbook(table, windowId, { lines = [], place = "", scenario = "" } = {}) {
  if (!table.improv.on) return null;
  const book = worldbook(table);
  if (!book.entries.length) return null;
  const s = settings(table);
  const inPlay = entriesInPlay(book, { texts: [...lineTexts(lines, s.recent_lines), place, scenario], requested: requested(table, windowId), secret: true, budget: s.gm_tokens });
  return { index: renderIndex(book), inPlay: renderInPlay(inPlay, { gm: true }) };
}

// What a co-player or a stand-in knows of what came up: public entries only, from the lines it witnessed and the other
// texts given (its place, a text thread). "" without entries.
export function publicLore(table, { lines = [], texts = [] } = {}) {
  if (!table.improv.on) return "";
  const book = worldbook(table);
  if (!book.entries.length) return "";
  const s = settings(table);
  return renderInPlay(entriesInPlay(book, { texts: [...lineTexts(lines, s.recent_lines), ...texts], secret: false, budget: s.coplayer_tokens }));
}

// ---- the worldbook_read tool, beside the world state tools (the GM) or the planner's read-only ones

export function withWorldbookTool(table, windowId, toolkit) {
  if (!toolkit || !table.improv.on) return toolkit;
  const book = worldbook(table);
  if (!book.entries.length) return toolkit;
  return {
    tools: [...toolkit.tools, WORLDBOOK_TOOL],
    call: (name, args, callId) => (name === WORLDBOOK_TOOL.name ? readEntry(table, windowId, args) : toolkit.call(name, args, callId)),
  };
}

export function worldbookToolRule(table) {
  return table.improv.on && worldbook(table).entries.length ? WORLDBOOK_TOOL_RULE : "";
}

function readEntry(table, windowId, args) {
  const book = worldbook(table);
  const e = findEntry(book, args?.title, { secret: true });
  if (!e) return { error: `No worldbook entry "${String(args?.title ?? "").slice(0, 80)}". Titles: ${book.entries.filter((x) => x.enabled).map((x) => x.title).join("; ").slice(0, 2000)}` };
  if (windowId) {
    table.loreRequests ??= new Map();
    if (!table.loreRequests.has(windowId)) table.loreRequests.set(windowId, new Map());
    table.loreRequests.get(windowId).set(e.id, table.history.lines(windowId).length);
  }
  return { title: e.title, secret: e.secret, text: e.body };
}
