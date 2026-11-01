import { t as tr } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '../store/chat';
import { useNav } from '../store/nav';
import { MAX_GROUPS, useNotifications, type MessageNotice } from '../store/notifications';

const SHOW_MS = 6000;

function openMessage(n: MessageNotice) {
  const nav = useNav.getState(), m = n.message;
  if (nav.channelId !== m.channel_id) return;
  nav.selectWindow(m.chat_window_id);
  setTimeout(() => useChat.getState().requestJump(m.id), 150);
}

const WINDOW_GLYPH: Record<string, string> = { main: '◎', group: '○', private: '◌' };

// One card, in the chat's own terms: the window (with its sidebar glyph) and the time, then the speaker as the chat
// names them — the character, or the player out of character, "(GM)" for the Keeper — and two lines of what was said.
function Card({ n, count, inList, onClick, onClose }: { n: MessageNotice; count?: number; inList?: boolean; onClick: () => void; onClose?: (e: React.SyntheticEvent) => void }) {
  const m = n.message;
  const kind = useNav((s) => s.windows.find((w) => w.id === m.chat_window_id)?.kind ?? 'group');
  const gm = m.author_role === 'gm';
  const speaker = m.kind === 'system' ? tr('System') : (m.kind === 'ooc' ? null : m.character_name) ?? (gm ? `${m.author_name} (GM)` : m.author_name);
  return (
    <div className={`notice-card ${gm ? 'gm' : ''}`} onClick={onClick}>
      <div className={`notice-icon ${gm ? 'gm' : ''}`}>{n.avatar ? <img src={n.avatar} alt="" /> : (speaker || '?').slice(0, 2).toUpperCase()}</div>
      <div className="notice-main">
        <div className="notice-head">
          {!inList && <><span className="notice-glyph" aria-hidden>{WINDOW_GLYPH[kind] ?? '○'}</span>
            <span className="notice-title">{n.windowName}</span></>}
          {count && count > 1 ? <span className="notice-count">{tr('{n} new', { n: count })}</span> : null}
          <span className="notice-time">{new Date(n.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          {onClose && <button className="notice-x" aria-label={tr('Close')} title={tr('Close')} onClick={onClose}>×</button>}
        </div>
        <div className="notice-speaker">{speaker}{m.kind !== 'ic' && m.kind !== 'system' && !m.dice && <span className="notice-kind">{tr(m.kind)}</span>}</div>
        {m.dice?.text ? <div className="notice-dice">🎲 {m.dice.text}</div> : <div className={`notice-body ${m.kind}`}>{m.content}</div>}
      </div>
    </div>
  );
}

// The banners of one window share one card: the newest message, with "n new" when more arrived. A click on such a card
// opens it into a list; a click on a single banner (or on one in the list) opens that message.
function Stack({ windowId, notices }: { windowId: string; notices: MessageNotice[] }) {
  const dismissWindow = useNotifications((s) => s.dismissWindow);
  const dismiss = useNotifications((s) => s.dismiss);
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const top = notices[0];
  const left = useRef(SHOW_MS);
  useEffect(() => { left.current = SHOW_MS; setLeaving(false); }, [top.id]);   // a new message restarts the clock
  useEffect(() => {
    if (hover || expanded) return;
    const started = Date.now();
    const timer = setTimeout(() => setLeaving(true), left.current);
    return () => { clearTimeout(timer); left.current = Math.max(1500, left.current - (Date.now() - started)); };
  }, [hover, expanded, top.id]);
  useEffect(() => { if (!leaving) return; const t = setTimeout(() => dismissWindow(windowId), 220); return () => clearTimeout(t); }, [leaving, dismissWindow, windowId]);
  const close = (e: React.SyntheticEvent) => { e.stopPropagation(); setLeaving(true); };
  const open = (n: MessageNotice) => { openMessage(n); dismissWindow(windowId); };
  const many = notices.length > 1;
  return (
    <div className={`notice ${leaving ? 'leaving' : ''} ${expanded ? 'expanded' : ''} ${hover ? 'paused' : ''}`}
      role="status" tabIndex={0} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onKeyDown={(e) => { if (e.key === 'Escape') close(e); if (e.key === 'Enter' && !expanded) (many ? setExpanded(true) : open(top)); }}
      aria-label={many ? tr('{n} messages in {window}', { n: notices.length, window: top.windowName }) : undefined}>
      {expanded ? (
        <>
          <div className="notice-group-head"><span className="name">{top.windowName}</span>
            <button onClick={(e) => { e.stopPropagation(); setExpanded(false); }}>{tr('Show less')}</button>
            <button aria-label={tr('Close')} title={tr('Close')} onClick={close}>×</button></div>
          {notices.map((n) => (
            <div key={n.id} className="notice-item">
              <Card n={n} inList onClick={() => open(n)} onClose={(e) => { e.stopPropagation(); dismiss(n.id); }} />
            </div>
          ))}
        </>
      ) : (
        <div key={top.id} className="notice-top" style={{ ['--notice-life' as string]: `${SHOW_MS}ms` }}>
          <Card n={top} count={notices.length} onClick={() => (many ? setExpanded(true) : open(top))} onClose={close} />
        </div>
      )}
    </div>
  );
}

export default function MessageNotifications() {
  const notices = useNotifications((s) => s.notices);
  const channelId = useNav((s) => s.channelId);
  const clear = useNotifications((s) => s.clear);
  useEffect(() => { clear(); }, [channelId, clear]);   // banners belong to the channel being viewed
  // One stack per window, the window with the newest message first.
  const groups = useMemo(() => {
    const byWindow = new Map<string, MessageNotice[]>();
    for (const n of notices) { const k = n.message.chat_window_id; byWindow.set(k, [...(byWindow.get(k) ?? []), n]); }
    return [...byWindow.entries()].slice(0, MAX_GROUPS);
  }, [notices]);
  if (!groups.length) return null;
  return <div className="notices" aria-live="polite">{groups.map(([w, list]) => <Stack key={w} windowId={w} notices={list} />)}</div>;
}
