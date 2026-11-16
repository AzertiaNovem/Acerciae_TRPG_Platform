// Private, structured story state. Character IDs, never names, identify each directed relationship.
// This module is pure: callers commit its returned copy only after the associated turn is accepted.
import crypto from 'node:crypto';

const DAY = 86400000;
const own = (o, k) => Object.hasOwn(o ?? {}, k);
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const text = (v, max, field) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw Error(`${field} must be nonempty text, at most ${max} characters`);
  return v.trim();
};
const id = v => {
  const s = text(v, 80, 'id');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(s) || ['constructor','prototype','__proto__'].includes(s)) throw Error('Use a stable ASCII id');
  return s;
};
export const digest = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const valueKey = (metric, subject = '', target = '') => JSON.stringify([metric, subject, target]);
export const emptyWorldState = () => ({ schemaVersion: 1, revision: 0, definitions: {}, values: {}, fired: {}, events: [], audit: [], seeds: {}, pending: null });

export function worldState(raw) {
  if (raw == null) return emptyWorldState();
  if (!object(raw) || raw.schemaVersion !== 1) throw Error('Unsupported world state version; refusing to discard it');
  const s = structuredClone(raw);
  for (const k of ['definitions', 'values', 'fired', 'seeds']) if (!object(s[k])) throw Error(`Invalid world state ${k}`);
  if (!Array.isArray(s.events) || !Array.isArray(s.audit) || !Number.isSafeInteger(s.revision)) throw Error('Invalid world state');
  return s;
}

export function pruneWorldState(s, now = Date.now()) {
  s.audit = s.audit.filter(x => x.at >= now - 30 * DAY).slice(-1000);
  const pending = s.events.filter(x => x.status === 'pending');
  s.events = [...pending, ...s.events.filter(x => x.status !== 'pending' && x.at >= now - 30 * DAY).slice(-(Math.max(0, 1000 - pending.length)))];
  return s;
}

function checkedValue(d, value) {
  if (d.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < d.min || value > d.max)) throw Error(`${d.id}: value must be between ${d.min} and ${d.max}`);
  if (d.type === 'boolean' && typeof value !== 'boolean') throw Error(`${d.id}: expected a boolean`);
  if (d.type === 'enum' && !d.options.includes(value)) throw Error(`${d.id}: value must be one of ${d.options.join(', ')}`);
  return value;
}

export function validateDefinition(raw) {
  if (!object(raw)) throw Error('definition must be an object');
  const d = { id: id(raw.id), label: text(raw.label, 80, 'label'), description: text(raw.description, 600, 'description'),
    scope: raw.scope, type: raw.type, initial: raw.initial, changeRule: text(raw.changeRule, 800, 'changeRule') };
  if (!['relation', 'character', 'world'].includes(d.scope) || !['number', 'boolean', 'enum'].includes(d.type)) throw Error('Invalid scope or value type');
  if (d.type === 'number') {
    if (![raw.min, raw.max].every(Number.isFinite) || raw.min >= raw.max) throw Error('A number needs finite min < max');
    d.min = raw.min; d.max = raw.max;
    if (raw.maxChangePerScene != null) {
      if (!Number.isFinite(raw.maxChangePerScene) || raw.maxChangePerScene <= 0) throw Error('maxChangePerScene must be positive');
      d.maxChangePerScene = raw.maxChangePerScene;
    }
  }
  if (d.type === 'enum') {
    if (!Array.isArray(raw.options) || !raw.options.length || raw.options.length > 20) throw Error('An enum needs 1–20 options');
    d.options = [...new Set(raw.options.map(x => text(x, 80, 'option')))];
  }
  checkedValue(d, d.initial);
  if (raw.thresholds != null && (!Array.isArray(raw.thresholds) || raw.thresholds.length > 12)) throw Error('At most 12 thresholds per definition');
  d.thresholds = (raw.thresholds ?? []).map(t => {
    if (!object(t?.when)) throw Error('Threshold needs a when condition');
    const join = own(t.when, 'all') ? 'all' : 'any', tests = t.when[join];
    if (Object.keys(t.when).length !== 1 || !Array.isArray(tests) || !tests.length || tests.length > 8) throw Error('when needs all or any with 1–8 tests');
    return { id: id(t.id), event: text(t.event, 600, 'event'), when: { [join]: tests.map(c => {
      if (!['>=', '<=', '>', '<', '==', '!='].includes(c?.op) || !['string', 'boolean', 'number'].includes(typeof c.value) || (typeof c.value === 'number' && !Number.isFinite(c.value))) throw Error('Invalid threshold comparison');
      return { metric: id(c.metric), op: c.op, value: c.value };
    }) } };
  });
  if (new Set(d.thresholds.map(t => t.id)).size !== d.thresholds.length) throw Error('Threshold IDs must be unique');
  return d;
}

function checkReferences(s) {
  for (const d of Object.values(s.definitions)) for (const t of d.thresholds) for (const c of t.when.all ?? t.when.any) {
    const other = s.definitions[c.metric];
    if (!other || other.scope !== d.scope || typeof other.initial !== typeof c.value || (other.type !== 'number' && !['==', '!='].includes(c.op))) throw Error(`Threshold ${t.id} references an incompatible metric ${c.metric}`);
  }
}

function actors(d, subject, target, { characters = [], npcIds = [] } = {}) {
  const exists = v => characters.some(c => c.id === v);
  if (d.scope === 'world') { if (subject || target) throw Error('World state has no character subject or target'); return; }
  if (!exists(subject)) throw Error('Unknown subject character ID');
  if (d.scope === 'character') { if (target) throw Error('Character state has no target'); return; }
  if (!new Set(npcIds).has(subject)) throw Error('Only a real NPC may own a directed relationship metric');
  if (!exists(target) || subject === target) throw Error('A relationship needs a distinct target character');
}

const compare = (a, op, b) => ({ '>=': () => a >= b, '<=': () => a <= b, '>': () => a > b, '<': () => a < b, '==': () => a === b, '!=': () => a !== b })[op]();

function evaluate(s, now) {
  // Only explicitly tracked pairs/characters exist. Never create a full-cast matrix or borrow another pair's value.
  for (const v of Object.values(s.values)) {
    const d = s.definitions[v.metric];
    for (const t of d.thresholds) {
      const key = valueKey(`${d.id}/${t.id}`, v.subject, v.target);
      if (own(s.fired, key)) continue;
      const matches = c => {
        const x = s.values[valueKey(c.metric, v.subject, v.target)];
        return x != null && compare(x.value, c.op, c.value);
      };
      const yes = t.when.all ? t.when.all.every(matches) : t.when.any.some(matches);
      if (!yes) continue;
      if (s.events.filter(e => e.status === 'pending').length >= 500) throw Error('Too many pending world events; resolve existing ones first');
      const eventId = digest(key).slice(0, 24);
      s.fired[key] = eventId;
      s.events.push({ id: eventId, metric: d.id, threshold: t.id, subject: v.subject, target: v.target, text: t.event, status: 'pending', at: now });
    }
  }
}

// Each operation is absolute, version checked and identified by a caller-owned receipt. Transport retries can reuse it.
export function applyWorldOperation(current, operation, context = {}) {
  const now = context.now ?? Date.now();
  const s = worldState(current), op = structuredClone(operation);
  const reason = text(op.reason, 800, 'reason');
  let before, after, subject = op.subject ?? '', target = op.target ?? '', metric = op.metric ? id(op.metric) : '';
  if (op.type === 'define') {
    const d = validateDefinition(op.definition), old = s.definitions[d.id];
    if (old && op.expectedRevision !== old.revision) throw Error('Definition changed; read its revision again');
    if (!old && Object.keys(s.definitions).length >= 128) throw Error('At most 128 world metrics');
    if (old && (old.type !== d.type || old.scope !== d.scope)) throw Error('An existing metric cannot change type or scope');
    d.revision = (old?.revision ?? 0) + 1;
    for (const v of Object.values(s.values).filter(v => v.metric === d.id)) checkedValue(d, v.value);
    s.definitions[d.id] = d;
    checkReferences(s);
    metric = d.id; before = old ?? null; after = d;
  } else if (op.type === 'set') {
    const d = s.definitions[metric];
    if (!d) throw Error('Define the metric before setting it');
    actors(d, subject, target, context);
    const key = valueKey(metric, subject, target), old = s.values[key];
    if (!old && Object.keys(s.values).length >= 2000) throw Error('At most 2000 tracked world values');
    before = old?.value ?? d.initial;
    if (op.expected !== before) throw Error(`State changed; expected ${JSON.stringify(before)}`);
    const value = checkedValue(d, op.value);
    const scene = String(context.scene ?? 'opening');
    const spent = old?.scene === scene ? old.spent ?? 0 : 0;
    const change = d.type === 'number' ? Math.abs(value - before) : 0;
    if (!context.seed && d.maxChangePerScene != null && spent + change > d.maxChangePerScene + 1e-9) throw Error(`${metric}: scene change allowance exceeded`);
    s.values[key] = { metric, subject, target, value, scene, spent: context.seed ? 0 : spent + change, at: now, reason };
    after = value;
  } else if (op.type === 'resolve') {
    const e = s.events.find(e => e.id === op.eventId);
    if (!e || e.status !== 'pending') throw Error('Event is not pending');
    if (!['done', 'dismissed'].includes(op.status)) throw Error('Invalid event resolution');
    subject = e.subject; target = e.target; metric = e.metric;
    if (op.status === 'done' && context.canResolve && !context.canResolve(e)) throw Error('Event must wait for its participants and scene');
    before = e.status; e.status = op.status; e.reason = reason; e.resolvedAt = now; after = e.status;
  } else throw Error('Unknown world state operation');
  evaluate(s, now);
  s.revision++;
  s.audit.push({ at: now, revision: s.revision, type: op.type, metric, subject, target, before, after, reason,
    source: context.source ?? '', operationId: context.operationId ?? '' });
  return pruneWorldState(s, now);
}

// Forge keeps the seed private. Stable C-number keys are mapped only after the platform created the cast.
export function seedWorldState(current, seed, { characterIds = {}, characters = [], npcIds = characters.filter(c => c.kind === 'npc').map(c => c.id), sourceId, now = Date.now() } = {}) {
  let s = worldState(current);
  const source = text(sourceId, 160, 'seed source');
  const fingerprint = digest(seed);
  if (own(s.seeds, source)) {
    if (s.seeds[source] !== fingerprint) throw Error('Forge seed changed after activation');
    return s;
  }
  if (!object(seed) || !Array.isArray(seed.definitions) || !Array.isArray(seed.values)) throw Error('Seed needs definitions and values arrays');
  if (seed.definitions.length > 128 || seed.values.length > 2000) throw Error('Forge seed is too large');
  // Define the whole batch first so conditions may refer to a later definition.
  for (const raw of seed.definitions) {
    const d = validateDefinition(raw);
    if (own(s.definitions, d.id)) throw Error(`Metric ${d.id} already exists`);
    s.definitions[d.id] = { ...d, revision: 1 };
  }
  checkReferences(s);
  for (const row of seed.values) {
    const d = s.definitions[row.metric];
    if (!d) throw Error(`Unknown initial metric ${row.metric}`);
    s = applyWorldOperation(s, { type: 'set', ...row, subject: characterIds[row.subject] ?? row.subject ?? '', target: characterIds[row.target] ?? row.target ?? '', expected: d.initial, reason: row.reason || 'Forge initial state' }, { characters, npcIds, source, seed: true, now });
  }
  s.seeds[source] = fingerprint; s.revision++;
  return s;
}

export function stateView(s, { characters = [], subject = '', target = '', offset = 0, limit = 40 } = {}) {
  const names = new Map(characters.map(c => [c.id, c.name]));
  const rows = Object.values(s.values).filter(v => (!subject || v.subject === subject || v.target === subject) && (!target || v.target === target));
  return { revision: s.revision, total: rows.length, values: rows.slice(offset, offset + limit).map(v => ({ ...v,
    subjectName: names.get(v.subject) ?? v.subject, targetName: names.get(v.target) ?? v.target, definition: s.definitions[v.metric] })),
    events: s.events.filter(e => e.status === 'pending' && (!subject || e.subject === subject || e.target === subject) && (!target || e.target === target)).slice(0, limit),
    definitions: Object.values(s.definitions).map(d => ({ id: d.id, label: d.label, scope: d.scope, type: d.type })) };
}

export function renderWorldState(s, { characters = [], relevant = [], budget = 7000 } = {}) {
  const names = new Map(characters.map(c => [c.id, c.name]));
  const who = v => [v.subject && `${names.get(v.subject) ?? v.subject} [${v.subject}]`, v.target && `→ ${names.get(v.target) ?? v.target} [${v.target}]`].filter(Boolean).join(' ') || 'world';
  const lines = [`## Structured world state (GM private, revision ${s.revision})`, 'Directed NPC attitudes belong ONLY to the specified target. Never infer reciprocal feelings. Read tools can fetch omitted details.'];
  const values = Object.values(s.values).sort((a, b) => Number(relevant.includes(b.subject) || relevant.includes(b.target)) - Number(relevant.includes(a.subject) || relevant.includes(a.target)) || b.at - a.at);
  const add = line => { if (lines.join('\n').length + line.length > budget) return false; lines.push(line); return true; };
  for (const e of s.events.filter(e => e.status === 'pending')) if (!add(`Pending ${e.id}: ${who(e)} — ${e.text}`)) break;
  let shown = 0;
  for (const v of values) {
    const d = s.definitions[v.metric];
    if (!add(`${who(v)} | ${d.label} [${d.id}]: ${JSON.stringify(v.value)}${d.type === 'number' ? ` (${d.min}..${d.max})` : ''} — ${v.reason}`)) break;
    shown++;
  }
  add(`Metric index: ${Object.values(s.definitions).map(d => `${d.id}=${d.label}`).join(', ') || '(empty; add only what the story needs)'}`);
  if (shown < values.length) lines.push(`${values.length - shown} further values available with world_state_read.`);
  return lines.join('\n');
}
