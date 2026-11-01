// Open Log Studio's AI tasks: composing or continuing a visual novel, painting the art it asks for, voicing its lines
// and painting character art. Tasks run outside the UI, so they keep going when the user leaves the panel or the
// project, and their results go into the project (and to disk) as each piece finishes.
//
// Several tasks may run at once (voicing while the standees are painted, art for several characters), but every AI
// request of every task takes a slot in one pool: at most `parallel` requests (AI services) are in flight, and the
// rest wait in order. A task never queues more than `parallel` requests at a time, so a long task cannot push a new
// one to the back of a long line.
//
// What may run together, per project: one script task (compose or continue) at a time, and none while art for the
// script or voice lines are being made (they work on the script it replaces or extends). The same task (the same
// voicing, the same character slot) never runs twice at once.
import { create } from 'zustand';
import type { LlmCall } from './types';
import { getProject, holdProject, openProject, updateProject } from './projects';
import { loadAiSettings } from './providers/settings';
import { makeLlm } from './providers/providers';
import { appendScript, composeContinuation, composeScript } from './vn';
import {
  applyBackground, applyCharacterArt, applyVoice, makeBackground, makeCharacterArt, makeVoice, needLabel, openNeeds, slotName, voiceJobs, type ArtSlot,
} from './actions';

export type TaskKind = 'compose' | 'continue' | 'paint' | 'voice' | 'art';
export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';
export interface StudioTask {
  id: string;
  key: string;                 // what it works on: two tasks with the same key never run at once
  projectId: string;
  projectTitle: string;
  kind: TaskKind;
  subject: string;             // for art: "<character> · <slot>"
  status: TaskStatus;
  done: number;
  total: number;
  failures: string[];          // pieces that could not be made (the task goes on without them)
  error: string;               // why the task stopped
  result: string;              // a short summary when done
  started: number;
  finished: number | null;
}
interface TasksState { tasks: StudioTask[]; active: number; waiting: number }
export const useTasks = create<TasksState>(() => ({ tasks: [], active: 0, waiting: 0 }));

// Told when a task ends (the app shows a toast); set by the UI.
export const taskEvents: { finished: (t: StudioTask) => void } = { finished: () => undefined };

// ---- the request pool -------------------------------------------------------------------------------------
export const pool = { limit: (): number => loadAiSettings().parallel };
interface Waiter { resolve: () => void; reject: (e: Error) => void; signal: AbortSignal; onAbort: () => void }
let active = 0;
const queue: Waiter[] = [];
const syncPool = () => useTasks.setState({ active, waiting: queue.length });

function abortError(): Error { const e = new Error('cancelled'); e.name = 'AbortError'; return e; }
function acquire(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (active < pool.limit()) { active++; syncPool(); return Promise.resolve(); }
  return new Promise<void>((resolve, reject) => {
    const w: Waiter = { resolve, reject, signal, onAbort: () => { const i = queue.indexOf(w); if (i >= 0) queue.splice(i, 1); syncPool(); reject(abortError()); } };
    signal.addEventListener('abort', w.onAbort, { once: true });
    queue.push(w);
    syncPool();
  });
}
function pump() {
  while (active < pool.limit() && queue.length) {
    const w = queue.shift()!;
    w.signal.removeEventListener('abort', w.onAbort);
    active++;
    w.resolve();
  }
  syncPool();
}
/** Runs one AI request in a pool slot, waiting for one when all are busy. */
export async function inSlot<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  await acquire(signal);
  try { return await fn(); } finally { active--; pump(); }
}
/** A changed limit (AI services) applies at once to the requests waiting. */
export function poolLimitChanged() { pump(); }

/** Works through items with at most `limit` of them waiting for or holding a slot. */
export async function eachInPool<T>(items: T[], signal: AbortSignal, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runner = async () => { while (next < items.length && !signal.aborted) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(pool.limit(), items.length) }, runner));
}

// ---- tasks --------------------------------------------------------------------------------------------------
const SCRIPT: TaskKind[] = ['compose', 'continue'];
const FOR_SCRIPT: TaskKind[] = ['paint', 'voice'];
export type Conflict = 'same' | 'script-running' | 'script-in-use';

/** Why a task cannot start now (null: it can). */
export function conflictFor(projectId: string, kind: TaskKind, key: string): Conflict | null {
  const running = useTasks.getState().tasks.filter((t) => t.status === 'running' && t.projectId === projectId);
  if (running.some((t) => t.key === key)) return 'same';
  if ((SCRIPT.includes(kind) || FOR_SCRIPT.includes(kind)) && running.some((t) => SCRIPT.includes(t.kind))) return 'script-running';
  if (SCRIPT.includes(kind) && running.some((t) => FOR_SCRIPT.includes(t.kind))) return 'script-in-use';
  return null;
}
export function isRunning(key: string): boolean { return useTasks.getState().tasks.some((t) => t.status === 'running' && t.key === key); }

export interface TaskContext {
  signal: AbortSignal;
  projectId: string;
  inSlot: <T>(fn: () => Promise<T>) => Promise<T>;
  update: (fn: Parameters<typeof updateProject>[1]) => void;
  progress: (done: number, total: number) => void;
  step: () => void;              // one more piece done
  fail: (what: string) => void;  // one piece could not be made
}

const controllers = new Map<string, AbortController>();
const KEEP_FINISHED = 20;
let counter = 0;
function patch(id: string, p: Partial<StudioTask>) {
  useTasks.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...p } : t)) }));
}
function current(id: string): StudioTask | undefined { return useTasks.getState().tasks.find((t) => t.id === id); }

/** Starts a task, or throws an Error whose message is the Conflict when it cannot run now. */
export function startTask(spec: { projectId: string; kind: TaskKind; key: string; subject?: string; total?: number; run: (ctx: TaskContext) => Promise<string | void> }): StudioTask {
  const conflict = conflictFor(spec.projectId, spec.kind, spec.key);
  if (conflict) throw new Error(conflict);
  const id = `t${Date.now().toString(36)}${(counter++).toString(36)}`;
  const task: StudioTask = {
    id, key: spec.key, projectId: spec.projectId, projectTitle: getProject(spec.projectId)?.title ?? '', kind: spec.kind, subject: spec.subject ?? '',
    status: 'running', done: 0, total: spec.total ?? 0, failures: [], error: '', result: '', started: Date.now(), finished: null,
  };
  useTasks.setState((s) => ({ tasks: [...s.tasks, task] }));
  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  const release = holdProject(spec.projectId);
  const ctx: TaskContext = {
    signal: ctrl.signal,
    projectId: spec.projectId,
    inSlot: (fn) => inSlot(ctrl.signal, fn),
    update: (fn) => { updateProject(spec.projectId, fn); },
    progress: (done, total) => patch(id, { done, total }),
    step: () => patch(id, { done: (current(id)?.done ?? 0) + 1 }),
    fail: (what) => patch(id, { failures: [...(current(id)?.failures ?? []), what] }),
  };
  void (async () => {
    let end: Partial<StudioTask>;
    try {
      await openProject(spec.projectId);
      const result = await spec.run(ctx);
      end = ctrl.signal.aborted ? { status: 'cancelled' } : { status: 'done', result: result ?? '' };
    } catch (e: any) {
      end = ctrl.signal.aborted || e?.name === 'AbortError' ? { status: 'cancelled' } : { status: 'failed', error: String(e?.message ?? e) };
    } finally {
      controllers.delete(id);
      release();
    }
    patch(id, { ...end, finished: Date.now() });
    // Keep the newest finished tasks for the task list; running ones always stay.
    useTasks.setState((s) => {
      const finished = s.tasks.filter((t) => t.status !== 'running');
      const drop = new Set(finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)).map((t) => t.id));
      return drop.size ? { tasks: s.tasks.filter((t) => !drop.has(t.id)) } : s;
    });
    const done = current(id);
    if (done) taskEvents.finished(done);
  })();
  return task;
}

export function cancelTask(id: string) { controllers.get(id)?.abort(); }
export function cancelProjectTasks(projectId: string) {
  for (const t of useTasks.getState().tasks) if (t.projectId === projectId && t.status === 'running') cancelTask(t.id);
}
export function dismissTask(id: string) { useTasks.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id || t.status === 'running') })); }
export function clearFinishedTasks() { useTasks.setState((s) => ({ tasks: s.tasks.filter((t) => t.status === 'running') })); }

const errorText = (e: any) => String(e?.message ?? e);
const pooledLlm = (llm: LlmCall | null, ctx: TaskContext): LlmCall | null =>
  llm && ((req) => ctx.inSlot(() => llm({ ...req, signal: ctx.signal })));

// ---- the tasks the UI starts --------------------------------------------------------------------------------
export interface ScriptOptions { useModel: boolean; language: string; instructions: string }

/** Composes the visual novel from the whole log (replacing the script and its voice lines). */
export function startCompose(projectId: string, o: ScriptOptions): StudioTask {
  return startTask({ projectId, kind: 'compose', key: `compose:${projectId}`, run: async (ctx) => {
    const p = getProject(projectId)!;
    const ai = loadAiSettings();
    const backgrounds = (p.vn?.script.scenes ?? []).filter((s) => s.background).map((s) => ({ name: s.title, path: s.background! }));
    const script = await composeScript(p, { llm: pooledLlm(o.useModel ? makeLlm(ai.llm) : null, ctx), language: o.language, instructions: o.instructions, backgrounds, signal: ctx.signal, onProgress: ctx.progress });
    if (ctx.signal.aborted) return;
    ctx.update((d) => { d.vn = { script, template: d.vn?.template ?? {}, audio: {}, narrator_voice: d.vn?.narrator_voice ?? '', language: o.language, instructions: o.instructions, composed_at: new Date().toISOString() }; });
    return `${script.stats.scenes}/${script.stats.shown}`;
  } });
}

/** Writes the lines after the visual novel's end and appends them to the script as it is when the writing is done. */
export function startContinue(projectId: string, o: ScriptOptions): StudioTask {
  return startTask({ projectId, kind: 'continue', key: `compose:${projectId}`, run: async (ctx) => {
    const p = getProject(projectId)!;
    const ai = loadAiSettings();
    const { added, note, lines } = await composeContinuation(p, { llm: pooledLlm(o.useModel ? makeLlm(ai.llm) : null, ctx), language: o.language, instructions: o.instructions, signal: ctx.signal, onProgress: ctx.progress });
    if (ctx.signal.aborted) return;
    ctx.update((d) => {
      if (!d.vn) return;
      d.vn.script = appendScript(d.vn.script, added, note);
      d.vn.language = o.language; d.vn.instructions = o.instructions; d.vn.composed_at = new Date().toISOString();
    });
    return `${lines}/${added.scenes.length}`;
  } });
}

/** Paints the backgrounds and poses the script asks for, several at once. */
export function startPaint(projectId: string): StudioTask {
  return startTask({ projectId, kind: 'paint', key: `paint:${projectId}`, run: async (ctx) => {
    const ai = loadAiSettings();
    // A pose someone is already painting in Characters is not painted twice.
    const needs = openNeeds(getProject(projectId)!).filter((n) => n.kind === 'background' || !isRunning(artKey(projectId, n.character ?? '', { kind: 'pose', subtitle: n.subtitle || 'IDLE' })));
    ctx.progress(0, needs.length);
    await eachInPool(needs, ctx.signal, async (n) => {
      try {
        const p = getProject(projectId)!;
        if (n.kind === 'background') {
          const path = await ctx.inSlot(() => makeBackground(p, n, ai.image, ctx.signal));
          ctx.update((d) => applyBackground(d, n.scene_key, path));
        } else {
          const c = p.characters.find((x) => x.name === n.character);
          if (!c) throw new Error('the character is gone');
          const slot: ArtSlot = { kind: 'pose', subtitle: n.subtitle || 'IDLE' };
          const path = await ctx.inSlot(() => makeCharacterArt(p, c, slot, ai.image, ctx.signal));
          ctx.update((d) => applyCharacterArt(d, c.name, slot, path));
        }
        ctx.step();
      } catch (e: any) { if (!ctx.signal.aborted) { ctx.fail(`${needLabel(n)}: ${errorText(e)}`); ctx.step(); } }
    });
  } });
}

/** Voices every shown line that has no voice yet, several at once. */
export function startVoice(projectId: string): StudioTask {
  return startTask({ projectId, kind: 'voice', key: `voice:${projectId}`, run: async (ctx) => {
    const ai = loadAiSettings();
    const jobs = voiceJobs(getProject(projectId)!);
    ctx.progress(0, jobs.length);
    await eachInPool(jobs, ctx.signal, async (j) => {
      try {
        const v = await ctx.inSlot(() => makeVoice(getProject(projectId)!, j, ai.tts, ctx.signal));
        ctx.update((d) => applyVoice(d, j.seq, v));
        ctx.step();
      } catch (e: any) { if (!ctx.signal.aborted) { ctx.fail(`#${j.seq}: ${errorText(e)}`); ctx.step(); } }
    });
  } });
}

export const artKey = (projectId: string, character: string, slot: ArtSlot) => `art:${projectId}:${character}:${slotName(slot)}`;
/** Paints one image of a character: its avatar, main portrait or a pose. */
export function startCharacterArt(projectId: string, character: string, slot: ArtSlot): StudioTask {
  return startTask({ projectId, kind: 'art', key: artKey(projectId, character, slot), subject: `${character} · ${slotName(slot)}`, total: 1, run: async (ctx) => {
    const ai = loadAiSettings();
    const p = getProject(projectId)!;
    const c = p.characters.find((x) => x.name === character);
    if (!c) throw new Error('the character is gone');
    const path = await ctx.inSlot(() => makeCharacterArt(p, c, slot, ai.image, ctx.signal));
    ctx.update((d) => applyCharacterArt(d, character, slot, path));
    ctx.step();
  } });
}
