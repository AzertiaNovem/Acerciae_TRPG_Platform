// Only the labels and a random keychain slot go in WebView storage. Bind every
// credential to its origin in the keychain too, before it can be used for HTTP.
import type { Keychain } from './tokenStore';
import type { User } from '../types';

export interface AccountChoice { slot: string; server: string; id: string; username: string; name: string }
interface Directory { active: string | null; accounts: AccountChoice[] }
const directoryKey = 'acerciae.desktop.accounts.v1';

export function createAccountDirectory(storage: Pick<Storage, 'getItem' | 'setItem'>, keychain: () => Promise<Keychain>) {
  function read(): Directory | null {
    const value = storage.getItem(directoryKey);
    return value ? JSON.parse(value) as Directory : null;
  }
  function write(value: Directory) { storage.setItem(directoryKey, JSON.stringify(value)); }
  function selected() { const d = read(); return d?.accounts.find(a => a.slot === d.active); }
  // Restrict what a directory entry may read to account credentials.
  function secretName(slot: string) {
    if (!/^[a-f0-9-]{36}$/i.test(slot)) throw Error('Invalid account');
    return 'account.' + slot;
  }
  return {
    read, selected,
    async restore() {
      const row = selected();
      if (!row) return null;
      const value = await (await keychain()).get(secretName(row.slot));
      if (!value) return null;
      const saved = JSON.parse(value);
      if (saved.server !== row.server || saved.id !== row.id || typeof saved.token !== 'string') throw Error('Invalid account');
      return { server: row.server, token: saved.token as string };
    },
    async remember(server: string, user: User, token: string) {
      const d = read() ?? { accounts: [], active: null };
      const old = d.accounts.find(a => a.id === user.id && a.server === server);
      const row = { slot: old?.slot ?? crypto.randomUUID(), server, id: user.id, username: user.username, name: user.display_name };
      await (await keychain()).set(secretName(row.slot), JSON.stringify({ server, id: user.id, token }));
      write({ active: row.slot, accounts: [...d.accounts.filter(a => a.slot !== row.slot), row] });
    },
    select(slot: string | null) {
      const d = read();
      if (!d || (slot !== null && !d.accounts.some(a => a.slot === slot))) throw Error('Invalid account');
      write({ ...d, active: slot });
    },
    async removeActive() {
      const d = read();
      if (!d?.active) return;
      await (await keychain()).remove(secretName(d.active));
      write({ active: null, accounts: d.accounts.filter(a => a.slot !== d.active) });
    },
  };
}
