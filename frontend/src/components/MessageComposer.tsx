import { t as tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { useUi } from '../store/ui';
import ConsistencyButton from './ConsistencyButton';
import InspirationButton from './InspirationButton';

const DICE_PREFIX = /^\s*[.。．](r|ra|rc|rh|rah|rch|sc|st|en)/i;

export default function MessageComposer() {
  const { channelId, windowId, channel, windows, characters, serverSettings } = useNav();
  const user = useAuth((s) => s.user);
  const { composerInsert, toast } = useUi();
  const { references, removeReference, clearReferences } = useChat();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'ic' | 'ooc' | 'narration'>('ic');
  const [visibility, setVisibility] = useState<'window' | 'gm_only' | 'whisper'>('window');
  const [whisperTo, setWhisperTo] = useState<string>('');
  const [characterId, setCharacterId] = useState<string>('');
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState<{ text: string; for: string } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const features = serverSettings?.features;
  const isGm = channel?.my_role === 'gm';
  const win = windows.find((w) => w.id === windowId);
  const myCharacters = characters.filter((c) => c.user_id === user?.id);
  const myWindowCharacter = win?.members?.find((m) => m.user_id === user?.id)?.character_id ?? myCharacters[0]?.id ?? '';
  const canPost = isGm || win?.members?.some(m=>m.user_id===user?.id);
  const activeCharacter = characterId || myWindowCharacter;

  useEffect(() => { if (composerInsert) { setText((t) => (t ? t + '\n' : '') + composerInsert.text); ta.current?.focus(); } }, [composerInsert]);
  useEffect(() => { setKind(isGm ? 'narration' : 'ic'); }, [isGm, windowId]);

  // Gray hint after a dice command (".ra research —— Alice's research is 53"); the server renders it with the
  // channel's dice texts and the speaking character's attributes, without rolling.
  const diceOn = features?.dice !== false;
  const isDice = diceOn && !text.includes('\n') && DICE_PREFIX.test(text);
  useEffect(() => {
    if (!isDice || !channelId || !windowId) { setHint(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api.dicePreview(channelId, { content: text, chat_window_id: windowId, character_id: activeCharacter || undefined })
        .then((r) => { if (live) setHint(r.hint ? { text: r.hint, for: text } : null); })
        .catch(() => { if (live) setHint(null); });
    }, 160);
    return () => { live = false; clearTimeout(t); };
  }, [text, isDice, channelId, windowId, activeCharacter, characters]);

  const send = async () => {
    if (!canPost || !text.trim() || !channelId || !windowId || sending) return;
    setSending(true);
    try {
      await api.postMessage(channelId, windowId, { content: text.trim(), reference_ids: references.map(m=>m.id), kind, character_id: activeCharacter || undefined, visibility, whisper_to: visibility === 'whisper' ? whisperTo.split(',').map((x) => x.trim()).filter(Boolean) : undefined });
      setText(''); clearReferences();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setSending(false); ta.current?.focus(); }
  };
  return (
    <div className="composer">
      {!canPost && <p className="small muted">{tr('Shared group view: reading only. Join this chat window to speak.')}</p>}
      {references.length>0 && <div className="chat-reference-drafts" aria-label={tr('Chat references')}>
        {references.map(m=><div className="chat-reference" key={m.id}><div className="row"><span className="grow">{m.character_name ?? m.author_name}</span><button className="ghost small" aria-label={tr('Remove reference')} onClick={()=>removeReference(m.id)}>×</button></div><div className="small">{m.content.slice(0,240)}</div></div>)}
      </div>}
      <div className="composer-input">
        <textarea disabled={!canPost} ref={ta} value={text} onChange={(e) => setText(e.target.value)} placeholder={isGm ? tr("Narrate, speak as an NPC, or adjudicate…") + (diceOn ? '  (.ra skill · .r 1d100 · .sc 1/1d6 · .st str60)' : '') : tr("What does your character do or say?") + (diceOn ? '  (.ra skill to roll)' : '')}
          onScroll={(e) => { if (ghost.current) ghost.current.scrollTop = e.currentTarget.scrollTop; }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {isDice && hint && hint.for === text && (
          <div className="composer-ghost" ref={ghost} aria-hidden><span className="ghost-text">{text}</span><span className="ghost-hint">{'  —— '}{hint.text}</span></div>
        )}
      </div>
      <div className="toolbar">
        {/* A message starting with a dot command (.r .ra .sc .st .en …) is rolled by the server; there is no manual roll kind. */}
        <select value={kind} onChange={(e) => setKind(e.target.value as any)} disabled={isDice} title={isDice ? tr("Dot commands are rolled automatically") : tr("Message kind")}>
          <option value="ic">{tr("In character")}</option><option value="narration">{tr("Narration")}</option><option value="ooc">{tr("Out of character")}</option>
        </select>
        {(isGm ? characters : myCharacters).length > 0 && (
          <select value={activeCharacter} onChange={(e) => setCharacterId(e.target.value)} title={tr("Speak as")}>
            {isGm && <option value="">{tr("— as GM —")}</option>}
            {(isGm ? characters : myCharacters).map((c) => <option key={c.id} value={c.id}>{c.name}{c.kind === 'npc' ? tr(" (NPC)") : ''}</option>)}
          </select>
        )}
        {isGm && (
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as any)} title={tr("Visibility")}>
            <option value="window">{tr("Visible to window")}</option><option value="gm_only">{tr("GM-only note")}</option><option value="whisper">{tr("Whisper to characters")}</option>
          </select>
        )}
        {isGm && visibility === 'whisper' && (
          <select value={whisperTo} onChange={(e) => setWhisperTo(e.target.value)}><option value="">{tr("choose character…")}</option>{characters.filter((c) => c.kind === 'pc').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        )}
        <span className="spacer" />
        {features?.consistency !== false && channel?.consistency_enabled !== false && <ConsistencyButton draft={text} characterId={activeCharacter} />}
        {features?.inspiration !== false && channel?.inspiration_enabled !== false && <InspirationButton characterId={activeCharacter} />}
        <button className="primary" onClick={send} disabled={!canPost || !text.trim() || sending}>{tr("Send")}</button>
      </div>
    </div>
  );
}
