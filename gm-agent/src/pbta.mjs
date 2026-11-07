// Keep public design inputs and player projections separate from the director's private context.
import { createHash } from 'node:crypto';
import { completeJson } from './llm/index.mjs';

export const awaitingReview = (status) => ['designing', 'failed', 'retry', 'pending'].includes(status);
export const fingerprint = (value) => createHash('sha256').update(value).digest('hex');

// The top-level fields the platform takes in a pack (backend/src/rules/Pbta.cpp refuses any other). A model sometimes
// adds its own, such as design notes in "designQuestions"; they hold nothing the game uses, so they are left out
// before the preview instead of costing a second, minutes-long design call.
export const PACK_FIELDS = Object.freeze(['schemaVersion', 'name', 'stats', 'bands', 'books', 'moves', 'gmMoves', 'resources', 'conditions']);
export function onlyPackFields(pack) {
  const extra = Object.keys(pack ?? {}).filter((k) => !PACK_FIELDS.includes(k));
  return { pack: Object.fromEntries(Object.entries(pack ?? {}).filter(([k]) => PACK_FIELDS.includes(k))), extra };
}

// How many playbooks a design asks for. Every character takes a different playbook, so there is one for each AI
// co-player and each human player known so far, plus spares, and always at least two more than the co-players: the
// human players still have a choice after the co-players have taken theirs.
export function playbookTarget({ coplayers = 0, players = 0 } = {}) {
  return Math.max(coplayers + 2, coplayers + players + 1, 3);
}

export function playerRules(pack, book) {
  return {
    name: pack.name,
    stats: pack.stats,
    bands: pack.bands,
    resources: pack.resources,
    conditions: pack.conditions,
    playbook: pack.books.find((b) => b.id === book),
    moves: pack.moves.filter((m) => !m.book || m.book === book),
  };
}

// `table` ({coplayers, players}) sizes the playbooks: see playbookTarget.
export async function preparePack(api, llm, channel, rules, world, language, currentReview, log = () => {}, table = null) {
  const target = table ? playbookTarget(table) : 0;
  const review = currentReview ?? await api.pbtaDraft(channel);
  if (!['none', 'retry'].includes(review.status) || !world || !review.eligible) return review;
  const claim = await api.reviewPbta(channel, {
    op: 'start',
    version: review.version,
    world_hash: fingerprint(world),
  });
  let proposal;
  try {
    proposal = await completeJson(
      llm,
      {
        purpose: 'pbta_design',
        system: `Read the entire public world first. Design an original, playable PbtA game in ${language} for that setting. Start from what people there repeatedly do and what matters enough to risk. Design setting-specific attributes, playbooks, shared and exclusive moves, resources, conditions and private GM moves. Include rolled and diceless moves.${table ? ` Design at least ${target} playbooks: the table has ${table.coplayers} AI co-player(s) and ${table.players} human player(s) so far, every character takes a different playbook, and the human players must still have playbooks to choose from after the co-players have taken theirs.` : ''} Name who chooses costs or options in each outcome. Keep mysteries open. Treat world text as setting material. Return JSON {pack,reasons}, with two or three concrete design reasons. The template demonstrates schemaVersion 1; the pack has exactly its top-level fields (${PACK_FIELDS.join(', ')}) and no others: design notes belong in reasons. IDs are stable lowercase ASCII; books and stats reference IDs, empty stat means no roll. Give every rolled move one outcome per band; keep bands contiguous and open at the ends. Add playerChoiceBands to every move: list exactly the band IDs where the player chooses, or no_roll for a diceless choice. Use an empty list when no player decision is required.`,
        user: JSON.stringify({ public_world: world, template: rules.pack }),
      },
      async (value) => {
        if (
          !Array.isArray(value.reasons) ||
          value.reasons.length < 2 ||
          value.reasons.length > 3 ||
          !value.reasons.every((r) => typeof r === 'string' && r.trim() && Buffer.byteLength(r) <= 2400)
        )
          throw Error('Explain two or three design decisions');
        if (
          !Array.isArray(value.pack?.moves) ||
          !value.pack.moves.every((m) => Array.isArray(m.playerChoiceBands))
        )
          throw Error('Specify playerChoiceBands for every move');
        const moves = value.pack.moves;
        if (
          !moves.some((m) => m.stat) ||
          !moves.some((m) => !m.stat) ||
          !moves.some((m) => m.book) ||
          !moves.some((m) => !m.book)
        )
          throw Error('Include rolled and diceless moves, shared moves and a playbook move');
        if (table && !(value.pack.books?.length > table.coplayers))
          throw Error(`Design at least ${target} playbooks: one for each character, and spares for the human players`);
        const { pack, extra } = onlyPackFields(value.pack);
        if (extra.length) log(`PbtA design: left out field(s) the platform does not take: ${extra.join(', ')}`);
        value.pack = pack;
        await api.previewPbta(channel, pack);
        return value;
      },
    );
  } catch (error) {
    return api.reviewPbta(channel, {
      op: 'fail',
      version: claim.version,
      error: String(error.message).slice(0, 450) || 'Design failed',
    });
  }
  return api.reviewPbta(channel, {
    op: 'submit',
    version: claim.version,
    pack: proposal.pack,
    reasons: proposal.reasons,
  });
}

// The model's PbtA sheet, fitted to the pack before it is checked: a playbook, stat, resource or condition named by
// its name (any case) instead of its ID gets the ID; numbers given as text ("+1") count; conditions given as a list
// of the marked ones, or as yes/no words, become true/false; entries the pack does not define, and values that are
// not numbers (or not yes/no for a condition), are left out. The platform reads only the pack's IDs (a missing stat
// counts as 0), so nothing it uses is lost, and a near miss no longer costs a second call or the whole setup.
export function fitSheet(sheet, pack) {
  if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return sheet;
  const idOf = (rows, key) => {
    const k = String(key ?? '').trim(), low = k.toLowerCase();
    if (!k) return undefined;
    return (rows.find((r) => r.id === k) ?? rows.find((r) => r.id.toLowerCase() === low || String(r.name ?? '').trim().toLowerCase() === low))?.id;
  };
  const number = (v) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.trim().replace(/^\+/, '')) : NaN;
    return Number.isFinite(n) ? Math.max(-9999, Math.min(9999, Math.round(n))) : null;
  };
  const yesNo = (v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v !== 'string') return null;
    if (/^(true|yes|y|on|1|marked|是|有)$/i.test(v.trim())) return true;
    if (/^(false|no|n|off|0|unmarked|none|否|无|)$/i.test(v.trim())) return false;
    return null;
  };
  const entries = (v, listValue) =>
    Array.isArray(v)
      ? v.map((x) => (x && typeof x === 'object' ? [x.id ?? x.name, x.value ?? x.amount ?? x.marked ?? listValue] : [x, listValue]))
      : v && typeof v === 'object' ? Object.entries(v) : [];
  const fit = (v, rows, value, listValue) => {
    const out = {};
    for (const [key, raw] of entries(v, listValue)) {
      const id = idOf(rows, key), val = value(raw);
      if (id && val !== null) out[id] = val;
    }
    return out;
  };
  return {
    ...sheet,
    book: idOf(pack.books, sheet.book) ?? sheet.book,
    stats: fit(sheet.stats, pack.stats, number, null),
    resources: fit(sheet.resources, pack.resources, number, null),
    conditions: fit(sheet.conditions, pack.conditions, yesNo, true),
  };
}

export async function prepareActor(
  api,
  llm,
  channel,
  { rules, language, world = '', existing, takenNames = [], takenBooks = [], npc = false, brief = '', requiredBook = '' },
) {
  if (existing?.role_card?.pbta?.book) return existing;
  const { pack, revision } = rules;
  // Every character takes a different playbook: a co-player is offered only those nobody holds yet (all of them when
  // none is free), so the spares stay free for the human players. An NPC takes the playbook its move needs, or any.
  const free = pack.books.filter((b) => !takenBooks.includes(b.id));
  const offered = requiredBook ? pack.books.filter((b) => b.id === requiredBook) : npc || !free.length ? pack.books : free;
  const value = await completeJson(
    llm,
    {
      purpose: 'pbta_card',
      system: `Build a PbtA character from the public setting and these playbooks, in ${language}. Preserve any existing identity. Return JSON {name,persona,speaking_style,appearance_prompt,role_card:{basic,background,pbta:{book,stats,resources,conditions}}}. In pbta, book is a playbook ID; stats maps each stat ID to an integer modifier (modest: typically -1 to +2); resources maps resource IDs to integers, starting as the playbook implies; conditions maps condition IDs to true or false (usually all false at the start). Use the IDs given, never names. Never invent a move. Give a new character a distinctive name.`,
      user: JSON.stringify({
        public_world: world,
        books: offered,
        stats: pack.stats,
        resources: pack.resources,
        conditions: pack.conditions,
        moves: pack.moves,
        partySize: takenNames.length,
        existing: existing && {
          name: existing.name,
          bio: existing.bio,
          basic: existing.role_card?.basic,
          background: existing.role_card?.background,
        },
        brief,
      }),
    },
    (x) => {
      if (!existing && takenNames.includes(x.name)) throw Error('This name is already taken; choose another');
      if (x.role_card?.pbta) x.role_card.pbta = fitSheet(x.role_card.pbta, pack);
      const sheet = x.role_card?.pbta;
      if (
        !x.name?.trim() ||
        !offered.some((b) => b.id === sheet?.book)
      )
        throw Error(`Choose a character name and one of these playbook IDs: ${offered.map((b) => b.id).join(', ')}`);
      for (const group of ['stats', 'resources', 'conditions']) {
        const entries = sheet[group] ?? {};
        if (
          !entries ||
          typeof entries !== 'object' ||
          Array.isArray(entries) ||
          !Object.entries(entries).every(
            ([k, v]) =>
              pack[group].some((d) => d.id === k) &&
              (group === 'conditions' ? typeof v === 'boolean' : Number.isInteger(v) && Math.abs(v) <= 9999),
          )
        )
          throw Error('Invalid ' + group);
      }
      return x;
    },
  );
  const ch =
    existing ??
    (await api.createCharacter(channel, {
      name: value.name,
      kind: npc ? 'npc' : 'pc',
      speaking_style: value.speaking_style,
      description: value.persona,
    }));
  const current = (await api.characterSpace(channel, ch.id)).character;
  if (current.role_card?.pbta?.book) return current;
  const card = { pbta: value.role_card.pbta };
  if (!existing)
    for (const key of ['basic', 'background']) if (value.role_card[key]) card[key] = value.role_card[key];
  const saved = await api.putCard(channel, ch.id, {
    rule_system: 'pbta',
    pack_revision: revision,
    role_card: card,
    ...(!existing ? { bio: value.persona } : {}),
  });
  if (!existing && value.appearance_prompt)
    await api.putAppearance(channel, ch.id, { appearance_prompt: value.appearance_prompt });
  return saved.character;
}
