import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';
import ConsistencyButton from './ConsistencyButton';
import InspirationButton from './InspirationButton';

export default function MessageComposer() {
  const { channelId, windowId, channel, windows, characters } = useNav();
  const user = useAuth((s) => s.user);
  const { composerInsert, toast } = useUi();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'ic' | 'ooc' | 'narration' | 'roll'>('ic');
  const [visibility, setVisibility] = useState<'window' | 'gm_only' | 'whisper'>('window');
  const [whisperTo, setWhisperTo] = useState<string>('');
  const [characterId, setCharacterId] = useState<string>('');
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const isGm = channel?.my_role === 'gm';
  const win = windows.find((w) => w.id === windowId);
  const myCharacters = characters.filter((c) => c.user_id === user?.id);
  const myWindowCharacter = win?.members?.find((m) => m.user_id === user?.id)?.character_id ?? myCharacters[0]?.id ?? '';
  const activeCharacter = characterId || myWindowCharacter;

  useEffect(() => { if (composerInsert) { setText((t) => (t ? t + '\n' : '') + composerInsert.text); ta.current?.focus(); } }, [composerInsert]);
  useEffect(() => { setKind(isGm ? 'narration' : 'ic'); }, [isGm, windowId]);

  const send = async () => {
    if (!text.trim() || !channelId || !windowId || sending) return;
    setSending(true);
    try {
      await api.postMessage(channelId, windowId, { content: text.trim(), kind, character_id: activeCharacter || undefined, visibility, whisper_to: visibility === 'whisper' ? whisperTo.split(',').map((x) => x.trim()).filter(Boolean) : undefined });
      setText('');
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setSending(false); ta.current?.focus(); }
  };
  return (
    <div className="composer">
      <textarea ref={ta} value={text} onChange={(e) => setText(e.target.value)} placeholder={isGm ? 'Narrate, speak as an NPC, or adjudicate…' : 'What does your character do or say?'}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
      <div className="toolbar">
        <select value={kind} onChange={(e) => setKind(e.target.value as any)} title="Message kind">
          <option value="ic">In character</option><option value="narration">Narration</option><option value="ooc">Out of character</option><option value="roll">Dice / roll</option>
        </select>
        {(isGm ? characters : myCharacters).length > 0 && (
          <select value={activeCharacter} onChange={(e) => setCharacterId(e.target.value)} title="Speak as">
            {isGm && <option value="">— as GM —</option>}
            {(isGm ? characters : myCharacters).map((c) => <option key={c.id} value={c.id}>{c.name}{c.kind === 'npc' ? ' (NPC)' : ''}</option>)}
          </select>
        )}
        {isGm && (
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as any)} title="Visibility">
            <option value="window">Visible to window</option><option value="gm_only">GM-only note</option><option value="whisper">Whisper to characters</option>
          </select>
        )}
        {isGm && visibility === 'whisper' && (
          <select value={whisperTo} onChange={(e) => setWhisperTo(e.target.value)}><option value="">choose character…</option>{characters.filter((c) => c.kind === 'pc').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        )}
        <span className="spacer" />
        <ConsistencyButton draft={text} characterId={activeCharacter} />
        <InspirationButton characterId={activeCharacter} />
        <button className="primary" onClick={send} disabled={!text.trim() || sending}>Send</button>
      </div>
    </div>
  );
}
