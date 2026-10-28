import { t as tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { chatSocket } from '../api/ws';
import { useNav } from '../store/nav';
import { MessageRow } from './MessageList';
import type { Message, SpectateView } from '../types';

// Read-only Main Chat of a channel the user was not invited to (when the server allows spectators): only lines the
// whole window sees, no composer, no workspace.
export default function SpectatorView({ channelId }: { channelId: string }) {
  const openSpectate = useNav((s) => s.openSpectate);
  const [view, setView] = useState<SpectateView | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    let active = true;
    setView(null); setError(''); setMore(true); stick.current = true;
    api.spectate(channelId).then((v) => { if (active) { setView(v); setMore(v.messages.length >= 80); } }).catch((e) => active && setError(e.message));
    const off = chatSocket.on((m) => {
      if (m.type !== 'spectate.message' || m.channel_id !== channelId) return;
      setView((v) => (v && !v.messages.some((x) => x.id === m.message.id) ? { ...v, messages: [...v.messages, m.message as Message] } : v));
    });
    return () => { active = false; off(); };
  }, [channelId]);
  useEffect(() => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [view?.messages.length]);
  const older = async () => {
    const first = view?.messages[0]; if (!first || !more) return;
    const page = await api.spectate(channelId, first.seq).catch(() => null);
    if (!page) return;
    setMore(page.messages.length >= 80);
    setView((v) => (v ? { ...v, messages: [...page.messages.filter((m) => !v.messages.some((x) => x.id === m.id)), ...v.messages] } : v));
  };
  const onScroll = () => { const el = ref.current; if (!el) return; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
  return (
    <>
      <div className="chat-header">
        <h2>{view?.channel.name ?? '…'}</h2>
        <span className="pill">{view?.window?.name ?? tr("Main Chat")}</span>
        <span className="pill">{tr("Read-only")}</span>
        <span className="grow" />
        <button className="ghost small" onClick={() => openSpectate(null)}>{tr("Close")}</button>
      </div>
      <div className="chat-body">
        <div className="message-list" ref={ref} onScroll={onScroll}>
          {error && <div className="muted small">{error}</div>}
          {view && more && view.messages.length > 0 && <button className="ghost small" onClick={older}>{tr("Load earlier messages")}</button>}
          {view && view.messages.length === 0 && <div className="muted small">{tr("Nothing has been said in the Main Chat yet.")}</div>}
          {view?.messages.map((m) => <MessageRow key={m.id} m={m} jumped={false} readOnly />)}
        </div>
      </div>
      <div className="tiny muted" style={{ padding: '8px 16px' }}>{tr("You are reading this channel's Main Chat as a spectator. Only lines everyone at the table can see are shown; ask its GM to invite you to take part.")}</div>
    </>
  );
}
