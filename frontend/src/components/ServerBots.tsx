import { t as tr } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useUi } from '../store/ui';
import { BotTag } from './BotTag';
import type { Bot } from '../types';

// Server settings → Bots: the server's AI members (docs/BOTS.md). Maintainers give each a name, a persona for outside
// the table and a speaking style, and limit how often it talks; members invite them into channels.
type Draft = { id?: string; name: string; persona: string; speaking_style: string; enabled: boolean; unprompted_per_hour: number; turns_per_hour: number; share_tables: boolean };
const blank: Draft = { name: '', persona: '', speaking_style: '', enabled: true, unprompted_per_hour: 2, turns_per_hour: 60, share_tables: false };
const draftOf = (b: Bot): Draft => ({ id: b.id, name: b.name, persona: b.persona ?? '', speaking_style: b.speaking_style ?? '', enabled: b.enabled,
  unprompted_per_hour: b.unprompted_per_hour ?? 2, turns_per_hour: b.turns_per_hour ?? 60, share_tables: !!b.share_tables });
const clamp = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

export function ServerBots({ serverId, enabled }: { serverId: string; enabled: boolean }) {
  const toast = useUi((s) => s.toast);
  const [bots, setBots] = useState<Bot[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => { api.bots(serverId).then(setBots).catch(() => undefined); }, [serverId]);
  useEffect(load, [load]);

  const save = async () => {
    if (!editing || !editing.name.trim()) return;
    setSaving(true);
    const { id, ...body } = editing;
    try {
      if (id) await api.updateBot(serverId, id, body); else await api.createBot(serverId, body);
      toast(id ? 'Bot saved' : 'Bot created'); setEditing(null); load();
    } catch (e: any) { toast(e.message, 'error'); } finally { setSaving(false); }
  };
  const retire = async (b: Bot) => {
    if (!confirm(tr('Retire {name}? The bot leaves every channel; its lines and characters stay.', { name: b.name }))) return;
    try { await api.deleteBot(serverId, b.id); load(); } catch (e: any) { toast(e.message, 'error'); }
  };

  if (editing) {
    const set = (patch: Partial<Draft>) => setEditing({ ...editing, ...patch });
    return (
      <div className="col bot-editor">
        <label className="col"><span className="section-label">{tr('Name')}</span>
          <input value={editing.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} placeholder={tr('The name everyone sees')} /></label>
        <label className="col"><span className="section-label">{tr('Persona outside the table')}</span>
          <textarea rows={6} value={editing.persona} onChange={(e) => set({ persona: e.target.value })}
            placeholder={tr('Who the bot is when it is not playing: its character, interests, how it treats people. Its role cards will be in keeping with it.')} />
          <span className="tiny muted">{tr('{n} of 8000 bytes', { n: new TextEncoder().encode(editing.persona).length })}</span></label>
        <label className="col"><span className="section-label">{tr('Speaking style')}</span>
          <textarea rows={2} value={editing.speaking_style} onChange={(e) => set({ speaking_style: e.target.value })} placeholder={tr('How it writes: tone, length, habits.')} /></label>
        <label className="row"><input type="checkbox" checked={editing.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <span>{tr('Enabled')}</span><span className="tiny muted">{tr('A switched-off bot cannot be invited and stays silent.')}</span></label>
        <label className="row"><input type="checkbox" checked={editing.share_tables} onChange={(e) => set({ share_tables: e.target.checked })} />
          <span className="col" style={{ gap: 2 }}><span>{tr('Share memories between tables')}</span>
            <span className="tiny muted">{tr('Off: what it saw at a table comes up only with that table’s players. Whispers and private scenes never leave their table.')}</span></span></label>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="row"><span>{tr('Lines on its own per hour')}</span>
            <input type="number" min={0} max={60} style={{ width: 64 }} value={editing.unprompted_per_hour} onChange={(e) => set({ unprompted_per_hour: clamp(e.target.value, 0, 60) })} /></label>
          <label className="row"><span>{tr('Turns per hour, at most')}</span>
            <input type="number" min={1} max={600} style={{ width: 72 }} value={editing.turns_per_hour} onChange={(e) => set({ turns_per_hour: clamp(e.target.value, 1, 600) })} /></label>
        </div>
        <div className="row"><span className="grow" />
          <button onClick={() => setEditing(null)}>{tr('Cancel')}</button>
          <button className="primary" disabled={saving || !editing.name.trim()} onClick={save}>{saving ? tr('Saving…') : tr('Save')}</button></div>
      </div>
    );
  }
  return (
    <div className="col">
      {!enabled && <p className="tiny muted">{tr('Bots are turned off on this server. Turn them on in Features to create or edit them.')}</p>}
      <div className="col" style={{ gap: 4 }}>
        {bots.length === 0 && <p className="muted small">{tr('No bots yet.')}</p>}
        {bots.map((b) => (
          <div key={b.id} className="pick-row">
            <span className="grow">{b.name} <BotTag />{!b.enabled && <span className="pill">{tr('off')}</span>}
              <span className="tiny muted"> {b.channels?.length ? tr('in {list}', { list: b.channels.map((c) => c.name).join(', ') }) : tr('in no channel')}</span></span>
            <button className="small" disabled={!enabled} onClick={() => setEditing(draftOf(b))}>{tr('Edit')}</button>
            <button className="small" onClick={() => retire(b)}>{tr('Retire')}</button>
          </div>
        ))}
      </div>
      <div className="row"><span className="grow" /><button className="primary" disabled={!enabled} onClick={() => setEditing({ ...blank })}>{tr('New bot')}</button></div>
    </div>
  );
}
