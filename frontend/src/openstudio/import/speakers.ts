// Speaker keys. A key is the nickname as written; platform/IM ids only tell speakers apart and are never stored.
// When two different ids share a nickname within one file, the second becomes "Nick#2", the third "Nick#3".
import type { Speaker, SpeakerRole } from '../types';
import { guessRole } from './classify';

interface Entry { speaker: Speaker; identity: string | null }

export class SpeakerTable {
  private readonly byName = new Map<string, Entry[]>();
  private readonly byKey = new Map<string, Entry>();
  private readonly order: Entry[] = [];

  // `identity` is whatever tells two same-named speakers apart (an IM id, a username); null when the source gives
  // none, in which case the line belongs to the first speaker of that name. `role` overrides the name-based guess
  // for a new speaker. Counts one message and returns the speaker's key.
  add(nick: string, identity: string | null, isDice: boolean, role?: SpeakerRole): string {
    const list = this.byName.get(nick) ?? [];
    let entry = identity === null ? list[0] : list.find((e) => e.identity === identity);
    if (!entry && identity !== null) {
      entry = list.find((e) => e.identity === null);
      if (entry) entry.identity = identity;
    }
    if (!entry) {
      let n = list.length + 1, key = n === 1 ? nick : `${nick}#${n}`;
      while (this.byKey.has(key)) key = `${nick}#${++n}`;
      entry = { speaker: { key, name: nick, role: role ?? guessRole(nick, isDice), message_count: 0 }, identity };
      list.push(entry); this.byName.set(nick, list); this.byKey.set(key, entry); this.order.push(entry);
    }
    entry.speaker.message_count++;
    return entry.speaker.key;
  }

  get(key: string): Speaker | undefined { return this.byKey.get(key)?.speaker; }
  setRole(key: string, role: SpeakerRole): void { const e = this.byKey.get(key); if (e) e.speaker.role = role; }
  list(): Speaker[] { return this.order.map((e) => ({ ...e.speaker })); }
}
