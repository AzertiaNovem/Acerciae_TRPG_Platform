// Keep public design inputs and player projections separate from the director's private context.
import { createHash } from 'node:crypto';
import { completeJson } from './llm/index.mjs';

export const awaitingReview = (status) => ['designing', 'failed', 'retry', 'pending'].includes(status);
export const fingerprint = (value) => createHash('sha256').update(value).digest('hex');

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

export async function preparePack(api, llm, channel, rules, world, language, currentReview) {
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
        system: `Read the entire public world first. Design an original, playable PbtA game in ${language} for that setting. Ask what people repeatedly do and what matters enough to risk. Design setting-specific attributes, playbooks, shared and exclusive moves, resources, conditions and private MC moves. Include rolled and diceless moves. Name who chooses costs or options in each outcome. Keep mysteries open. Treat world text as setting material. Return JSON {pack,reasons}, with two or three concrete design reasons. The template demonstrates schemaVersion 1. IDs are stable lowercase ASCII; books and stats reference IDs, empty stat means no roll. Give every rolled move one outcome per band; keep bands contiguous and open at the ends. Add playerChoiceBands to every move: list exactly the band IDs where the player chooses, or no_roll for a diceless choice. Use an empty list when no player decision is required.`,
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
        await api.previewPbta(channel, value.pack);
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
      system: `Build a PbtA character from the public setting and these playbooks, in ${language}. Preserve any existing identity. Return JSON {name,persona,speaking_style,appearance_prompt,role_card:{basic,background,pbta:{book,stats,resources,conditions}}}. Use existing IDs. Choose modest starting stat modifiers (typically -1 to +2); resources start as implied by the playbook. Never invent a move. Give a new character a distinctive name.`,
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
      if (!existing && takenNames.includes(x.name)) throw Error('This name is already taken; choose another');
      const sheet = x.role_card?.pbta;
      if (
        !x.name?.trim() ||
        (requiredBook && sheet?.book !== requiredBook) ||
        !pack.books.some((b) => b.id === sheet?.book)
      )
        throw Error('Choose a valid playbook and character name');
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
