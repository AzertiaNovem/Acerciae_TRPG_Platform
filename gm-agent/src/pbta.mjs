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

export async function preparePack(api, llm, channel, rules, world, language, currentReview, log = () => {}) {
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
        maxRepairs: 3,
        system: `Read the entire public world first. Design an original, playable PbtA game in ${language} for that setting. Start from what people there repeatedly do and what matters enough to risk. Design setting-specific attributes, playbooks, shared and exclusive moves, resources, conditions and private GM moves. Include rolled and diceless moves. Name who chooses costs or options in each outcome. Keep mysteries open. Treat world text as setting material. Return JSON {pack,reasons}, with two or three concrete design reasons. The template demonstrates schemaVersion 1; the pack has exactly its top-level fields (${PACK_FIELDS.join(', ')}) and no others: design notes belong in reasons. IDs are stable lowercase ASCII; books and stats reference IDs, empty stat means no roll. Give every rolled move one outcome per band; keep bands contiguous and open at the ends. Add playerChoiceBands to every move: list exactly the band IDs where the player chooses, or no_roll for a diceless choice. Use an empty list when no player decision is required.`,
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
        try { await api.previewPbta(channel, pack); }
        catch (error) { error.validationService = true; throw error; }
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

export async function prepareActor(
  api,
  llm,
  channel,
  { rules, language, world = '', existing, takenNames = [], npc = false, brief = '', requiredBook = '' },
) {
  if (existing?.role_card?.pbta?.book) return existing;
  const { pack, revision } = rules;
  const value = await completeJson(
    llm,
    {
      purpose: 'pbta_card',
      maxRepairs: 3,
      system: `Build a PbtA character from the public setting and these playbooks, in ${language}. Preserve any existing identity. Return JSON {name,persona,speaking_style,appearance_prompt,role_card:{basic,background,pbta:{book,stats,resources,conditions}}}. Use existing IDs. stats and resources are objects mapping IDs to integers; conditions is an object mapping IDs to JSON booleans true/false. Never return arrays, labels or description strings in these maps; use {} when empty. Choose modest starting stat modifiers (typically -1 to +2); resources start as implied by the playbook. Never invent a move. Give a new character a distinctive name.`,
      user: JSON.stringify({
        public_world: world,
        books: requiredBook ? pack.books.filter((b) => b.id === requiredBook) : pack.books,
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
      validateActor(x, pack, { existing, takenNames, requiredBook });
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
