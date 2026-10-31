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

// One card: the sender's picture, the window and the time on top, then who wrote and two lines of what.
function Card({ n, onClick }: { n: MessageNotice; onClick: () => void }) {
  const m = n.message;
  const sender = m.kind === 'system' ? tr('System') : m.character_name ?? m.author_name;
  const body = m.dice?.text ? `${m.content}\n${m.dice.text}` : m.content;
  return (
    <div className="notice-card" onClick={onClick}>
      {n.avatar ? <img className="notice-icon" src={n.avatar} alt="" /> : <div className="notice-icon">{(sender || '?').slice(0, 1).toUpperCase()}</div>}
      <div className="notice-main">
        <div className="notice-head"><span className="notice-title">{n.windowName}</span><span className="notice-time">{tr('now')}</span></div>
        <div className="notice-body"><b>{sender}</b>: {body}</div>
      </div>
    </div>
  );
}

// The banners of one window, stacked like macOS: the newest on top, up to two edges of older ones peeking out below.
// A click on a stack opens it into a list; a click on a single banner (or on one in the list) opens that message.
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
    <div className={`notice ${leaving ? 'leaving' : ''} ${expanded ? 'expanded' : ''} ${many && !expanded ? `stacked depth-${Math.min(2, notices.length - 1)}` : ''}`}
      role="status" tabIndex={0} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onKeyDown={(e) => { if (e.key === 'Escape') close(e); if (e.key === 'Enter' && !expanded) (many ? setExpanded(true) : open(top)); }}
      aria-label={many ? tr('{n} messages in {window}', { n: notices.length, window: top.windowName }) : undefined}>
      {!expanded && <button className="notice-close" aria-label={tr('Close')} onClick={close}>×</button>}
      {expanded ? (
        <>
          <div className="notice-group-head"><span className="name">{top.windowName}</span>
            <button onClick={(e) => { e.stopPropagation(); setExpanded(false); }}>{tr('Show less')}</button>
            <button aria-label={tr('Close')} title={tr('Close')} onClick={close}>×</button></div>
          {notices.map((n) => (
            <div key={n.id} className="notice-item">
              <Card n={n} onClick={() => open(n)} />
              <button className="notice-close" aria-label={tr('Close')} onClick={(e) => { e.stopPropagation(); dismiss(n.id); }}>×</button>
            </div>
          ))}
        </>
      ) : (
        <div key={top.id} className="notice-top"><Card n={top} onClick={() => (many ? setExpanded(true) : open(top))} /></div>
      )}
      {many && !expanded && <><div className="notice-peek peek-1" />{notices.length > 2 && <div className="notice-peek peek-2" />}</>}
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
