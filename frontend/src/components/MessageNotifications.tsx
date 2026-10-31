import { t as tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { useChat } from '../store/chat';
import { useNav } from '../store/nav';
import { useNotifications, type MessageNotice } from '../store/notifications';

const SHOW_MS = 6000;

// One banner: avatar, window and time on top, sender, two lines of the message. It stays while hovered; a click opens
// the window at that message.
function Notice({ n }: { n: MessageNotice }) {
  const dismiss = useNotifications((s) => s.dismiss);
  const [hover, setHover] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const left = useRef(SHOW_MS);
  useEffect(() => {
    if (hover) return;
    const started = Date.now();
    const timer = setTimeout(() => setLeaving(true), left.current);
    return () => { clearTimeout(timer); left.current = Math.max(1500, left.current - (Date.now() - started)); };
  }, [hover]);
  useEffect(() => { if (!leaving) return; const t = setTimeout(() => dismiss(n.id), 220); return () => clearTimeout(t); }, [leaving, dismiss, n.id]);
  const m = n.message;
  const sender = m.kind === 'system' ? tr('System') : m.character_name ?? m.author_name;
  const body = m.dice?.text ? `${m.content}\n${m.dice.text}` : m.content;
  const open = () => {
    const nav = useNav.getState();
    if (nav.channelId !== m.channel_id) return;
    nav.selectWindow(m.chat_window_id);
    setTimeout(() => useChat.getState().requestJump(m.id), 150);
    dismiss(n.id);
  };
  return (
    <div className={`notice ${leaving ? 'leaving' : ''}`} role="status" tabIndex={0} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); if (e.key === 'Escape') setLeaving(true); }}>
      <button className="notice-close" aria-label={tr('Close')} onClick={(e) => { e.stopPropagation(); setLeaving(true); }}>×</button>
      {n.avatar ? <img className="notice-icon" src={n.avatar} alt="" /> : <div className="notice-icon">{(sender || '?').slice(0, 1).toUpperCase()}</div>}
      <div className="notice-main">
        <div className="notice-head"><span className="notice-app">{n.windowName}</span><span className="notice-time">{tr('now')}</span></div>
        <div className="notice-title">{sender}</div>
        <div className="notice-body">{body}</div>
      </div>
    </div>
  );
}

export default function MessageNotifications() {
  const notices = useNotifications((s) => s.notices);
  const channelId = useNav((s) => s.channelId);
  const clear = useNotifications((s) => s.clear);
  useEffect(() => { clear(); }, [channelId, clear]);   // banners belong to the channel being viewed
  if (!notices.length) return null;
  return <div className="notices" aria-live="polite">{notices.map((n) => <Notice key={n.id} n={n} />)}</div>;
}
