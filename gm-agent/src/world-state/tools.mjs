import { applyWorldOperation, stateView, worldState, digest } from './state.mjs';

const str = { type: 'string' }, num = { type: 'number' }, integer = { type: 'integer', minimum: 0 };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const basisSchema = obj({ kind: { enum: ['observed', 'reply'] }, seq: integer, quote: str }, ['kind']);
const condition = obj({ metric: str, op: { enum: ['>=', '<=', '>', '<', '==', '!='] }, value: { type: ['number', 'boolean', 'string'] } });
const definition = obj({ id: str, label: str, description: str, scope: { enum: ['relation', 'character', 'world'] }, type: { enum: ['number', 'boolean', 'enum'] },
  initial: { type: ['number', 'boolean', 'string'] }, min: num, max: num, options: { type: 'array', items: str }, maxChangePerScene: num, changeRule: str,
  thresholds: { type: 'array', items: obj({ id: str, event: str, when: obj({ all: { type: 'array', items: condition }, any: { type: 'array', items: condition } }, []) }) } },
['id', 'label', 'description', 'scope', 'type', 'initial', 'changeRule']);

export const WORLD_TOOL_RULES = `Structured world state tools are private bookkeeping for improvisation. Use them when a lasting fact, NPC attitude, flag or possession changes. Only real NPCs own directed attitude meters; each target has a separate value (human PC, co-player or NPC). Do not assign feelings or choices to a human or co-player. Do not generate a full cast matrix or assume reciprocity. Reuse defined metrics and record only meaningful changes with a concrete reason. You may establish a new metric when play needs it; define its range, change rule and thresholds consistently with the world. Existing game attributes, calendar, locations and formal bonds still use their existing tools/actions.
The tools return STAGED state, not completed publication. For a change established in the supplied chat, use basis {kind:"observed",seq:<exact line number>}. Do not process the same fact again on follow-up turns. For an effect this reply will establish, use basis {kind:"reply",quote:"an exact short phrase you will include in ONE final paragraph"}. The quote must occur verbatim in a narration, existing NPC, whisper or GM-only paragraph; do not attach state changes to rolls, new NPCs, phone queues or hypothetical prose. Stage changes in the order their supporting paragraphs will appear. Do not claim a tool's rejected change succeeded. Inventory is authoritative on the platform; read it before updating. Gain creates objects only when the fiction warrants it, lose consumes/discards them, transfer conserves quantity. Never invent a player's voluntary gift, loss or action.
Thresholds unlock a private opportunity, not an already completed event. Read pending events, respect absence, scene membership and unresolved dice, and play them only when appropriate. Resolve an event as done only with a reply quote that actually performs it; otherwise leave it pending. Finish with only the plain text turn and normal staging cues. Never print tool calls, JSON, private meters or hidden rules in chat.`;

export const READ_TOOL = { name: 'world_state_read', description: 'Read private state, metric definitions, pending events and authoritative inventories. Filter by character ID or metric; paginate values with offset.',
  schema: obj({ subject: str, target: str, metric: str, offset: integer }, []) };
export const WORLD_TOOLS = [READ_TOOL,
  { name: 'world_state_define', description: 'Stage a metric definition. Existing definitions require expectedRevision. Never renumber a fired threshold to trigger it again.', schema: obj({ definition, reason: str, expectedRevision: integer }, ['definition', 'reason']) },
  { name: 'world_state_set', description: 'Stage an absolute value for one subject/target, checked against expected. An untracked pair starts at the definition initial value. A relationship subject must be an NPC.',
    schema: obj({ metric: str, subject: str, target: str, expected: { type: ['number', 'boolean', 'string'] }, value: { type: ['number', 'boolean', 'string'] }, reason: str, basis: basisSchema }, ['metric', 'expected', 'value', 'reason', 'basis']) },
  { name: 'world_state_resolve_event', description: 'Stage completion of a pending opportunity with evidence in the final prose, or dismiss it with a reason based on an observed line.', schema: obj({ eventId: str, status: { enum: ['done', 'dismissed'] }, reason: str, basis: basisSchema }) },
  { name: 'inventory_change', description: 'Stage a gain, loss or transfer of an item. Read inventory first. itemIndex is zero-based in the read result. Preserve actual ownership and quantity; never spend a player resource for an undecided action.',
    schema: obj({ kind: { enum: ['gain', 'lose', 'transfer'] }, owner: str, recipient: str, itemIndex: integer, expectedQty: num, quantity: num, name: str, note: str, reason: str, basis: basisSchema }, ['kind', 'owner', 'quantity', 'reason', 'basis']) },
];

export function changeInventory(rows, op) {
  const out = structuredClone(rows), owner = out.find(c => c.id === op.owner);
  if (!owner) throw Error('Read the owner inventory first');
  if (!Number.isFinite(op.quantity) || op.quantity <= 0 || op.quantity > 9999) throw Error('quantity must be positive and at most 9999');
  const add = (recipient, item) => {
    const found = recipient.items.find(i => i.name === item.name && i.note === item.note);
    if (found) { if (found.qty + op.quantity > 9999) throw Error('Item quantity exceeds 9999'); found.qty += op.quantity; }
    else { if (recipient.items.length >= 60) throw Error('Inventory holds at most 60 entries'); recipient.items.push({ ...item, qty: op.quantity }); }
  };
  if (op.kind === 'gain') {
    if (typeof op.name !== 'string' || !op.name.trim() || op.name.length > 80 || (op.note != null && (typeof op.note !== 'string' || op.note.length > 300))) throw Error('Item needs a name (80 characters) and optional note (300 characters)');
    add(owner, { name: op.name.trim(), note: op.note ?? '' });
  } else if (op.kind === 'lose' || op.kind === 'transfer') {
    const item = Number.isInteger(op.itemIndex) && owner.items[op.itemIndex];
    if (!item || item.qty !== op.expectedQty) throw Error('Item changed; read its index and quantity again');
    if (item.qty < op.quantity) throw Error('Not enough of this item');
    if (op.kind === 'transfer') {
      const recipient = out.find(c => c.id === op.recipient);
      if (!recipient || recipient.id === owner.id) throw Error('A transfer needs a different recipient');
      add(recipient, item);
    }
    item.qty -= op.quantity;
    if (!item.qty) owner.items.splice(op.itemIndex, 1);
  } else throw Error('Unknown inventory operation');
  return out;
}

export function observationKey(op, basis) {
  if (basis.kind !== 'observed') return '';
  return digest([basis.seq, op.type, op.metric ?? '', op.subject ?? '', op.target ?? '', op.kind ?? '', op.owner ?? '', op.recipient ?? '', op.itemIndex ?? '', op.name ?? '', op.eventId ?? '']);
}

export class WorldDraft {
  constructor(state, { characters, npcIds, scene, now = Date.now(), lines = [], inventory = [], inventoryAvailable = false, canResolve = () => true, mayChange = () => true } = {}) {
    this.state = worldState(state); this.context = { characters, npcIds, scene, now, canResolve };
    this.lines = lines; this.inventory = structuredClone(inventory); this.initialInventory = structuredClone(inventory);
    this.inventoryAvailable = inventoryAvailable; this.mayChange = mayChange; this.entries = [];
    this.toolkit = { tools: WORLD_TOOLS.filter(t => inventoryAvailable || t.name !== 'inventory_change'), call: (name,args,callId) => this.call(name,args,callId) };
  }
  basis(raw, op) {
    if (raw?.kind === 'observed') {
      if (!Number.isSafeInteger(raw.seq) || !this.lines.some(l => l.seq === raw.seq && !l.recalled_at && ['ic', 'narration', 'roll'].includes(l.kind))) throw Error('Observed basis must name a supplied, unrecalled in-fiction line');
      if (op.type === 'resolve' && op.status === 'done') throw Error('Complete the event in a reply paragraph');
      return { kind: 'observed', seq: raw.seq };
    }
    if (raw?.kind === 'reply' && typeof raw.quote === 'string' && raw.quote.trim().length >= 4 && raw.quote.length <= 300) return { kind: 'reply', quote: raw.quote.trim() };
    throw Error('Provide observed line seq or an exact reply quote (4–300 characters)');
  }
  read(args = {}) {
    if (args.metric) {
      const d = this.state.definitions[args.metric];
      if (!d || typeof d !== 'object') throw Error('Unknown metric');
      return { definition: d, values: Object.values(this.state.values).filter(v => v.metric === args.metric && (!args.subject || v.subject === args.subject) && (!args.target || v.target === args.target)).slice(args.offset ?? 0, (args.offset ?? 0) + 40) };
    }
    return { ...stateView(this.state, { ...this.context, ...args }), inventoryAvailable: this.inventoryAvailable,
      inventory: this.inventory.filter(c => !args.subject || c.id === args.subject).slice(args.offset ?? 0, (args.offset ?? 0) + 20) };
  }
  call(name, args, callId) {
    if (name === 'world_state_read') return this.read(args);
    if (this.entries.length >= 24) throw Error('At most 24 state edits per turn');
    const type = { world_state_define: 'define', world_state_set: 'set', world_state_resolve_event: 'resolve', inventory_change: 'inventory' }[name];
    if (!type) throw Error('Unknown world tool');
    const op = { ...args, type }; delete op.basis;
    if (typeof op.reason !== 'string' || !op.reason.trim() || op.reason.length > 800) throw Error('A concrete reason of at most 800 characters is required');
    const basis = type === 'define' ? { kind: 'definition' } : this.basis(args.basis, op);
    const key = observationKey(op, basis);
    if (key && (this.state.observations?.[key] || this.entries.some(e => e.key === key))) return { alreadyRecorded: true, message: 'This fact already updated this state. Do not apply it again.' };
    this.mayChange(op, basis);
    if (type === 'inventory') {
      if (!this.inventoryAvailable) throw Error('Platform inventory transactions unavailable');
      this.inventory = changeInventory(this.inventory, op);
    } else this.state = applyWorldOperation(this.state, op, { ...this.context, operationId: callId, source: JSON.stringify(basis) });
    this.entries.push({ op, basis, key, callId });
    return { staged: true, revision: this.state.revision, pendingEvents: this.state.events.filter(e => e.status === 'pending'), ...(type === 'inventory' ? { inventory: this.inventory.filter(c => [op.owner, op.recipient].includes(c.id)) } : {}) };
  }
  bind(plan) {
    let last = -1;
    const groups = new Map();
    for (const entry of this.entries) {
      let index = -1;
      if (entry.basis.kind === 'reply') {
        const matches = plan.actions.map((a,i) => ({a,i})).filter(({a}) => ['narrate','npc','whisper','note'].includes(a.type) && !a.move_id && a.text?.includes(entry.basis.quote));
        if (matches.length !== 1) throw Error('A state change quote must occur in exactly one ordinary reply action');
        index = matches[0].i;
      } else if (entry.basis.kind === 'definition') index = last;
      if (index < last) throw Error('Stage state changes in the order of their supporting reply paragraphs, with observed facts first');
      last = index;
      if (!groups.has(index)) groups.set(index, []);
      groups.get(index).push(entry);
    }
    return groups;
  }
}
