import { MAIN } from './timelines.mjs';

// T0 remains the primary story, but after a split it is no longer played in the public lobby.
// Project the complete plan before writing anything, so the stayers receive a private fork too.
export function sceneForks(timelines, ops, { windowOf }) {
  if (ops.some(o => o.op === 'fork_main' || o.op === 'bind_main' || o.primary)) return ops;
  const positions = new Map(timelines.active().flatMap(t => t.members.map(id => [id, t.id])));
  for (const [i, o] of ops.entries()) {
    if (o.op === 'move') for (const id of o.ids) positions.set(id, o.to);
    if (o.op === 'split') {
      for (const id of o.ids) positions.set(id, `new:${i}`);
      if (o.replaces) for (const [id, t] of positions) if (t === o.replaces) positions.set(id, `new:${i}`);
    }
    if (o.op === 'merge') for (const [id, t] of positions) if (t === o.from) positions.set(id, o.into);
  }
  const ids = [...positions].filter(([, t]) => t === MAIN).map(([id]) => id);
  if (!ids.length) return ops;
  const main = timelines.main();
  const wasSplit = timelines.active().some(t => t.id !== MAIN && t.members.length);
  const splits = [...positions.values()].some(t => t !== MAIN);
  if (!main.windowId && (wasSplit || splits)) {
    // On reunion, inherit the destination's history, still filtered per reader by the platform.
    const joined = ops.find(o => o.op === 'merge' && o.into === MAIN && timelines.get(o.from)?.members.length);
    const source = joined ? timelines.get(joined.from) : main;
    const relocation = ops.find(o => o.op === 'relocate' && o.timeline === MAIN);
    return [...ops, { op: 'fork_main', ids, parentWindowId: windowOf(source),
      place: relocation?.location || main.location || main.name, time: relocation?.narrativeTime || main.narrativeTime }];
  }
  return ops;
}
