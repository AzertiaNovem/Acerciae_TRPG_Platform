import { useEffect, useRef } from 'react';
import { chatSocket } from '../api/ws';

// Tells the table that a character is being written as. The first keystroke raises the flag with a `typing` pack;
// another pack every HEARTBEAT_MS keeps it up (the server lets it fall 10 s after the last one, so a closed tab or a
// lost connection never leaves a character typing for good); it is lowered as soon as the line is sent, the text is
// cleared, the writer pauses for IDLE_MS, or the character or window changes.
export const HEARTBEAT_MS = 4000, IDLE_MS = 8000;

const pack = (key: string, active: boolean) => {
  const [channelId, windowId, characterId] = key.split('|');
  chatSocket.send({ type: 'typing', channel_id: channelId, chat_window_id: windowId, character_id: characterId, active });
};

export function useTypingSignal(channelId: string | null, windowId: string | null, characterId: string, text: string) {
  const key = channelId && windowId && characterId ? `${channelId}|${windowId}|${characterId}` : '';
  const s = useRef({ key: '', on: false, lastKey: 0, timer: null as ReturnType<typeof setInterval> | null });
  const lower = () => { const x = s.current; if (x.timer) { clearInterval(x.timer); x.timer = null; } if (x.on) { x.on = false; pack(x.key, false); } };
  // Another window or character (or the composer going away): the old flag falls.
  useEffect(() => { s.current.key = key; return lower; }, [key]);
  useEffect(() => {
    const x = s.current;
    if (!key || !text.trim()) { lower(); return; }
    x.lastKey = Date.now();
    if (!x.on) { x.on = true; pack(key, true); }
    if (!x.timer) x.timer = setInterval(() => { if (Date.now() - x.lastKey > IDLE_MS) lower(); else pack(x.key, true); }, HEARTBEAT_MS);
  }, [key, text]);
}
