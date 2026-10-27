import { t as tr, currentLocale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../store/auth';
import { api } from '../api/client';
import { useChat } from '../store/chat';
import { useNav } from '../store/nav';
import ChatReference from './ChatReference';
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
  const user = useAuth((s) => s.user);
  const references = useChat(s=>s.references);
  const addReference = useChat(s=>s.addReference);
  const own = user?.id === m.author_id;
  // The character's avatar first; the user's own avatar when the character has none.
  const avatar = m.character_avatar_asset_id ? api.mediaUrl(m.channel_id, m.character_avatar_asset_id, m.character_avatar_version ?? undefined) : own ? user.avatar_data : m.author_avatar_version ? api.avatarUrl(m.author_id, m.author_avatar_version) : '';
  const [failedAvatar, setFailedAvatar] = useState('');
  const author = own ? user.display_name : m.author_name;
  const name = m.character_name ?? (m.author_role === 'gm' ? `${author} (GM)` : author);
  return (
    <div className={`message ${m.kind} ${m.visibility}`} id={`msg-${m.id}`}>
      <div className={`avatar ${m.author_role}`}>{avatar && failedAvatar !== avatar ? <img src={avatar} alt="" onError={() => setFailedAvatar(avatar)} /> : (m.character_name ?? author).slice(0, 2).toUpperCase()}</div>
      <div>
        <div className="meta"><span className="author">{name}</span>
          {m.kind !== 'ic' && !m.dice && <span className="pill">{tr(m.kind)}</span>}
          {m.dice?.hidden && <span className="pill ai">{tr("hidden roll")}</span>}
          {m.visibility === 'gm_only' && <span className="pill gm">{tr("GM note")}</span>}
          {m.visibility === 'whisper' && <span className="pill ai">{tr("whisper")}</span>}
          <span className="tiny muted">{new Date(m.created_at).toLocaleTimeString(currentLocale())}</span>
          <button className="ghost small" onClick={()=>addReference(m)} disabled={references.length>=5 || references.some(r=>r.id===m.id)}>{tr('Quote as reference')}</button>
        </div>
        {m.reference_ids?.map(id=><ChatReference key={id} channelId={m.channel_id} messageId={id}/>)}
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
      {messages.length === 0 && <div className="muted small">{tr("No messages yet. The chronicler is listening.")}</div>}
      {messages.map((m) => <MessageRow key={m.id} m={m} jumped={jumped === m.id} />)}
    </div>
  );
}
