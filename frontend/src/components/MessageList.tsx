import { useEffect, useRef, useState } from 'react';
import { useChat } from '../store/chat';
import { useNav } from '../store/nav';
import type { Message } from '../types';

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

function MessageRow({ m, jumped }: { m: Message; jumped: boolean }) {
  const name = m.character_name ?? (m.author_role === 'gm' ? `${m.author_name} (GM)` : m.author_name);
  return (
    <div className={`message ${m.kind} ${m.visibility}`} id={`msg-${m.id}`}>
      <div className={`avatar ${m.author_role}`}>{(m.character_name ?? m.author_name).slice(0, 2).toUpperCase()}</div>
      <div>
        <div className="meta"><span className="author">{name}</span>
          {m.kind !== 'ic' && !m.dice && <span className="pill">{m.kind}</span>}
          {m.dice?.hidden && <span className="pill ai">hidden roll</span>}
          {m.visibility === 'gm_only' && <span className="pill gm">GM note</span>}
          {m.visibility === 'whisper' && <span className="pill ai">whisper</span>}
          <span className="tiny muted">{new Date(m.created_at).toLocaleTimeString()}</span>
        </div>
        {m.dice?.type === 'hidden_notice' ? <div className="dice-result notice">🎲 {m.dice.text}</div>
          : m.dice ? (<>
            <div className={`content dice-command ${jumped ? 'jumped' : ''}`}>{m.content}</div>
            <div className={`dice-result ${diceTone(m)}`}>🎲 {m.dice.text}</div>
          </>) : <div className={`content ${jumped ? 'jumped' : ''}`}>{m.content}</div>}
      </div>
    </div>
  );
}

export default function MessageList() {
  const { channelId, windowId } = useNav();
  const messages = useChat((s) => (windowId ? s.byWindow[windowId] : undefined)) ?? [];
  const jumpTo = useChat((s) => s.jumpTo);
  const loadOlder = useChat((s) => s.loadOlder);
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [jumped, setJumped] = useState<string | null>(null);
  useEffect(() => { if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [messages.length, stick, windowId]);
  useEffect(() => {
    if (!jumpTo) return;
    const el = document.getElementById(`msg-${jumpTo.messageId}`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('jumped'); setJumped(jumpTo.messageId); setTimeout(() => { el.classList.remove('jumped'); setJumped(null); }, 2500); }
  }, [jumpTo]);
  const onScroll = () => { const el = ref.current; if (!el) return; setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40); if (el.scrollTop < 20 && channelId && windowId) loadOlder(channelId, windowId); };
  return (
    <div className="message-list" ref={ref} onScroll={onScroll}>
      {messages.length === 0 && <div className="muted small">No messages yet. The chronicler is listening.</div>}
      {messages.map((m) => <MessageRow key={m.id} m={m} jumped={jumped === m.id} />)}
    </div>
  );
}
