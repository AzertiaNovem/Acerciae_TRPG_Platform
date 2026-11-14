import { t as tr } from '../i18n';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Message } from '../types';
import type { Action, ChoiceNode, Doc, InputNode, Lock, LockReason, Node, Resolved, StateDecl, Viewer } from '../hypertext/types';
import { parseDoc } from '../hypertext/format';
import { resolve } from '../hypertext/bindings';
import { engineAvailable } from '../hypertext/client';
import { cpLength } from '../hypertext/text';
import { shownState, useHypertext } from '../store/hypertext';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';

// An interactive message (kind 'hypertext', docs/HYPERTEXT.md), drawn natively from its public document and this
// viewer's state: plain text only (card strings are isolated, <bdi> or dir="auto", so they cannot turn the frame or the
// provenance pill around), native controls whose ids and radio names are namespaced by message and node. The row
// around it (MessageList) keeps the sender, the avatar and the "Interactive message" pill. Everything a viewer does goes
// through store/hypertext; the script engine starts only for a control with an `on` handler. Spectators get the card
// read-only, from the document alone: no status, no state, no engine.

/** A translated sentence whose {placeholders} are user or card text, each isolated in its own <bdi>. */
export function Isolated({ text, values }: { text: string; values: Record<string, ReactNode> }) {
  const parts = tr(text).split(/\{(\w+)\}/);
  return <>{parts.map((p, i) => (i % 2 ? <bdi key={i}>{values[p] ?? `{${p}}`}</bdi> : <Fragment key={i}>{p}</Fragment>))}</>;
}

/** The message's body: the card, or its plain text with a hint when this app cannot read the card. */
export function HypertextBody({ m, readOnly, jumped }: { m: Message; readOnly?: boolean; jumped?: boolean }) {
  const doc = useMemo(() => parseDoc(m.hypertext), [m.hypertext]);
  if (!doc) return (<>
    <div className={`content ${jumped ? 'jumped' : ''}`}>{m.content}</div>
    <div className="tiny muted hx-update">{tr('Update the app to use this message.')}</div>
  </>);
  return <HypertextCard m={m} doc={doc} readOnly={readOnly} jumped={jumped} />;
}

// Why the controls are disabled: the card's own lock reasons (hypertext/types.ts), plus what the app knows: the viewer
// is not in the window, the server has no interactive messages (an older one) or has them turned off.
type Reason = LockReason | 'member' | 'missing' | 'disabled';
const REASONS: Record<Exclude<Reason, null>, string> = {
  closed: 'This message is closed.',
  recalled: 'This message was recalled.',
  not_actor: 'This message is for other characters.',
  spectator: 'Spectators cannot use interactive messages.',
  history: 'This message belongs to an earlier chat window.',
  archived: 'This window is archived.',
  paused: 'Your participation in this window is paused.',
  loading: 'Loading…',
  member: 'Join this chat window to use this message.',
  missing: 'This server does not support interactive messages yet.',
  disabled: 'Interactive messages are turned off on this server.',
};
const toLock = (r: Reason): Lock => ({ reason: r === 'member' ? 'not_actor' : r === 'missing' || r === 'disabled' ? 'closed' : r });
const hasOn = (n: Node) => !!(n as { on?: string }).on;
const postsSomething = (n: Node) => n.type === 'button' && !!n.act && (n.act.say !== undefined || n.act.reply !== undefined);

export default function HypertextCard({ m, doc, readOnly, jumped }: { m: Message; doc: Doc; readOnly?: boolean; jumped?: boolean }) {
  const entry = useHypertext((s) => (readOnly ? undefined : s.cards[m.id]));
  const unavailable = useHypertext((s) => (readOnly ? null : s.unavailable));
  const interact = useHypertext((s) => s.interact);
  const answer = useHypertext((s) => s.answer);
  const closeCard = useHypertext((s) => s.close);
  const windowId = useNav((s) => s.windowId);
  const win = useNav((s) => s.windows.find((w) => w.id === m.chat_window_id));
  const isGm = useNav((s) => s.channel?.my_role === 'gm');
  const characters = useNav((s) => s.characters);
  const diceOn = useNav((s) => s.serverSettings?.features?.dice !== false);
  const me = useAuth((s) => s.user);
  const toast = useUi((s) => s.toast);
  // The character the composer speaks as in this card's window ("Speak as"; MessageComposer).
  const speakAs = useUi((s) => (m.chat_window_id ? s.speakAs[m.chat_window_id] : undefined)) ?? '';
  const [closing, setClosing] = useState(false);

  // Who may act: GMs, and the actors by their character in the card's window (as the server checks).
  const member = win?.members?.find((x) => x.user_id === me?.id);
  const characterId = member?.character_id ?? null;
  const actor = isGm || !doc.actors?.length || (!!characterId && doc.actors.some((a) => a.toLowerCase() === characterId.toLowerCase()));
  // A line as the viewer is posted as the composer's character: the one picked under "Speak as", else the window's,
  // else (not cast in the window) their first own character, as the composer does.
  const sayCharacter = speakAs || characterId || characters.find((c) => c.user_id === me?.id)?.id || '';
  const sayCharacterName = sayCharacter ? characters.find((c) => c.id === sayCharacter)?.name ?? (sayCharacter === characterId ? member?.character_name : null) ?? null : null;
  // The viewer as a script sees them (no ids, no token): GM or not, allowed to act, the name they speak as here.
  const viewer: Viewer = { gm: isGm, actor, character: sayCharacterName };

  // Closed by a GM, or at closes_at (re-drawn when that time comes while the card is on screen).
  const closesAt = entry?.closesAt ?? doc.closes_at;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const left = closesAt ? Date.parse(closesAt) - Date.now() : NaN;
    if (!(left > 0) || left > 2 ** 31 - 1) return;
    const t = setTimeout(() => setNow(Date.now()), left + 50);
    return () => clearTimeout(t);
  }, [closesAt]);
  const closed = !!entry?.closedAt || !!entry?.closed || !!entry?.gone || (!!closesAt && Date.parse(closesAt) <= now);

  const reason: Reason = readOnly ? 'spectator'
    : m.recalled_at ? 'recalled'
    : m.chat_window_id !== windowId ? 'history'
    : unavailable ? unavailable
    : closed ? 'closed'
    : win?.archived_at ? 'archived'
    : !isGm && member?.visibility_paused ? 'paused'
    : !isGm && !member ? 'member'
    : !actor ? 'not_actor'
    : !entry?.loaded ? 'loading'
    : null;
  const lock = toLock(reason);
  const state = useMemo(() => shownState(doc, entry), [doc, entry?.draft, entry?.state]);
  const resolved = useMemo(() => new Map<Node, Resolved>(resolve(doc, state, lock).map((r) => [r.node, r])), [doc, state, lock.reason]);
  const engineOk = engineAvailable();
  // While an action is under way the controls only look and act disabled (aria-disabled; the store refuses meanwhile):
  // a natively disabled control would drop the keyboard focus.
  const busy = !!entry?.pending || !!entry?.confirm;
  const spent = entry?.runsLeft === 0;
  // Whether any control runs the script, and whether any can post (an act that says or replies, or a handler).
  const [scriptControls, posting] = useMemo(() => {
    let on = false, posts = false;
    const walk = (ns: Node[]) => ns.forEach((x) => { if (hasOn(x)) on = true; if (postsSomething(x)) posts = true; if (x.type === 'row' || x.type === 'group') walk(x.children); });
    walk(doc.body);
    return [on, on || posts];
  }, [doc]);

  const fire = (nodeId: string, action: Action) => {
    if (readOnly || reason || busy) return;
    void interact({ message: m, doc, lock, viewer, engine: engineOk, dice: diceOn, sayCharacterId: sayCharacter && sayCharacter !== characterId ? sayCharacter : null }, nodeId, action);
  };
  const close = async () => {
    if (!m.channel_id || closing) return;
    setClosing(true);
    try { await closeCard(m.channel_id, m.id); } catch (e: any) { toast(e?.message ?? String(e), 'error'); } finally { setClosing(false); }
  };

  const base = `hx-${m.id}`;
  const render = (n: Node, key: string | number): ReactNode => {
    const r = resolved.get(n);
    if (!r || !r.visible) return null;
    const dom = n.id ? `${base}-${n.id}` : undefined;
    // `off`: locked (natively disabled); `wait`: an action is under way (aria-disabled, the focus stays).
    const off = r.disabled || (hasOn(n) && !engineOk) || (spent && postsSomething(n));
    const wait = !off && busy;
    switch (n.type) {
      case 'text': {
        const cls = `hx-text hx-style-${n.style} hx-tone-${n.tone}`;
        return n.style === 'heading' ? <h4 key={key} id={dom} className={cls}><bdi>{r.text}</bdi></h4> : <div key={key} id={dom} className={cls}><bdi>{r.text}</bdi></div>;
      }
      case 'divider': return <hr key={key} className="hx-divider" />;
      case 'row': return <div key={key} id={dom} className="hx-row">{n.children.map((c, i) => render(c, c.id ?? i))}</div>;
      case 'group': return (
        <fieldset key={key} id={dom} className="hx-group">
          {r.label !== undefined && <legend className="hx-legend"><bdi>{r.label}</bdi></legend>}
          {n.children.map((c, i) => render(c, c.id ?? i))}
        </fieldset>);
      case 'checkbox': return (
        <label key={key} className={`hx-check ${off || wait ? 'hx-off' : ''}`}>
          <input type="checkbox" id={dom} checked={r.value === true} disabled={off} aria-disabled={wait || undefined} onChange={() => fire(n.id, { type: 'toggle' })} />
          <bdi>{r.label}</bdi>
        </label>);
      case 'choice': return <Choice key={key} node={n} r={r} decl={doc.state[n.bind]} dom={dom!} off={off} wait={wait} fire={fire} />;
      case 'input': return <Input key={key} node={n} r={r} decl={doc.state[n.bind]} dom={dom!} off={off} wait={wait} fire={fire} />;
      case 'button': return (
        <span key={key} className="hx-action">
          <button type="button" id={dom} className={`hx-button ${n.style === 'secondary' ? '' : n.style}`} disabled={off} aria-disabled={wait || undefined} onClick={() => fire(n.id, { type: 'click' })}>
            <bdi>{r.label}</bdi>
          </button>
          {/* An out-of-character line is posted under the account's name, not the character's: the caption says so. */}
          {r.caption !== undefined && <span className="hx-caption">{tr(n.act?.say_kind === 'ooc' ? 'Posts (out of character):' : 'Posts:')} <bdi className="hx-caption-text">{r.caption}</bdi></span>}
        </span>);
    }
  };

  const failure = entry?.failure, logs = entry?.logs ?? [];
  const confirm = entry?.confirm;
  // In character, the line speaks as the character; out of character, under the viewer's own (account) name.
  const ooc = confirm?.kind === 'ooc';
  const asWho = (ooc ? null : sayCharacterName) ?? (me?.display_name ?? '');
  const runsShown = !reason && posting && doc.runs_per_viewer > 1 && !!entry?.runsLeft;
  const spentShown = !reason && posting && spent;

  // The confirmation takes the focus (and comes into view) when the viewer was on this card; the control they used
  // gets it back afterwards.
  const cardRef = useRef<HTMLDivElement>(null), postRef = useRef<HTMLButtonElement>(null), returnTo = useRef<HTMLElement | null>(null);
  const asking = !!confirm;
  useEffect(() => {
    const card = cardRef.current, active = document.activeElement;
    const here = !active || active === document.body || !!card?.contains(active);
    if (asking) {
      if (!here) return;
      returnTo.current = active instanceof HTMLElement && card?.contains(active) ? active : null;
      postRef.current?.scrollIntoView?.({ block: 'nearest' });
      postRef.current?.focus({ preventScroll: true });
    } else if (returnTo.current) {
      const el = returnTo.current; returnTo.current = null;
      if (here && el.isConnected && !(el as HTMLButtonElement).disabled) el.focus({ preventScroll: true });
    }
  }, [asking]);
  // What a screen reader hears of the outcome: always in the page, so a change is announced.
  const announced = [...(entry?.notices ?? []), entry?.error ? tr(entry.error) : ''].filter(Boolean).join(' ');
  return (
    <div ref={cardRef} className={`hx-card ${reason ? 'hx-locked' : ''} ${jumped ? 'jumped' : ''}`} aria-busy={busy || undefined}>
      {doc.title && <div className="hx-title"><bdi>{doc.title}</bdi></div>}
      <div className="hx-body">{doc.body.map((n, i) => render(n, n.id ?? i))}</div>
      {!readOnly && <div className="hx-sr" role="status" aria-live="polite">{announced}</div>}
      {!!entry?.notices.length && <ul className="hx-notices">{entry.notices.map((x, i) => <li key={i}><bdi>{x}</bdi></li>)}</ul>}
      {confirm && (
        <div className="hx-confirm" role="group" aria-label={tr('Confirm')}>
          <div className="hx-confirm-text" id={`${base}-confirm-text`}>
            <Isolated text={ooc ? 'Post as {name} (out of character): {text}' : 'Post as {name}: {text}'} values={{ name: asWho, text: <span className="hx-confirm-line">{confirm.text}</span> }} />
          </div>
          {confirm.sheet && <div className="hx-hint" id={`${base}-confirm-hint`}>{tr('This changes your character sheet.')}</div>}
          <div className="hx-confirm-actions">
            <button type="button" ref={postRef} className="primary small" aria-describedby={`${base}-confirm-text${confirm.sheet ? ` ${base}-confirm-hint` : ''}`} onClick={() => answer(m.id, true)}>{tr('Post')}</button>
            <button type="button" className="ghost small" onClick={() => answer(m.id, false)}>{tr('Cancel')}</button>
          </div>
        </div>
      )}
      {entry?.error && <div className="hx-error">{tr(entry.error)}</div>}
      {isGm && !readOnly && (failure || logs.length > 0) && (
        <details className="hx-details" open={!!failure}>
          <summary>{tr('Script details')} <span className="hx-gm-only">{tr('GM only')}</span></summary>
          {failure && <div className="hx-details-error"><code>{failure.code}</code> <bdi>{failure.message}</bdi>{failure.line ? <> · {tr('Line {n}', { n: failure.line })}</> : null}</div>}
          {logs.length > 0 && <ol className="hx-logs">{logs.map((l, i) => <li key={i}><bdi>{l}</bdi></li>)}</ol>}
        </details>
      )}
      {(reason || (scriptControls && !engineOk) || runsShown || spentShown || busy || (isGm && !readOnly)) && (
        <div className="hx-footer">
          {reason && <span className="hx-reason">{tr(REASONS[reason])}</span>}
          {!reason && scriptControls && !engineOk && <span className="hx-reason">{tr('Interactive actions are unavailable on this device.')}</span>}
          {!reason && entry?.pending && !confirm && <span className="hx-reason">{tr('Working…')}</span>}
          {runsShown && <span className="hx-reason">{tr('Uses left: {n}', { n: entry!.runsLeft! })}</span>}
          {spentShown && <span className="hx-reason">{tr('You already used this.')}</span>}
          <span className="grow" />
          {isGm && !readOnly && !closed && reason !== 'history' && !unavailable && entry?.loaded && (
            <button type="button" className="ghost small" disabled={closing} onClick={close} title={tr('Stop everyone from using this message')}>{tr('Close')}</button>
          )}
        </div>
      )}
    </div>
  );
}

type Fire = (nodeId: string, action: Action) => void;

// A choice: native radios or checkboxes in a fieldset (list; also a set shown as a menu, which a single <select> cannot
// hold), a button group (buttons), or a <select> (menu). A choice that runs the script (`on`) never runs it for a
// keyboard user just moving through its options: arrow keys move the focus among radios (Space or Enter picks one),
// and a menu shows the option the keys reach and picks it on Enter or when the focus leaves.
function Choice({ node, r, decl, dom, off, wait, fire }: { node: ChoiceNode; r: Resolved; decl: StateDecl; dom: string; off: boolean; wait: boolean; fire: Fire }) {
  const options = r.options ?? [];
  const multi = decl.type === 'set';
  const scripted = hasOn(node);
  // Set by a key press until the change it causes (within the same task) has been seen.
  const keyed = useRef(false);
  const press = (on: boolean) => { if (!on) return; keyed.current = true; setTimeout(() => { keyed.current = false; }, 0); };
  const [shown, setShown] = useState<string | null>(null);   // a menu option reached by keys, not picked yet
  const pick = (value: string) => fire(node.id, { type: 'select', value });
  if (node.display === 'buttons') return (
    <div className="hx-choice" role="group" aria-labelledby={r.label !== undefined ? `${dom}-label` : undefined}>
      {r.label !== undefined && <div id={`${dom}-label`} className="hx-label"><bdi>{r.label}</bdi></div>}
      <div className="hx-segmented">
        {options.map((o, i) => (
          <button key={o.value} type="button" id={`${dom}-${i}`} className={`hx-option ${o.selected ? 'hx-on' : ''}`} aria-pressed={o.selected} disabled={off || o.disabled} aria-disabled={wait || undefined}
            onClick={() => pick(o.value)}><bdi>{o.label}</bdi></button>
        ))}
      </div>
    </div>);
  if (node.display === 'menu' && !multi) {
    const commit = () => { if (shown !== null) { const v = shown; setShown(null); if (v !== r.value) pick(v); } };
    return (
      <div className="hx-choice">
        {r.label !== undefined && <label htmlFor={dom} className="hx-label"><bdi>{r.label}</bdi></label>}
        <select id={dom} className="hx-select" dir="auto" value={shown ?? (typeof r.value === 'string' ? r.value : '')} disabled={off} aria-disabled={wait || undefined}
          onKeyDown={(e) => { if (e.key === 'Enter') { if (shown !== null) { e.preventDefault(); commit(); } } else press(scripted && e.key !== 'Tab'); }}
          onBlur={commit}
          onChange={(e) => { if (keyed.current) setShown(e.target.value); else { setShown(null); pick(e.target.value); } }}>
          {r.value === null && <option value="" disabled>{tr('Choose…')}</option>}
          {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled} dir="auto">{o.label}</option>)}
        </select>
      </div>);
  }
  return (
    <fieldset className="hx-choice hx-list" disabled={off}>
      {r.label !== undefined && <legend className="hx-label"><bdi>{r.label}</bdi></legend>}
      {options.map((o, i) => (
        <label key={o.value} className={`hx-check ${off || wait || o.disabled ? 'hx-off' : ''}`}>
          <input type={multi ? 'checkbox' : 'radio'} id={`${dom}-${i}`} name={dom} value={o.value} checked={o.selected} disabled={off || o.disabled} aria-disabled={wait || undefined}
            onKeyDown={(e) => {
              if (!multi && e.key === 'Enter') { e.preventDefault(); if (!o.selected) pick(o.value); }
              else press(scripted && !multi && /^Arrow/.test(e.key));
            }}
            // A radio the arrow keys reached stays unpicked (the controlled value puts the picked one back).
            onChange={() => { if (!keyed.current) pick(o.value); }} />
          <bdi>{o.label}</bdi>
        </label>
      ))}
    </fieldset>);
}

// A text input. What is typed stays here until it is committed (on blur: saved, no handler runs) or submitted (the
// button, or Enter outside an IME composition: its handler runs).
function Input({ node, r, decl, dom, off, wait, fire }: { node: InputNode; r: Resolved; decl: StateDecl; dom: string; off: boolean; wait: boolean; fire: Fire }) {
  const value = typeof r.value === 'string' ? r.value : '';
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const max = decl.type === 'text' ? decl.max : 0;
  const tooLong = cpLength(draft) > max;
  const submit = () => { if (!off && !tooLong) fire(node.id, { type: 'submit', value: draft }); };
  return (
    <div className="hx-input">
      {r.label !== undefined && <label htmlFor={dom} className="hx-label"><bdi>{r.label}</bdi></label>}
      <div className="hx-input-row">
        <input id={dom} type="text" dir="auto" autoComplete="off" value={draft} placeholder={node.placeholder} disabled={off} readOnly={wait} aria-disabled={wait || undefined} aria-invalid={tooLong || undefined}
          onFocus={() => { focused.current = true; }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { focused.current = false; if (!off && !tooLong && draft !== value) fire(node.id, { type: 'commit', value: draft }); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } }} />
        {/* Pressing the button keeps the focus in the field: one submit, no commit before it. */}
        <button type="button" className="small" disabled={off || tooLong} aria-disabled={wait || undefined} onMouseDown={(e) => e.preventDefault()} onClick={submit}>
          {node.submit_label !== undefined ? <bdi>{node.submit_label}</bdi> : tr('Send')}
        </button>
      </div>
      {tooLong && <div className="hx-hint hx-bad">{tr('At most {n} characters.', { n: max })}</div>}
      <div className="hx-hint">{tr('Anything you type here may be shared in the chat.')}</div>
    </div>);
}
