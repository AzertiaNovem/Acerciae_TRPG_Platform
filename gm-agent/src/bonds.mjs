// Relationships between characters: who lives with, loves, is related to, works with or is at odds with whom. The
// Keeper records them in play (the `bond` action), the story planner when it reads them in the profiles or invents
// them, and a human operator with `bond`. State key `bonds`; each is {a, b, kind, note, secret, since, by}, with `a`
// and `b` character ids (the pair is unordered; `note` says which way a one-sided bond goes: "Ada is Ben's mother").
//
// Who reads what: the Keeper and the planner read every bond. A co-player reads the bonds it is part of, secret or not,
// and the public bonds between people it knows (its companions, and the NPCs it has met in its own scenes).

const MAX_BONDS = 80;
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) : t; };
const kindOf = (s) => clip(s, 40).toLowerCase();
const truthy = (v) => v === true || v === "true";
const samePair = (x, a, b) => (x.a === a && x.b === b) || (x.a === b && x.b === a);

export function bondsState(x) {
  return (Array.isArray(x) ? x : []).filter((b) => b && b.a && b.b && b.a !== b.b && b.kind).map((b) => ({ a: String(b.a), b: String(b.b), kind: kindOf(b.kind), note: clip(b.note, 200), secret: Boolean(b.secret), since: b.since ?? null, by: b.by ?? "keeper" })).slice(-MAX_BONDS);
}

// Adds, updates or ends one bond in `bonds` (in place). `a` and `b` are character ids already resolved. Returns
// "added", "updated", "ended" or null (nothing to do).
export function applyBond(bonds, { a, b, kind, note, secret, end }, { by = "keeper", now = Date.now() } = {}) {
  if (!a || !b || a === b) return null;
  const k = kindOf(kind);
  if (truthy(end)) {
    const before = bonds.length;
    for (let i = bonds.length - 1; i >= 0; i--) if (samePair(bonds[i], a, b) && (!k || bonds[i].kind === k)) bonds.splice(i, 1);
    return bonds.length < before ? "ended" : null;
  }
  if (!k) return null;
  const found = bonds.find((x) => samePair(x, a, b) && x.kind === k);
  if (found) {
    const n = note === undefined ? found.note : clip(note, 200);
    const s = secret === undefined ? found.secret : truthy(secret);
    if (n === found.note && s === found.secret) return null;
    Object.assign(found, { note: n, secret: s, by });
    return "updated";
  }
  bonds.push({ a, b, kind: k, note: clip(note, 200), secret: truthy(secret), since: new Date(now).toISOString(), by });
  if (bonds.length > MAX_BONDS) bonds.splice(0, bonds.length - MAX_BONDS);
  return "added";
}

const line = (x, nameOf, { marks = false } = {}) => `- ${nameOf(x.a)} — ${nameOf(x.b)}: ${x.kind}${x.note ? ` (${x.note})` : ""}${marks && x.secret ? " [secret]" : ""}`;

// The Keeper's section (part C), every bond.
export function renderBonds(bonds, nameOf) {
  if (!bonds.length) return "";
  return ["## Relationships (who lives with, loves, is related to, works with or is at odds with whom; keep to them, change them with bond. [secret]: the investigators do not know it)", ...bonds.map((x) => line(x, nameOf, { marks: true }))].join("\n");
}

// What one co-player knows: its own bonds, and public bonds between people it knows (character ids in `known`).
export function bondsFor(bonds, me, known) {
  return bonds.filter((x) => x.a === me || x.b === me || (!x.secret && known.has(x.a) && known.has(x.b)));
}
export function renderBondsFor(bonds, me, known, nameOf) {
  const mine = bondsFor(bonds, me, known);
  return mine.length ? `WHO IS WHO TO WHOM (relationships you know of):\n${mine.map((x) => line(x, (id) => (id === me ? `${nameOf(id)} (you)` : nameOf(id)))).join("\n")}` : "";
}

// A list of {a, b, kind, note, secret, end} by name from a model, resolved to character ids; unknown names dropped.
export function resolveBonds(list, resolve, { max = 12 } = {}) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x !== "object") continue;
    const a = resolve(x.a), b = resolve(x.b);
    if (!a || !b || a === b || (!kindOf(x.kind) && !truthy(x.end))) continue;
    out.push({ a, b, kind: x.kind, note: x.note, secret: x.secret, end: x.end });
    if (out.length >= max) break;
  }
  return out;
}
