import { create } from 'zustand';
import { api } from '../api/client';
import { useChat } from './chat';
import { sessionEpoch, isStale } from './session';
import type { HypertextActBody, Message } from '../types';
import type { Action, Confirm, Doc, Effect, EngineError, Lock, State, Viewer } from '../hypertext/types';
import { act as declarativeAct, applyAction, overlay } from '../hypertext/bindings';
import { checkEffects } from '../hypertext/effects';
import { findNode } from '../hypertext/format';
import { hypertextEngine } from '../hypertext/client';

// Interactive messages (kind 'hypertext') of the open channel: each card's status for this viewer (closed or not,
// their own state and its version, the runs left), what is shown before the server has it (a draft), and the action
// pipeline every client follows (docs/HYPERTEXT.md, "What a viewer's app does"):
// - a control with no handler and no act changes the state, saved by a debounced PUT (coalesced per card);
// - a button's declarative act gives the new state and its effects: /act, or a PUT when nothing is posted;
// - an `on` handler runs the card's script in the engine (hypertext/client.ts), whose validated output is shown at
//   once (state and notices); a line that needs the viewer's confirmation waits for it (cancel reverts and sends
//   nothing); then /act, or a PUT when nothing is posted.
// Each action has its own interaction id, reused by every retry of it: a network failure or a 5xx is tried again up
// to 3 times with a growing pause, then the action reverts. 428 asks the viewer and sends the same action again with
// `confirmed`; 409 adopts the server's state (from the error, or by fetching the status again); 404/405 from these
// routes (an older server) and 403 feature_disabled mark the feature unavailable. One action per card is under way at
// a time on this client, and saves and actions of a card go one after the other, so each starts from the version the
// last one left. Spectators never come here: their cards are drawn read-only from the document.

export type Unavailable = null | 'missing' | 'disabled';
export interface CardEntry {
  channelId: string;
  loaded: boolean;             // the status arrived; controls stay disabled ("Loading…") until then
  stale: boolean;              // to be fetched again
  fetching: boolean;
  gone: boolean;               // left out of the status: recalled or no longer readable
  closesAt: string | null;
  closedAt: string | null;
  closed: boolean;             // closed when the status was read (closed_at set, or closes_at passed)
  state: Record<string, unknown> | null;   // the server's copy of this viewer's state (null before their first save)
  version: number;
  runsLeft: number | null;
  draft: State | null;         // shown instead of the server's copy until it is saved, adopted or reverted
  pending: boolean;            // an action of this card is under way on this client
  error: string | null;        // one short sentence for the viewer: a catalog key, or the server's own words
  failure: EngineError | null; // the last script failure (its details are shown to GMs only)
  logs: string[];              // the last run's log() output (GMs only)
  notices: string[];           // the last run's notify() notes, for this viewer only, never sent
  confirm: Confirm | null;     // a line waiting for the viewer's confirmation
}
/** What an interaction needs from the card as it is drawn. The script gets `viewer` only: never a token or an id.
 *  `sayCharacterId`: the character the composer speaks as, when it is not the viewer's character in the card's window
 *  (a player with several PCs, or none in the window); a line as the viewer is posted as that one. `dice: false`: the
 *  server's dice are off, so a dot command posts as plain text and every line from a script is free text. */
export interface InteractContext {
  message: Pick<Message, 'id' | 'channel_id'>; doc: Doc; lock: Lock; viewer: Viewer; engine: boolean;
  sayCharacterId?: string | null; dice?: boolean;
}

/** Timings, in milliseconds (tests shorten them). */
export const HX_TIMING = { statusDebounceMs: 150, saveDebounceMs: 500, retryMs: [600, 1800, 4500], statusRetryMs: 5000 };

// The sentences shown for an outcome (each one is in the catalog).
export const HX_TEXT = {
  failed: "This message's action failed.",
  unsent: "This message's action could not be sent. Check your connection.",
  unsaved: 'Your change could not be saved.',
  partial: 'Part of this action could not be posted.',
  noEngine: 'Interactive actions are unavailable on this device.',
} as const;
const ERRORS: Record<string, string> = {
  hypertext_closed: 'This message is closed.',
  runs_exhausted: 'You already used this.',
  reply_exhausted: 'This answer is no longer available.',
  rate_limited: 'Too many actions. Try again in a moment.',
  not_an_actor: 'This message is for other characters.',
  hypertext_command_not_allowed: 'This message cannot post that command for you.',
  sender_unavailable: "This message's sender can no longer answer.",
  state_conflict: 'This message changed on another device.',
  interaction_in_progress: 'An action on this message is still being posted. Try again in a moment.',
  feature_disabled: 'Interactive messages are turned off on this server.',
};
/** The sentence for a refusal: a known code in the catalog's words, else the server's message. */
export const errorText = (e: any): string => ERRORS[e?.code] ?? (typeof e?.message === 'string' && e.message ? e.message : HX_TEXT.failed);

export type Outcome = 'retry' | 'missing' | 'disabled' | 'gone' | 'confirm' | 'conflict' | 'refetch' | 'fail';
/** What to do about a failed request to a card route. No status: the network (or a timeout, 408) — try again, as for
 *  a 5xx or an action still being posted under the same id. A 404 that is not the API's own answer, or a 405: the route
 *  is not there (an older server). */
export function classify(e: any): Outcome {
  const status = typeof e?.status === 'number' ? e.status : 0;
  if (!status || status === 408 || status >= 500) return 'retry';
  if (status === 405 || (status === 404 && e.apiResponse === false)) return 'missing';
  if (status === 403 && e.code === 'feature_disabled') return 'disabled';
  if (status === 404) return 'gone';
  if (status === 428) return 'confirm';
  if (status === 409) return e.code === 'interaction_in_progress' ? 'retry' : e.code === 'state_conflict' ? 'conflict' : 'refetch';
  return 'fail';
}

/** Whether two states hold the same values (key order aside; sets are kept in schema order on both sides). */
export function sameState(a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean {
  if (!a || !b) return a === b;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && (Array.isArray(a[k])
    ? Array.isArray(b[k]) && (a[k] as unknown[]).length === (b[k] as unknown[]).length && (a[k] as unknown[]).every((x, i) => x === (b[k] as unknown[])[i])
    : a[k] === b[k]));
}
/** The state a card is drawn with: the draft, else the server's copy over the defaults. */
export const shownState = (doc: Doc, e: Pick<CardEntry, 'draft' | 'state'> | undefined): State => e?.draft ?? overlay(doc, e?.state ?? null);

/** A UUID for one action (crypto.randomUUID needs a secure context; a LAN address over http has none). */
export function newInteractionId(): string {
  const c: Crypto | undefined = (globalThis as any).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** The /act request for the effects of one action; the say as `characterId` when given (else the server takes the
 *  viewer's character in the card's window). */
export function actBody(interactionId: string, node: string, effects: Effect[], state: State, baseVersion: number, confirmed = false, characterId?: string | null): HypertextActBody {
  const body: HypertextActBody = { interaction_id: interactionId, node, base_version: baseVersion, state };
  for (const e of effects) {
    if (e.type === 'say') body.say = { text: e.text, kind: e.kind, ...(characterId ? { character_id: characterId } : {}), ...(confirmed ? { confirmed: true } : {}) };
    else body.reply = { id: e.id, slots: { ...e.slots } };
  }
  return body;
}
/** The confirmation a script's effects need before they are sent. With the server's dice off a dot command is plain
 *  text, so any say is confirmed (and changes no sheet). */
export function confirmOf(run: { effects: Effect[]; confirm: Confirm | null }, dice = true): Confirm | null {
  if (dice) return run.confirm;
  const say = run.effects.find((e) => e.type === 'say');
  return say && say.type === 'say' ? { text: say.text, kind: say.kind } : null;
}

const blank = (channelId: string): CardEntry => ({
  channelId, loaded: false, stale: false, fetching: false, gone: false, closesAt: null, closedAt: null, closed: false,
  state: null, version: 0, runsLeft: null, draft: null, pending: false, error: null, failure: null, logs: [], notices: [], confirm: null,
});

interface HypertextState {
  cards: Record<string, CardEntry>;
  unavailable: Unavailable;
  /** The cards loaded in the open window: their status is fetched for those not fetched yet (all, with `refresh`). */
  track: (channelId: string, ids: string[], refresh?: boolean) => void;
  /** The chat stream subscribed again: every tracked card's status is fetched again. */
  resync: () => void;
  /** Fetches these cards' status now. */
  refetch: (channelId: string, ids: string[]) => Promise<void>;
  /** hypertext.state (this viewer's other devices, or the echo of a save): applied when it is newer. */
  applyState: (id: string, state: Record<string, unknown> | null, version: number) => void;
  /** hypertext.closed. */
  applyClosed: (id: string, closedAt: string) => void;
  /** A UI action on one control of a card. Resolves when the action is over (after any confirmation). */
  interact: (ctx: InteractContext, nodeId: string, action: Action) => Promise<void>;
  /** The viewer's answer to a confirmation ("Post" or "Cancel"). */
  answer: (id: string, ok: boolean) => void;
  /** A GM closes a card for everyone. */
  close: (channelId: string, id: string) => Promise<void>;
  reset: () => void;
}

export const useHypertext = create<HypertextState>((set, get) => {
  let gen = 0, engineUsed = false;
  let wanted: { channelId: string; ids: string[] } | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // The state a PUT of the card is carrying right now, until it is answered.
  const inflight = new Map<string, State>();
  const lanes = new Map<string, Promise<void>>();
  const confirms = new Map<string, (ok: boolean) => void>();

  // Results that come back after a reset (logout, channel switch, a new session epoch) are dropped.
  const token = () => { const e = sessionEpoch(), g = gen; return () => !isStale(e) && g === gen; };
  const entry = (id: string): CardEntry | undefined => get().cards[id];
  const patch = (id: string, p: Partial<CardEntry>) => set((s) => (s.cards[id] ? { cards: { ...s.cards, [id]: { ...s.cards[id], ...p } } } : s));
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // Saves and actions of one card, one after the other.
  const lane = (id: string, job: () => Promise<void>): Promise<void> => {
    const run = (lanes.get(id) ?? Promise.resolve()).then(job).catch(() => undefined);
    lanes.set(id, run);
    void run.then(() => { if (lanes.get(id) === run) lanes.delete(id); });
    return run;
  };
  // The server's copy, when it is newer than the one held (or as new, for a status read again); a draft that now
  // equals it has nothing left to save.
  const adopt = (id: string, state: Record<string, unknown> | null, version: number, orEqual = false) => {
    const e = entry(id);
    if (!e || !(version > e.version || (orEqual && version === e.version))) return;
    patch(id, { state, version, ...(e.draft && sameState(e.draft, state) ? { draft: null } : {}) });
  };
  // The state shown from now on: a draft only while it differs from the server's copy. While a save is on its way the
  // draft always stays: a change back to the server's copy must still be saved over the one being sent (the next save
  // compares against what that one leaves).
  const setDraft = (id: string, doc: Doc, state: State) => {
    const e = entry(id);
    if (e) patch(id, { draft: !inflight.has(id) && sameState(state, overlay(doc, e.state)) ? null : state });
  };
  const clearTimer = (id: string) => { const t = saveTimers.get(id); if (t) { clearTimeout(t); saveTimers.delete(id); } };
  const markUnavailable = (u: Exclude<Unavailable, null>) => set((s) => ({ unavailable: s.unavailable === 'missing' ? 'missing' : u }));

  const scheduleSave = (id: string, now = false) => {
    clearTimer(id);
    saveTimers.set(id, setTimeout(() => { saveTimers.delete(id); void lane(id, save(id)); }, now ? 0 : HX_TIMING.saveDebounceMs));
  };
  // The draft, compare-and-swap on the version held. A newer draft made while this one was on its way is saved by its
  // own (later) timer, and again here when none is due: whatever the viewer left on screen is what gets stored.
  const save = (id: string) => async () => {
    const alive = token();
    for (let retries = 0; ;) {
      const e = entry(id);
      if (!e?.draft) return;
      const sent = e.draft;
      inflight.set(id, sent);
      try {
        const r = await api.hypertextSave(e.channelId, id, { state: sent, base_version: e.version });
        if (!alive()) return;
        inflight.delete(id);
        adopt(id, r.state, r.version);
        const after = entry(id);
        if (after?.draft && !after.pending && !saveTimers.has(id)) scheduleSave(id, true);
        return;
      } catch (err: any) {
        if (!alive()) return;
        const o = classify(err);
        // Tried again with the draft as it is then; meanwhile the state sent may have reached the server after all.
        if (o === 'retry' && retries < HX_TIMING.retryMs.length) { await sleep(HX_TIMING.retryMs[retries++]); if (!alive()) return; continue; }
        inflight.delete(id);
        if (o === 'missing' || o === 'disabled') { markUnavailable(o); patch(id, { draft: null }); return; }
        if (o === 'conflict') { adopt(id, err.data?.state ?? null, Number(err.data?.version) || 0); patch(id, { draft: null, error: ERRORS.state_conflict }); return; }
        patch(id, { draft: null, error: o === 'retry' ? HX_TEXT.unsaved : errorText(err) });
        if (o === 'refetch' || o === 'gone') void get().refetch(e.channelId, [id]);
        return;
      }
    }
  };

  // The viewer's confirmation of a line; false when they cancel, the card closes or the store is reset.
  const ask = (id: string, c: Confirm) => new Promise<boolean>((resolve) => {
    confirms.get(id)?.(false);
    patch(id, { confirm: c });
    confirms.set(id, (ok) => { confirms.delete(id); patch(id, { confirm: null }); resolve(ok); });
  });
  // An action that ends without effect: what was shown before it comes back (and is saved, if it was a draft).
  const revert = (id: string, prev: State | null, error: string | null) => {
    patch(id, { pending: false, draft: prev, confirm: null, error });
    if (prev) scheduleSave(id);
  };

  // /act with the same interaction id on every attempt.
  const send = (ctx: InteractContext, nodeId: string, effects: Effect[], state: State, prev: State | null, confirmed: boolean) => {
    const id = ctx.message.id, ch = ctx.message.channel_id, alive = token();
    clearTimer(id);   // the action carries the state: a save waiting for its timer is part of it
    return lane(id, async () => {
      if (!alive()) return;
      const body = actBody(newInteractionId(), nodeId, effects, state, entry(id)?.version ?? 0, confirmed, ctx.sayCharacterId);
      let asked = confirmed;
      for (let retries = 0; ;) {
        try {
          const res = await api.hypertextAct(ch, id, body);
          if (!alive()) return;
          // The lines it posted, as the viewer may read them (a GM-only reply is null): shown at once, de-duplicated
          // with their pushes by id.
          for (const r of res.results ?? []) if (r.message) useChat.getState().push(r.message);
          if (res.state) adopt(id, res.state.state, res.state.version);
          const e = entry(id);
          patch(id, { pending: false, draft: null, runsLeft: e?.runsLeft == null ? null : Math.max(0, e.runsLeft - 1), error: res.partial ? HX_TEXT.partial : null });
          return;
        } catch (err: any) {
          if (!alive()) return;
          const o = classify(err);
          if (o === 'retry' && retries < HX_TIMING.retryMs.length) { await sleep(HX_TIMING.retryMs[retries++]); if (!alive()) return; continue; }
          if (o === 'confirm' && !asked && body.say) {
            asked = true;
            // `sheet: false`: the line changes no sheet (the server's dice are off, so it is plain text).
            const ok = await ask(id, { text: typeof err.data?.text === 'string' ? err.data.text : body.say.text, kind: body.say.kind ?? 'ic', ...(err.data?.sheet === false ? {} : { sheet: true as const }) });
            if (!alive()) return;
            if (!ok) { revert(id, prev, null); return; }
            body.say = { ...body.say, confirmed: true };
            continue;
          }
          if (o === 'missing' || o === 'disabled') { markUnavailable(o); revert(id, prev, null); return; }
          if (o === 'conflict') {
            adopt(id, err.data?.state ?? null, Number(err.data?.version) || 0, true);
            patch(id, { pending: false, draft: null, confirm: null, error: ERRORS.state_conflict });
            return;
          }
          // Closed, used up, taken by someone else…: what was shown before the action comes back (a change made just
          // before it is saved on its own), and the status is read again.
          if (o === 'refetch') { revert(id, prev, errorText(err)); void get().refetch(ch, [id]); return; }
          if (o === 'gone') { revert(id, prev, errorText(err)); void get().refetch(ch, [id]); return; }
          revert(id, prev, o === 'retry' ? HX_TEXT.unsent : errorText(err));
          return;
        }
      }
    });
  };

  // ---- status ----
  const scheduleStatus = (ms = HX_TIMING.statusDebounceMs) => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusTimer = null; flushStatus(); }, ms);
  };
  const flushStatus = () => {
    if (!wanted) return;
    const s = get();
    const due = wanted.ids.filter((id) => { const e = s.cards[id]; return e && !e.fetching && (!e.loaded || e.stale); });
    if (due.length) void get().refetch(wanted.channelId, due);
  };

  return {
    cards: {}, unavailable: null,
    track: (channelId, ids, refresh = false) => {
      wanted = { channelId, ids: [...new Set(ids)] };
      set((s) => {
        const cards = { ...s.cards };
        for (const id of wanted!.ids) {
          const e = cards[id] && cards[id].channelId === channelId ? cards[id] : blank(channelId);
          cards[id] = refresh && e.loaded ? { ...e, stale: true } : e;
        }
        return { cards };
      });
      if (wanted.ids.length) scheduleStatus();
    },
    resync: () => { if (wanted) get().track(wanted.channelId, wanted.ids, true); },
    refetch: async (channelId, ids) => {
      ids = ids.filter((id) => entry(id));
      if (!ids.length) return;
      const alive = token();
      for (const id of ids) patch(id, { fetching: true, stale: false });
      // Known to be unavailable: there is nothing to wait for.
      if (get().unavailable) { for (const id of ids) patch(id, { fetching: false, loaded: true }); return; }
      try {
        const r = await api.hypertextStatus(channelId, ids);
        if (!alive()) return;
        if (!r.enabled) { markUnavailable('disabled'); for (const id of ids) patch(id, { fetching: false, loaded: true }); return; }
        const byId = new Map(r.items.map((x) => [x.message_id, x]));
        for (const id of ids) {
          const x = byId.get(id);
          if (!x) { patch(id, { fetching: false, loaded: true, gone: true }); continue; }
          patch(id, { fetching: false, loaded: true, gone: false, closesAt: x.closes_at, closedAt: x.closed_at, closed: !!x.closed, runsLeft: x.runs_left });
          adopt(id, x.state, Number(x.version) || 0, true);
        }
        // Cards marked stale while this was on its way are asked about again.
        if (wanted?.ids.some((id) => entry(id)?.stale)) scheduleStatus();
      } catch (err: any) {
        if (!alive()) return;
        const o = classify(err);
        if (o === 'missing' || o === 'gone' || o === 'disabled') { markUnavailable(o === 'disabled' ? 'disabled' : 'missing'); for (const id of ids) patch(id, { fetching: false, loaded: true }); return; }
        for (const id of ids) patch(id, { fetching: false, stale: true });
        scheduleStatus(HX_TIMING.statusRetryMs);   // the controls stay "Loading…" until it arrives
      }
    },
    applyState: (id, state, version) => adopt(id, state, Number(version) || 0),
    applyClosed: (id, closedAt) => { if (!entry(id)) return; patch(id, { closedAt }); confirms.get(id)?.(false); },

    interact: async (ctx, nodeId, action) => {
      const id = ctx.message.id, e = entry(id);
      if (!e || !e.loaded || e.pending || e.confirm || get().unavailable) return;
      const doc = ctx.doc, prev = e.draft, shown = shownState(doc, e);
      const r = applyAction(doc, shown, nodeId, action, ctx.lock);
      const node = r ? findNode(doc, nodeId) : null;
      if (!r || !node) return;
      const handler = (node as { on?: string }).on;
      patch(id, { error: null, notices: [], ...(handler ? { failure: null, logs: [] } : {}) });
      // An input's draft on blur, or a control with nothing to run: the state alone, saved shortly.
      if (!r.event || (!handler && !(node.type === 'button' && node.act))) { setDraft(id, doc, r.state); scheduleSave(id); return; }

      if (handler) {
        if (!ctx.engine) { patch(id, { error: HX_TEXT.noEngine }); return; }
        const alive = token();
        patch(id, { pending: true, draft: r.state });   // the control's own change shows while the script runs
        engineUsed = true;
        const run = await hypertextEngine().run(id, { doc, state: r.state, handler, event: r.event, viewer: ctx.viewer }, shown);
        if (!alive()) return;
        if (!run.ok) { patch(id, { pending: false, draft: prev, error: HX_TEXT.failed, failure: run.error, logs: run.logs ?? [] }); if (prev) scheduleSave(id); return; }
        // Lines this viewer can no longer post (the card's runs are used up): nothing to confirm or send.
        if (run.effects.length && entry(id)?.runsLeft === 0) { revert(id, prev, ERRORS.runs_exhausted); patch(id, { logs: run.logs }); return; }
        patch(id, { notices: run.notices, logs: run.logs, failure: null });
        setDraft(id, doc, run.state);
        if (!run.effects.length) { patch(id, { pending: false }); if (run.changed) scheduleSave(id, true); return; }
        let confirmed = false;
        const confirm = confirmOf(run, ctx.dice !== false);
        if (confirm) {
          const ok = await ask(id, confirm);
          if (!alive()) return;
          if (!ok) { revert(id, prev, null); patch(id, { notices: [] }); return; }
          confirmed = true;
        }
        await send(ctx, nodeId, run.effects, run.state, prev, confirmed);
        return;
      }

      // A declarative act: set, then say and reply, checked like a script's effects before anything is sent.
      const a = declarativeAct(doc, r.state, nodeId);
      if (!a) return;
      const fx = checkEffects(doc, a.effects);
      if ('error' in fx) { patch(id, { error: HX_TEXT.failed, failure: { code: 'invalid_effect', message: fx.error } }); return; }
      if (!fx.effects.length) { setDraft(id, doc, a.state); scheduleSave(id, true); return; }
      patch(id, { pending: true, draft: a.state });
      await send(ctx, nodeId, fx.effects, a.state, prev, false);
    },
    answer: (id, ok) => confirms.get(id)?.(ok),
    close: async (channelId, id) => {
      const alive = token();
      try {
        const r = await api.hypertextClose(channelId, id);
        if (alive()) { patch(id, { closedAt: r.closed_at, closesAt: r.closes_at }); confirms.get(id)?.(false); }
      } catch (err: any) {
        const o = classify(err);
        if (alive() && (o === 'missing' || o === 'disabled')) markUnavailable(o);
        throw err;
      }
    },
    reset: () => {
      gen++;
      for (const t of saveTimers.values()) clearTimeout(t);
      saveTimers.clear(); lanes.clear(); inflight.clear();
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      wanted = null;
      const waiting = [...confirms.values()]; confirms.clear();
      set({ cards: {}, unavailable: null });
      for (const r of waiting) r(false);
      // The engine's worker goes with the session (it is started again by the next script, if any).
      if (engineUsed) { engineUsed = false; hypertextEngine().dispose(); }
    },
  };
});
