// Where the session token is kept. On the web: the browser's local storage. In the desktop app: the system keychain
// (macOS Keychain, Windows Credential Manager, Secret Service on Linux; the app falls back to a file only the user can
// read where none exists), never the web view's storage. A token an older desktop version left in local storage
// moves to the keychain at the next start.
import { readStorage, writeStorage } from './storage';

export const STORAGE_KEY = 'acerciae.token';
export const SECRET_NAME = 'session_token';

export interface Keychain {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}
export interface KeyValue { read(key: string): string | null; write(key: string, value: string | null): void }

export function createTokenStore(desktop: boolean, keychain: () => Promise<Keychain>, storage: KeyValue = { read: readStorage, write: writeStorage }) {
  let pending: Promise<void> = Promise.resolve();
  return {
    // What can be known synchronously at start: the web's token; the desktop app has to ask the keychain (load).
    initial(): string | null { return desktop ? null : storage.read(STORAGE_KEY); },
    async load(): Promise<string | null> {
      if (!desktop) return storage.read(STORAGE_KEY);
      const legacy = storage.read(STORAGE_KEY);
      let kc: Keychain;
      try { kc = await keychain(); } catch { return legacy; }
      let saved: string | null = null;
      try { saved = await kc.get(SECRET_NAME); } catch { /* unreadable: treat as empty */ }
      if (legacy) {
        try { if (!saved) await kc.set(SECRET_NAME, legacy); storage.write(STORAGE_KEY, null); }
        catch { return saved ?? legacy; }   // the keychain refused it: keep the old copy rather than lose the session
      }
      return saved ?? legacy;
    },
    // Writes are queued so a sign-out right after a sign-in cannot be overtaken by the earlier write.
    save(token: string | null): Promise<void> {
      if (!desktop) { storage.write(STORAGE_KEY, token); return Promise.resolve(); }
      storage.write(STORAGE_KEY, null);
      pending = pending.then(async () => {
        const kc = await keychain();
        if (token) await kc.set(SECRET_NAME, token); else await kc.remove(SECRET_NAME);
      }).catch((e) => console.error('Could not store the session in the keychain', e));
      return pending;
    },
  };
}

export const tauriKeychain = async (): Promise<Keychain> => {
  const { invoke } = await import('@tauri-apps/api/core');
  return {
    get: (name) => invoke<string | null>('secret_get', { name }),
    set: (name, value) => invoke<void>('secret_set', { name, value }),
    remove: (name) => invoke<void>('secret_delete', { name }),
  };
};
