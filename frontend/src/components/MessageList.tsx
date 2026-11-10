import { t as tr, currentLocale } from '../i18n';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../store/auth';
import { api } from '../api/client';
import { useChat, recallDeadline } from '../store/chat';
import { useNav } from '../store/nav';
import { useReminders } from '../store/reminders';
import { useUi } from '../store/ui';
import ChatReference from './ChatReference';
import type { Message } from '../types';
import { CachedImg } from './CachedImg';
import { isDesktop } from '../lib/platform';

// Colour a check by its (last) outcome so successes and failures read at a glance.
function diceTone(m: Message): string {
  const rolls = (m.dice?.rolls as { level?: string; success?: boolean }[] | undefined) ?? [];
  const last = rolls[rolls.length - 1];
  const level = (last?.level ?? (m.dice?.level as string | undefined)) || '';
  if (level === 'critical') return 'crit';
  if (level === 'fumble') return 'fumble';
  if (last?.success === true || m.dice?.success === true) return 'ok';
  if (last?.success === false || m.dice?.success === false) return 'fail';
  return '';
}

// True while the author may still recall the line; re-renders when that time runs out.
function useRecallable(m: Message, own: boolean) {
  const deadline = own ? recallDeadline(m) : null;
  const [, expire] = useState(0);
  useEffect(() => {
    if (!deadline || deadline <= Date.now()) return;
    const t = setTimeout(() => expire((n) => n + 1), deadline - Date.now() + 50);
    return () => clearTimeout(t);
  }, [deadline]);
  return deadline !== null && deadline > Date.now();
}

// readOnly: a spectator's view — no quoting and no references into a channel the reader cannot open.
export function MessageRow({ m, jumped, readOnly }: { m: Message; jumped: boolean; readOnly?: boolean }) {
  const user = useAuth((s) => s.user);
  const references = useChat(s=>s.references);
  const addReference = useChat(s=>s.addReference);
  const recall = useChat(s=>s.recall);
  const draft = useChat(s=>s.recallDrafts[m.id]);
  const own = user?.id === m.author_id;
  const recallable = useRecallable(m, own && !readOnly);
  // A pinned line sits in the group's context bubbles; its pinner (or the GM) can take it down again.
  const pin = useReminders((s) => s.list.find((r) => r.kind === 'pinned' && r.pinned_message_id === m.id));
  const pinLine = useReminders((s) => s.pin), unpinLine = useReminders((s) => s.unpin);
  const isGm = useNav((s) => s.channel?.my_role === 'gm');
  const meId = useAuth((s) => s.user?.id);
  const toast = useUi((s) => s.toast);
  // Out of character the player speaks: their own avatar and name. Otherwise the character's avatar first, the
  // player's when the character has none.
  const ooc = m.kind === 'ooc';
  const avatar = !ooc && m.character_avatar_asset_id ? api.mediaUrl(m.channel_id, m.character_avatar_asset_id, m.character_avatar_version ?? undefined) : own ? api.ownAvatarUrl(user) : m.author_avatar_version ? api.avatarUrl(m.author_id, m.author_avatar_version) : '';
  // The picture's content hash (lib/assetCache): the signed-in user's inline data-URI avatar needs none.
  const avatarHash = !ooc && m.character_avatar_asset_id ? m.character_avatar_hash : own ? (user.avatar_data ? null : user.avatar_hash) : m.author_avatar_hash;
  const [failedAvatar, setFailedAvatar] = useState('');
  const author = own ? user.display_name : m.author_name;
  const speaker = ooc ? null : m.character_name;
  const name = speaker ?? (m.author_role === 'gm' ? `${author} (GM)` : author);
  if (m.recalled_at) {
    const reedit = () => { useUi.getState().insertIntoComposer(draft!); useChat.setState((s) => { const rest = { ...s.recallDrafts }; delete rest[m.id]; return { recallDrafts: rest }; }); };
    return (
      <div className="message recalled" id={`msg-${m.id}`}>
        <span>{own ? tr('You recalled a message') : tr('{name} recalled a message', { name })}</span>
        {own && draft && !readOnly && <button className="ghost small" onClick={reedit}>{tr('Re-edit')}</button>}
      </div>
    );
  }
  return (
    <div className={`message ${m.kind} ${m.visibility}`} id={`msg-${m.id}`}>
      <div className={`avatar ${m.author_role}`}>{avatar && failedAvatar !== avatar ? <CachedImg src={avatar} hash={avatarHash} alt="" onError={() => setFailedAvatar(avatar)} /> : (speaker ?? author).slice(0, 2).toUpperCase()}</div>
      <div>
        <div className="meta"><span className="author">{name}</span>
          {m.kind !== 'ic' && !m.dice && <span className="pill">{tr(m.kind)}</span>}
          {m.dice?.hidden && <span className="pill ai">{tr("hidden roll")}</span>}
          {m.visibility === 'gm_only' && <span className="pill gm">{tr("GM note")}</span>}
          {m.visibility === 'whisper' && <span className="pill ai">{tr("whisper")}</span>}
          <span className="tiny muted">{new Date(m.created_at).toLocaleTimeString(currentLocale())}</span>
          {!readOnly && <button className="ghost small" onClick={()=>addReference(m)} disabled={references.length>=5 || references.some(r=>r.id===m.id)}>{tr('Quote as reference')}</button>}
          {!readOnly && m.kind !== 'system' && (pin
            ? ((pin.pinned_by === meId || isGm) && <button className="ghost small" onClick={() => unpinLine(m.channel_id, pin.id).catch((e: any) => toast(e.message, 'error'))} title={tr('Remove this line from the context bubbles')}>{tr('Unpin')}</button>)
            : <button className="ghost small" onClick={() => pinLine(m.channel_id, m.id).then(() => toast(tr('Pinned to the context bubbles'))).catch((e: any) => toast(e.message, 'error'))} title={tr('Keep this line in the context bubbles for your group')}>{tr('Pin')}</button>)}
          {recallable && <button className="ghost small" onClick={()=>recall(m)} title={tr('Take this message back from everyone in this chat')}>{tr('Recall')}</button>}
        </div>
        {!readOnly && m.reference_ids?.map(id=><ChatReference key={id} channelId={m.channel_id} messageId={id}/>)}
        {m.dice?.type === 'hidden_notice' ? <div className="dice-result notice">🎲 {m.dice.text}</div>
          : m.dice ? (<>
            <div className={`content dice-command ${jumped ? 'jumped' : ''}`}>{m.content}</div>
            <div className={`dice-result ${diceTone(m)}`}>🎲 {m.dice.text}</div>
          </>) : m.media_asset_id ? <Illustration m={m} jumped={jumped} />
          : <div className={`content ${jumped ? 'jumped' : ''}`}>{m.content}</div>}
      </div>
    </div>
  );
}

// A line's picture, drawn on request or uploaded by its author: the picture (loaded through its line) and, when it
// has one, the description or caption under it.
function Illustration({ m, jumped }: { m: Message; jumped: boolean }) {
  const [failed, setFailed] = useState(false);
  const url = api.messageImageUrl(m.channel_id, m.id);
  const caption = m.content.replace(/^\u{1F5BC}\u{FE0F}?\s*/u, '');
  return (
    <figure className={`message-illustration ${jumped ? 'jumped' : ''}`}>
      {failed ? <div className="muted small">{tr('The picture could not be loaded.')}</div>
        : <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={caption || tr('Picture')} loading="lazy" onError={() => setFailed(true)} /></a>}
      {caption && <figcaption className="content">{caption}</figcaption>}
      {!failed && <div className="row"><DownloadPicture m={m} /></div>}
    </figure>
  );
}

// Save the picture as a file: the desktop app asks where (its own "Save as"); a browser downloads it, the server
// naming the file.
function DownloadPicture({ m }: { m: Message }) {
  const toast = useUi((s) => s.toast);
  const href = api.messageImageDownloadUrl(m.channel_id, m.id);
  const save = async (e: React.MouseEvent) => {
    if (!isDesktop) return;
    e.preventDefault();
    try {
      const { downloadToFile } = await import('../lib/desktop');
      const path = await downloadToFile(href);
      if (path) toast(tr('Saved to {path}', { path }));
    } catch (err: any) { toast(String(err?.message ?? err), 'error'); }
  };
  return <a className="button ghost small" href={href} download onClick={save}>{tr('Download')}</a>;
}

// Where each window was left in this visit: at its newest line, or up in its history.
const scrolls = new Map<string, { stick: boolean; top: number }>();

export default function MessageList() {
  const { channelId, windowId, windows } = useNav();
  const messages = useChat((s) => (windowId ? s.byWindow[windowId] : undefined)) ?? [];
  // The window's first line is here: nothing older to fetch.
  const complete = useChat((s) => (windowId ? s.spans[windowId]?.complete : false)) ?? false;
  const jumpTo = useChat((s) => s.jumpTo);
  const loadOlder = useChat((s) => s.loadOlder);
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [jumped, setJumped] = useState<string | null>(null);
  const olderPending = useRef(false);
  const loadPrevious = async () => {
    const el = ref.current;
    if (!el || !channelId || !windowId || olderPending.current) return;
    olderPending.current = true;
    const height = el.scrollHeight, top = el.scrollTop;
    setStick(false);
    try {
      await loadOlder(channelId, windowId);
      requestAnimationFrame(() => {
        if (useNav.getState().windowId === windowId && ref.current === el) el.scrollTop = top + el.scrollHeight - height;
      });
    } finally { olderPending.current = false; }
  };
  // Switching back to a window returns to where it was left.
  useLayoutEffect(() => {
    const el = ref.current; if (!el || !windowId) return;
    const left = scrolls.get(windowId);
    if (left && !left.stick) { setStick(false); el.scrollTop = left.top; }
    else { setStick(true); el.scrollTop = el.scrollHeight; }
  }, [windowId]);
  useEffect(() => { if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [messages.length, stick, windowId]);
  // A picture that finishes loading after its line arrived makes the line taller: stay at the newest line. (`load`
  // does not bubble, so it is caught on the way down.)
  const sticking = useRef(true); sticking.current = stick;
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const settle = () => { if (sticking.current) el.scrollTop = el.scrollHeight; };
    el.addEventListener('load', settle, true);
    return () => el.removeEventListener('load', settle, true);
  }, [windowId]);
  useEffect(() => {
    if (!jumpTo) return;
    const el = document.getElementById(`msg-${jumpTo.messageId}`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('jumped'); setJumped(jumpTo.messageId); setTimeout(() => { el.classList.remove('jumped'); setJumped(null); }, 2500); }
  }, [jumpTo]);
  const onScroll = () => {
    const el = ref.current; if (!el) return;
    const atNewest = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setStick(atNewest);
    if (windowId) scrolls.set(windowId, { stick: atNewest, top: el.scrollTop });
    if (el.scrollTop < 20 && !complete) void loadPrevious();
  };
  return (
    <div className="message-list" ref={ref} onScroll={onScroll}>
      {messages.length > 0 && !complete && <button className="ghost small" onClick={loadPrevious}>{tr('Load earlier messages')}</button>}
      {messages.length === 0 && <div className="muted small">{tr("No messages yet. The chronicler is listening.")}</div>}
      {messages.map((m, i) => <Fragment key={m.id}>
        {(i === 0 || messages[i - 1].chat_window_id !== m.chat_window_id) && (m.chat_window_id !== windowId || i > 0 && messages[i - 1].chat_window_id !== windowId) &&
          <div className="section small muted">{m.chat_window_id === windowId ? tr('Current scene') : tr('Earlier history from {name}', { name: windows.find(w => w.id === m.chat_window_id)?.name ?? tr('Previous scene') })}</div>}
        <MessageRow m={m} jumped={jumped === m.id} />
      </Fragment>)}
    </div>
  );
}
