// Keep public design inputs and player projections separate from the director's private context.
import { createHash } from 'node:crypto';
import { completeJson } from './llm/index.mjs';
import { JsonFieldError } from './llm/json-repair.mjs';
import { validatePack, validateActor } from './pbta-validation.mjs';

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

// `table` ({coplayers, players}) sizes the playbooks: see playbookTarget. `watchMs` is how often the draft is checked
// while the model designs.
export async function preparePack(api, llm, channel, rules, world, language, currentReview, log = () => {}, table = null, { watchMs = 5000 } = {}) {
  const target = table ? playbookTarget(table) : 0;
  const review = currentReview ?? await api.pbtaDraft(channel);
  if (!['none', 'retry'].includes(review.status) || !world || !review.eligible) return review;
  const claim = await api.reviewPbta(channel, {
    op: 'start',
    version: review.version,
    world_hash: fingerprint(world),
  });
  let proposal;
  // The GM may keep or activate rules while the model is still designing (a design can take minutes, and transient
  // failures are retried). The draft is checked meanwhile; once the claim is no longer current, the design call and
  // its retries stop, and the GM's decision is taken (the caller reads it after the refused fail below).
  const decided = new AbortController();
  const watch = setInterval(async () => {
    try {
      const now = await api.pbtaDraft(channel);
      if (now.status !== 'designing' || now.version !== claim.version) decided.abort(Object.assign(Error('the GM decided while the rules were being designed'), { gmDecided: true }));
    } catch {}
  }, watchMs);
  watch.unref?.();
  const own = llm.signalOf?.();
  try {
    proposal = await completeJson(
      llm,
      {
        purpose: 'pbta_design',
        maxRepairs: 3,
        signal: own ? AbortSignal.any([own, decided.signal]) : decided.signal,
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
          throw new JsonFieldError('/reasons', 'Explain two or three design decisions as nonempty strings, each at most 2400 UTF-8 bytes');
        if (!value.pack || typeof value.pack !== 'object' || Array.isArray(value.pack)) throw new JsonFieldError('/pack', 'Expected a PbtA pack object matching the template');
        const { pack, extra } = onlyPackFields(value.pack);
        if (extra.length) log(`PbtA design: left out field(s) the platform does not take: ${extra.join(', ')}`);
        value.pack = pack;
        validatePack(pack);
        if (table && !(pack.books.length > table.coplayers))
          throw new JsonFieldError('/pack/books', `Design at least ${target} playbooks: one for each character (${table.coplayers} AI co-player(s) and ${table.players} human player(s)), and spares for the human players; keep the existing playbooks and IDs`);
        try { await api.previewPbta(channel, pack); }
        catch (error) { error.validationService = true; throw error; }
        return value;
      },
    );
  } catch (error) {
    if (decided.signal.aborted) log('PbtA design stopped: the GM decided while the rules were being designed');
    return api.reviewPbta(channel, {
      op: 'fail',
      version: claim.version,
      error: String(error.message).slice(0, 450) || 'Design failed',
    });
  } finally {
    clearInterval(watch);
  }
  return api.reviewPbta(channel, {
    op: 'submit',
    version: claim.version,
    pack: proposal.pack,
    reasons: proposal.reasons,
  });
}

// The model's PbtA sheet, fitted to the pack before it is checked, where the fix is unambiguous: a playbook, stat,
// resource or condition named by its name (any case) gets its ID; numbers given as text ("+1") count; yes/no words
// become true/false; a list of conditions, each named or given by ID, marks them true. Anything else is kept as it was
// (an unknown key, a value that is not a number or yes/no, another shape), so the field-level repair asks the model
// about it instead of guessing.
export function fitSheet(sheet, pack) {
  if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return sheet;
  const idOf = (rows, key) => {
    const k = String(key ?? '').trim(), low = k.toLowerCase();
    if (!k) return undefined;
    return (rows.find((r) => r.id === k) ?? rows.find((r) => r.id.toLowerCase() === low || String(r.name ?? '').trim().toLowerCase() === low))?.id;
  };
  const number = (v) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(v) ? Number(v.trim().replace(/^\+/, '')) : NaN;
    return Number.isFinite(n) && Math.abs(n) <= 9999 ? Math.round(n) : v;
  };
  const yesNo = (v) => {
    if (typeof v !== 'string') return v;
    if (/^(true|yes|y|on|marked|是|有)$/i.test(v.trim())) return true;
    if (/^(false|no|n|off|unmarked|none|否|无)$/i.test(v.trim())) return false;
    return v;
  };
  const fit = (v, rows, value) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const out = {};
    for (const [key, raw] of Object.entries(v)) out[idOf(rows, key) ?? key] = value(raw);
    return out;
  };
  const listed = (v, rows) => {
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string' && idOf(rows, x))) return fit(v, rows, yesNo);
    return Object.fromEntries(v.map((x) => [idOf(rows, x), true]));
  };
  return {
    ...sheet,
    book: idOf(pack.books, sheet.book) ?? sheet.book,
    stats: fit(sheet.stats, pack.stats, number),
    resources: fit(sheet.resources, pack.resources, number),
    conditions: listed(sheet.conditions, pack.conditions),
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
      maxRepairs: 3,
      system: `Build a PbtA character from the public setting and these playbooks, in ${language}. Preserve any existing identity. Return JSON {name,persona,speaking_style,appearance_prompt,role_card:{basic,background,pbta:{book,stats,resources,conditions}}}. Use existing IDs. stats and resources are objects mapping IDs to integers; conditions is an object mapping IDs to JSON booleans true/false. Never return arrays, labels or description strings in these maps; use {} when empty. Choose modest starting stat modifiers (typically -1 to +2); resources start as implied by the playbook. Never invent a move. Give a new character a distinctive name.`,
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
      if (x?.role_card?.pbta) x.role_card.pbta = fitSheet(x.role_card.pbta, pack);
      validateActor(x, { ...pack, books: offered }, { existing, takenNames, requiredBook });
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
