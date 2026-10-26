import { t as tr } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import type { CharacterAttributes } from '../types';

// Attributes of a PC or NPC (characters.sheet.attrs) — the values .ra / .sc / .en read and .st writes.
export default function CharacterSheetModal({ characterId, onClose }: { characterId: string; onClose: () => void }) {
  const { channelId, characters } = useNav();
  const toast = useUi((s) => s.toast);
  const [sheet, setSheet] = useState<CharacterAttributes | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [filter, setFilter] = useState('');
  const character = characters.find((c) => c.id === characterId);

  const load = () => { if (channelId) api.attributes(channelId, characterId).then((s) => { setSheet(s); setEdits({}); }).catch((e) => toast(e.message, 'error')); };
  useEffect(load, [channelId, characterId, character?.sheet]);
  if (!channelId) return null;

  const save = async (body: { set?: Record<string, number>; remove?: string[] }) => {
    try { const s = await api.updateAttributes(channelId, characterId, body); setSheet(s); setEdits({}); } catch (e: any) { toast(e.message, 'error'); }
  };
  const commitEdit = (name: string) => {
    const raw = edits[name]; if (raw === undefined) return;
    const v = Number(raw); if (raw.trim() === '' || !Number.isFinite(v)) { setEdits((e) => { const n = { ...e }; delete n[name]; return n; }); return; }
    if (v !== sheet?.attrs[name]) save({ set: { [name]: Math.round(v) } });
  };
  const add = () => {
    const v = Number(newValue);
    if (!newName.trim() || newValue.trim() === '' || !Number.isFinite(v)) return;
    save({ set: { [newName.trim()]: Math.round(v) } }); setNewName(''); setNewValue('');
  };
  const names = Object.keys(sheet?.attrs ?? {}).filter((n) => !filter || n.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal col" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h3 className="grow" style={{ margin: 0 }}>{sheet?.name ?? character?.name ?? tr("Character")}</h3><span className="pill">{sheet?.kind === 'npc' ? tr("NPC") : tr("PC")}</span></div>
        {!sheet ? <div className="muted">{tr("Loading…")}</div> : (
          <>
            {names.length > 6 && <input placeholder={tr("Filter attributes")} value={filter} onChange={(e) => setFilter(e.target.value)} />}
            <div className="attr-grid">
              {names.length === 0 && <div className="muted small">{tr("No attributes yet.")}</div>}
              {names.map((n) => (
                <div key={n} className="attr">
                  <span className="grow small">{n}</span>
                  {sheet.editable ? (
                    <input className="attr-value" value={edits[n] ?? String(sheet.attrs[n])} onChange={(e) => setEdits({ ...edits, [n]: e.target.value })}
                      onBlur={() => commitEdit(n)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} inputMode="numeric" />
                  ) : <span className="attr-value">{sheet.attrs[n]}</span>}
                  {sheet.editable && <button className="ghost small" title={tr("Remove")} onClick={() => save({ remove: [n] })}>×</button>}
                </div>
              ))}
            </div>
            {sheet.editable && (
              <div className="row">
                <input className="grow" placeholder={tr("Attribute (e.g. Spot Hidden, 侦查, research)")} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
                <input style={{ width: 80 }} placeholder={tr("Value")} value={newValue} onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} inputMode="numeric" />
                <button className="primary small" onClick={add}>{tr("Add")}</button>
              </div>
            )}
            <div className="tiny muted">{tr("In chat, speak as this character and type ")}<code>{tr(".st str60 dex50 research53")}</code>{tr(" to set many at once, ")}<code>{tr(".st hp-2")}</code>{tr(" to adjust, ")}<code>{tr(".ra research")}</code>{tr(" or ")}<code>{tr(".ra hard spot hidden")}</code>{tr(" to check, ")}<code>{tr(".sc 1/1d6")}</code>{tr(" for sanity.")}</div>
          </>
        )}
        <div className="row"><span className="grow" /><button className="ghost" onClick={onClose}>{tr("Close")}</button></div>
      </div>
    </div>
  );
}
