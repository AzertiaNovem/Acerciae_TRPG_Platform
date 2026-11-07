import { JsonFieldError } from './llm/json-repair.mjs';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const idPattern = /^[a-z][a-z0-9_-]{0,39}$/;
const label = (value, path, limit = 160) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit) throw new JsonFieldError(path, `Expected nonempty text, at most ${limit} UTF-8 bytes`);
};
const has = (rows, id) => rows.some(row => row.id === id);
const collect = () => {
  const errors = [];
  return {
    check(fn) { try { fn(); } catch (e) { if (!(e instanceof JsonFieldError)) throw e; errors.push(e); } },
    finish() { if (errors.length) throw new JsonFieldError([...new Set(errors.flatMap(e => e.paths))], errors.map(e => e.message).join('; ')); },
  };
};

// The schema accepted by backend/src/rules/Pbta.cpp, with precise repair locations. The platform preview remains
// authoritative: this check only saves a whole design from being regenerated for one malformed field.
export function validatePack(pack) {
  if (!object(pack)) throw new JsonFieldError('/pack', 'Expected a schemaVersion 1 PbtA pack object');
  const missing = ['schemaVersion', 'name', 'stats', 'books', 'bands', 'moves', 'gmMoves', 'resources', 'conditions'].filter(k => !Object.hasOwn(pack, k));
  if (missing.length) throw new JsonFieldError(missing.map(k => '/pack/' + k), 'Missing template fields: schemaVersion is 1, name is nonempty text; all other fields are definition arrays; stats, books and bands must be nonempty');
  if (pack.schemaVersion !== 1) throw new JsonFieldError('/pack/schemaVersion', 'Expected 1');
  if (Buffer.byteLength(JSON.stringify(pack)) > 128 * 1024) throw new JsonFieldError('/pack', 'Pack must fit in 128 KiB; shorten text while keeping the design and IDs');
  label(pack.name, '/pack/name');
  for (const key of ['stats', 'books', 'resources', 'conditions', 'moves', 'bands', 'gmMoves']) {
    const rows = pack[key], path = '/pack/' + key;
    if (!Array.isArray(rows) || rows.length > 120 || (['stats', 'books', 'bands'].includes(key) && !rows.length)) throw new JsonFieldError(path, 'Expected a definition array (at most 120); stats, books and bands must be nonempty');
    const seen = new Set();
    const definitions = collect();
    rows.forEach((row, i) => definitions.check(() => {
      if (!object(row)) throw new JsonFieldError(`${path}/${i}`, 'Expected a definition object with id and name');
      if (typeof row.id !== 'string' || !idPattern.test(row.id) || ['constructor', 'prototype'].includes(row.id) || seen.has(row.id)) throw new JsonFieldError(`${path}/${i}/id`, 'Expected a unique lowercase ASCII ID matching [a-z][a-z0-9_-]{0,39}, excluding constructor and prototype');
      seen.add(row.id); label(row.name, `${path}/${i}/name`);
    }));
    definitions.finish();
  }
  let next = 0;
  pack.bands.forEach((b, i) => {
    const path = `/pack/bands/${i}`;
    if (!Object.hasOwn(b, 'min') || (i === 0 ? b.min !== null : !Number.isInteger(b.min) || b.min !== next)) throw new JsonFieldError(path + '/min', i === 0 ? 'First band must have min:null (open lower bound)' : `Expected ${next}, contiguous with the previous band`);
    if (!Object.hasOwn(b, 'max') || (i === pack.bands.length - 1 ? b.max !== null : !Number.isInteger(b.max) || Math.abs(b.max) > 10000 || (b.min !== null && b.max < next))) throw new JsonFieldError(path + '/max', i === pack.bands.length - 1 ? 'Last band must have max:null (open upper bound)' : 'Expected an integer upper bound at least min and within +/-10000');
    if (Number.isInteger(b.max)) next = b.max + 1;
  });
  const moves = collect();
  pack.moves.forEach((m, i) => {
    const path = `/pack/moves/${i}`;
    moves.check(() => label(m.trigger, path + '/trigger', 2400));
    moves.check(() => { if (typeof m.book !== 'string' || (m.book !== '' && !has(pack.books, m.book))) throw new JsonFieldError(path + '/book', 'Use an existing playbook ID, or an empty string for a shared move'); });
    moves.check(() => { if (typeof m.stat !== 'string' || (m.stat !== '' && !has(pack.stats, m.stat))) throw new JsonFieldError(path + '/stat', 'Use an existing stat ID, or an empty string for a diceless move'); });
    moves.check(() => { if (!Array.isArray(m.playerChoiceBands) || new Set(m.playerChoiceBands).size !== m.playerChoiceBands.length || !m.playerChoiceBands.every(b => typeof b === 'string' && (m.stat === '' ? b === 'no_roll' : has(pack.bands, b)))) throw new JsonFieldError(path + '/playerChoiceBands', 'Expected unique existing band IDs where the player chooses; for a diceless move use ["no_roll"] or []; use [] when no player choice is required'); });
    const bandIds = m.stat === '' ? [] : pack.bands.map(b => b.id);
    moves.check(() => { if (!object(m.outcomes) || Object.keys(m.outcomes).length !== bandIds.length || bandIds.some(id => !Object.hasOwn(m.outcomes, id) || typeof m.outcomes[id] !== 'string' || !m.outcomes[id].trim() || Buffer.byteLength(m.outcomes[id]) > 2400)) throw new JsonFieldError(path + '/outcomes', `Expected an object with exactly these band IDs: ${JSON.stringify(bandIds)}, each with nonempty outcome text up to 2400 UTF-8 bytes; diceless moves use {}`); });
  });
  moves.finish();
  if (!pack.moves.some(m => m.stat) || !pack.moves.some(m => !m.stat) || !pack.moves.some(m => m.book) || !pack.moves.some(m => !m.book)) throw new JsonFieldError('/pack/moves', 'Include rolled and diceless moves, shared moves and a playbook move; preserve valid moves and IDs');
  pack.gmMoves.forEach((m, i) => label(m.text, `/pack/gmMoves/${i}/text`, 2400));
}

export function validateActor(value, pack, { existing, takenNames, requiredBook }) {
  if (!object(value)) throw Error('Expected a character JSON object');
  if (typeof value.name !== 'string' || !value.name.trim() || (!existing && takenNames.includes(value.name))) throw new JsonFieldError('/name', 'Expected a nonempty character name that is not already taken');
  if (!object(value.role_card)) throw new JsonFieldError('/role_card', 'Expected {basic,background,pbta:{book,stats,resources,conditions}}; maps, not lists');
  const sheet = value.role_card.pbta;
  if (!object(sheet)) throw new JsonFieldError('/role_card/pbta', 'Expected {book,stats,resources,conditions}; use an existing playbook ID and ID-keyed maps');
  if ((requiredBook && sheet.book !== requiredBook) || !has(pack.books, sheet.book)) throw new JsonFieldError('/role_card/pbta/book', `Choose ${requiredBook || 'one of ' + pack.books.map(b => b.id).join(', ')}`);
  const invalid = [], hints = [];
  for (const group of ['stats', 'resources', 'conditions']) {
    const entries = sheet[group] ?? {};
    if (!object(entries) || !Object.entries(entries).every(([k, v]) => has(pack[group], k) && (group === 'conditions' ? typeof v === 'boolean' : Number.isInteger(v) && Math.abs(v) <= 9999))) {
      invalid.push('/role_card/pbta/' + group);
      hints.push(`${group}: an object keyed only by ${JSON.stringify(pack[group].map(d => d.id))}; ${group === 'conditions' ? 'values must be JSON true/false, not strings, numbers or descriptions' : 'values must be integers within +/-9999'}; an empty object {} is allowed`);
    }
  }
  if (invalid.length) throw new JsonFieldError(invalid, hints.join('; '));
}
