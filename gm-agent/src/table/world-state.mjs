import crypto from 'node:crypto';
import { WorldDraft, changeInventory, READ_TOOL, WORLD_TOOL_RULES } from '../world-state/tools.mjs';
import { applyWorldOperation, worldState, renderWorldState, pruneWorldState } from '../world-state/state.mjs';

const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const unavailable = e => [404,405].includes(e?.status);
export const rememberInventory = (table, rows) => {
  table.worldInventory ??= [];
  for (const row of rows) {
    const old = table.worldInventory.findIndex(c => c.id === row.id);
    if (old >= 0 && table.worldInventory[old].version > row.version) continue;
    const value = { id: row.id, name: row.name ?? table.nameOf(row.id), items: row.items, version: row.version };
    if (old < 0) table.worldInventory.push(value); else table.worldInventory[old] = value;
    const c = table.characters.find(c => c.id === row.id);
    if (c) { c.role_card = { ...c.role_card, items: structuredClone(row.items) }; c.inventory_version = row.version; }
    table.cards.delete(row.id);
  }
};

export async function refreshWorldInventory(table) {
  if (!table.improv.on) return;
  if (typeof table.api.inventory !== 'function') { table.worldInventoryAvailable = false; return; }
  try {
    const result = await table.api.inventory(table.channelId);
    if (!result?.supported || !Array.isArray(result.characters)) throw Error('Invalid inventory response');
    table.worldInventory = []; rememberInventory(table, result.characters);
    table.worldInventoryAvailable = true; table.worldInventoryError = null;
  } catch (e) {
    table.worldInventoryAvailable = false;
    table.worldInventoryError = unavailable(e) ? '平台尚未提供背包事务接口。' : e.message;
  }
}

export function worldContext(table, windowId) {
  if (!table.improv.on) return '';
  const relevant = table.scene(windowId)?.members ?? [];
  const text = renderWorldState(table.worldState, { characters: table.characters, relevant });
  const inventory = (table.worldInventory ?? []).filter(c => relevant.includes(c.id)).map(c => ({ id: c.id, name: c.name, items: c.items }));
  return text + '\n' + (table.worldInventoryAvailable ? `Scene inventories (platform): ${JSON.stringify(inventory).slice(0, 6000)}` : 'Inventory sync unavailable; do not assume an item change succeeded.');
}

const context = (table, windowId) => ({
  characters: table.characters, npcIds: table.roster.npcs.map(c => c.characterId), now: table.now(),
  // A scene budget follows the actual scenario, thread, day and explicit cuts, never model-created labels.
  scene: JSON.stringify([table.scenario?.id ?? '', table.scene(windowId)?.id ?? windowId, table.calendar.date ?? '', table.worldState.sceneEpoch?.[windowId] ?? 0]),
  canResolve: event => [event.subject, event.target].filter(Boolean).every(id => {
    if (!table.characters.some(c => c.id === id)) return false;

    if (table.isPc(id) || table.roster.isCoplayer(id)) return table.scene(windowId)?.members.includes(id);
    return true;
  }),
});

export async function beginWorldDraft(table, windowId) {
  if (!table.improv.on) return null;
  if (table.worldState.recallPending) await recoverWorldRecall(table);
  if (table.worldState.pending) await recoverWorldState(table);
  await refreshWorldInventory(table);
  const draft = new WorldDraft(table.worldState, { ...context(table, windowId), lines: table.sceneHistory(windowId).slice(-200),
    inventory: table.worldInventory ?? [], inventoryAvailable: table.worldInventoryAvailable });
  return draft;
}

export function plannerWorldTools(table) {
  if (!table.improv.on) return null;
  // Freeze the planner's view for its entire draft/critique/revise cycle.
  const draft = new WorldDraft(table.worldState, { ...context(table, table.primaryWindowId()), inventory: table.worldInventory ?? [], inventoryAvailable: table.worldInventoryAvailable });
  return { tools: [READ_TOOL], call: (name, args) => { if (name !== READ_TOOL.name) throw Error('Planner world state is read-only'); return draft.read(args); } };
}

function bodyFor(table, a) {
  if (a.move_id) throw Error('Resolve the roll before changing world state');
  if (a.type === 'narrate') return { kind: 'narration', visibility: 'window', content: a.text };
  if (a.type === 'note') return { kind: 'narration', visibility: 'gm_only', content: a.text };
  if (a.type === 'npc') {
    const c = table.roster.npcByName(a.name);
    if (!c || table.roster.isCoplayer(c.characterId) || table.isPc(c.characterId)) throw Error('State changes need an already established NPC');
    return { kind: 'ic', visibility: 'window', character_id: c.characterId, content: a.text };
  }
  if (a.type === 'whisper') {
    const c = table.characterByName(a.to);
    if (!c) throw Error('State change whisper recipient is unknown');
    return { kind: 'narration', visibility: 'whisper', whisper_to: [c.id], content: a.text };
  }
  throw Error('Unsupported state-linked message');
}

function strictSave(table, next) {
  const old = table.worldState;
  table.worldState = next;
  try { table.persist(table); } catch (e) { table.worldState = old; throw e; }
}

// Prepare durably before either remote write. The intent contains exact request IDs and expected item versions.
export async function commitWorldGroup(table, windowId, entries, action = null) {
  if (!entries?.length) return false;
  table.generation.signal.throwIfAborted();
  if (table.worldState.pending) throw Error('A world state operation is awaiting recovery');
  const id = crypto.randomUUID(), before = worldState(table.worldState);
  let after = worldState(before), inventory = structuredClone(table.worldInventory ?? []);
  for (const e of entries) {
    if (e.key && after.observations?.[e.key]) continue;
    if (e.op.type === 'inventory') inventory = changeInventory(inventory, e.op);
    else after = applyWorldOperation(after, e.op, { ...context(table, windowId), operationId: `${id}:${e.callId}`, source: JSON.stringify(e.basis) });
    if (e.key) (after.observations ??= {})[e.key] = table.now();
    if (e.op.type === 'inventory') {
      after.revision++;
      after.audit.push({ type: 'inventory', at: table.now(), revision: after.revision, subject: e.op.owner, target: e.op.recipient ?? '', reason: e.op.reason, after: e.op.kind, source: JSON.stringify(e.basis) });
    }
  }
  after.observations = Object.fromEntries(Object.entries(after.observations ?? {}).filter(([,at]) => at >= table.now() - 30*86400000).slice(-2000));
  pruneWorldState(after, table.now());
  const changes = inventory.filter(c => !equal(c.items, (table.worldInventory ?? []).find(x => x.id === c.id)?.items))
    .map(c => ({ character_id: c.id, expected_version: c.version, items: c.items }));
  if ((changes.length || action) && !table.worldInventoryAvailable) throw Error('Update the platform before committing state-linked messages or inventory');
  if (action && /^[.。][a-z]/i.test(action.text.trim())) throw Error('State-linked messages cannot execute dice commands');
  const pending = { id, before, after, windowId, at: table.now(), sourceSeqs: entries.filter(e => e.basis.kind === 'observed').map(e => e.basis.seq),
    inventoryRequest: changes.length ? { request_id: `world:${id}`, issued_at: table.now(), reason: entries.map(e => e.op.reason).join('\n').slice(0, 800), changes } : null,
    message: action ? { ...bodyFor(table, action), request_id: `world:${id}`, request_issued_at: table.now() } : null };
  strictSave(table, { ...before, pending });
  const published = await recoverWorldState(table);
  return Boolean(action && published);
}

function rememberMessage(table, message, windowId) {
  if (!message || message.recalled_at) return;
  table.botMessageIds.add(message.id); table.noteLine(message); table.lastPosted = message;
  if (table.botMessageIds.size > 2000) table.botMessageIds.delete(table.botMessageIds.values().next().value);
  table.noteArt?.(message);
  const cp = table.turnScope.getStore();
  if (cp?.running && !cp.posted.some(m => m.id === message.id)) {
    cp.posted.push({ id: message.id, seq: message.seq, kind: message.kind, windowId });
  }
}

const cancelled = (table, p) => table.generation.signal.aborted || table.turnScope.getStore()?.abort?.signal.aborted || p.sourceSeqs.some(seq => !table.sceneHistory(p.windowId).some(l => l.seq === seq));

export async function recoverWorldState(table) {
  const p = table.worldState.pending;
  if (!p) return;
  try {
    p.phase = p.phase ?? 'prepared';
    let receipt;
    // Look up a prior message before considering a retry or cancellation.
    if (p.message) receipt = await table.api.agentMessage(table.channelId, p.message.request_id);
    const stop = cancelled(table, p) || receipt?.cancelled || receipt?.message?.recalled_at;
    if (stop && p.message && !receipt?.cancelled) receipt = await table.api.cancelAgentMessage(table.channelId, p.message.request_id);
    const published = receipt?.message && !receipt.message.recalled_at;
    if (p.inventoryRequest && !p.inventoryResult) {
      // Replaying the exact intent also resolves a response lost after server commit.
      p.phase = 'inventory'; table.persist(table);
      p.inventoryResult = await table.api.updateInventory(table.channelId, p.inventoryRequest);
      table.persist(table);
      rememberInventory(table, p.inventoryResult.characters);
    }
    if (stop && !published) {
      if (p.inventoryResult) {
        p.undoRequest ??= { request_id: `world-undo:${p.id}`, issued_at: table.now(), reason: 'Cancelled unpublished story state',
          changes: p.inventoryResult.characters.map(c => ({ character_id: c.id, expected_version: c.version, items: c.before_items })) };
        table.persist(table);
        const undo = await table.api.updateInventory(table.channelId, p.undoRequest);
        rememberInventory(table, undo.characters);
      }
      strictSave(table, { ...p.before, pending: null });
      return;
    }
    if (p.message && !published) {
      // If pausing raced the inventory response, cancel under the server's message lock before proceeding.
      if (cancelled(table,p)) return recoverWorldState(table);
      p.phase = 'message'; table.persist(table);
      receipt = { message: await table.api.postMessage(table.channelId, p.windowId, p.message) };
    }
    if (p.message) rememberMessage(table, receipt.message, p.windowId);
    const cp = table.turnScope.getStore();
    if (cp?.running && p.inventoryResult) (cp.worldInventory ??= []).push(p.inventoryResult);
    strictSave(table, { ...p.after, pending: null });
    return receipt?.message ?? true;
  } catch (e) {
    // A definite version conflict before any remote write can safely discard the uncommitted draft.
    if (e.status === 409 && e.code !== 'inventory_request_expired' && !p.inventoryResult && p.phase === 'inventory') {
      if (p.message) await table.api.cancelAgentMessage(table.channelId, p.message.request_id);
      strictSave(table, { ...p.before, pending: null });
    }
    else { p.error = e.message; table.persist(table); }
    throw e;
  }
}

export async function runWorldAction(table, windowId, entries, action, run) {
  if (!entries?.length) return run();
  if (table.generation.signal.aborted) return 0;
  const posted = await commitWorldGroup(table, windowId, entries, action);
  if (table.worldState.pending) throw Error('World state commit remains pending');
  await table.sleep(table.cfg.postDelayMs);
  return posted ? 1 : 0;
}

export function markWorldCut(table, windowId) {
  if (!table.improv.on) return;
  (table.worldState.sceneEpoch ??= {})[windowId] = (table.worldState.sceneEpoch?.[windowId] ?? 0) + 1;
}

export async function undoWorldCheckpoint(table, cp) {
  const receipts = cp.worldInventory ?? [];
  const merged = new Map();
  for (const r of receipts) for (const c of r.characters) {
    const prev = merged.get(c.id);
    merged.set(c.id, { ...c, before_items: prev?.before_items ?? c.before_items, beforeVersion: prev?.beforeVersion ?? c.version - 1 });
  }
  if (merged.size) {
    const changes = [...merged.values()].map(c => ({ character_id: c.id, expected_version: table.worldUndoVersions?.get(c.id)?.from === c.version ? table.worldUndoVersions.get(c.id).to : c.version, items: c.before_items }));
    cp.worldUndoRequest ??= { request_id: `recall:${crypto.randomUUID()}`, issued_at: table.now(), reason: 'Recall of the story turn', changes };
    // Keep an unresolved compensation durable if the process stops during the request.
    table.worldState.recallPending = { request: cp.worldUndoRequest, before: JSON.parse(cp.before.world) };
    table.persist(table);
    const result = await table.api.updateInventory(table.channelId, cp.worldUndoRequest);
    rememberInventory(table, result.characters);
    table.worldUndoVersions ??= new Map();
    for (const c of result.characters) table.worldUndoVersions.set(c.id, { from: merged.get(c.id).beforeVersion, to: c.version });
  }
  strictSave(table, { ...JSON.parse(cp.before.world), pending: null });
}

export async function recoverWorldRecall(table) {
  const p = table.worldState.recallPending;
  if (!p) return;
  try {
    const result = await table.api.updateInventory(table.channelId, p.request);
    rememberInventory(table, result.characters);
    strictSave(table, p.before);
  } catch (e) {
    if (e.status === 409 && e.code !== 'inventory_request_expired') { delete table.worldState.recallPending; table.persist(table); table.log('World state recall conflicted with a newer inventory edit; keeping current state.'); }
    else throw e;
  }
}

export { WORLD_TOOL_RULES };
