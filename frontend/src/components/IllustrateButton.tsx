import { t as tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useChat } from '../store/chat';
import { useUi } from '../store/ui';
import { useEscape } from '../hooks/useEscape';
import CachedImg from './CachedImg';
import type { IllustrationJob } from '../types';

const MAX_CHARACTERS = 6, MAX_PROMPT = 1500;

// Illustrate a moment: pick characters as visual references (their main portraits), describe the pose, action and
// place, and the server's image AI draws it. The platform asks it to dare an unexpected viewpoint. The picture is
// posted in this window as the requester's out-of-character line.
export default function IllustrateButton() {
  const { channelId, windowId, characters } = useNav();
  const toast = useUi((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<IllustrationJob[]>([]);
  const reported = useRef(new Set<string>());
  const busy = jobs.find((j) => j.status === 'pending' || j.status === 'running');

  const refresh = async () => {
    if (!channelId) return;
    try {
      const mine = await api.illustrations(channelId);
      setJobs(mine);
      for (const j of mine) {
        if (j.status !== 'failed' && !(j.status === 'completed' && j.error) || reported.current.has(j.id)) continue;
        reported.current.add(j.id);
        if (Date.now() - Date.parse(j.finished_at ?? j.created_at) < 10 * 60000) toast(tr('The illustration could not be drawn: {error}', { error: j.error ?? '' }), 'error');
      }
    } catch { /* the list is only a progress view */ }
  };
  // Earlier failures are not announced again; while a picture is being drawn, the list is checked every few seconds.
  useEffect(() => { reported.current = new Set(); if (channelId) api.illustrations(channelId).then((mine) => { mine.forEach((j) => reported.current.add(j.id)); setJobs(mine); }).catch(() => undefined); }, [channelId]);
  useEffect(() => { if (!busy) return; const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [busy?.id, channelId]);
  // The picture arrives as a new line over the live socket: check at once instead of at the next tick.
  const latest = useChat((s) => { const list = windowId ? s.byWindow[windowId] : undefined; return list?.length ? list[list.length - 1].id : undefined; });
  useEffect(() => { if (busy) refresh(); }, [latest]);

  return (
    <>
      <button className="ai-btn" onClick={() => setOpen(true)} title={tr('Draw a picture of this moment and post it here')}>
        {busy ? tr('Drawing…') : tr('Illustrate')}
      </button>
      {open && channelId && windowId && (
        <IllustrateDialog channelId={channelId} windowId={windowId} characters={characters} jobs={jobs} busy={!!busy}
          onClose={() => setOpen(false)} onQueued={refresh} />
      )}
    </>
  );
}

function IllustrateDialog({ channelId, windowId, characters, jobs, busy, onClose, onQueued }: {
  channelId: string; windowId: string; characters: ReturnType<typeof useNav.getState>['characters']; jobs: IllustrationJob[]; busy: boolean; onClose: () => void; onQueued: () => void;
}) {
  useEscape(onClose);
  const toast = useUi((s) => s.toast);
  const [picked, setPicked] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [orientation, setOrientation] = useState<'landscape' | 'portrait' | 'square'>('landscape');
  // Each character in the outfit they wear now unless another is picked here ("" = the base look).
  const [outfitOf, setOutfitOf] = useState<Record<string, string>>({});
  const dressed = picked.map((id) => characters.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c?.outfits?.length);
  const [sending, setSending] = useState(false);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_CHARACTERS ? p : [...p, id]));
  const draw = async () => {
    setSending(true);
    try {
      const outfits = Object.fromEntries(dressed.map((c) => [c.id, outfitOf[c.id] ?? c.outfit_id ?? '']));
      await api.illustrate(channelId, windowId, { prompt: prompt.trim(), character_ids: picked, outfits, orientation, allow_cloud: true, request_id: crypto.randomUUID() });
      toast(tr('Drawing… the picture will appear in this window.'));
      onQueued(); onClose();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setSending(false); }
  };
  const cancel = async (id: string) => { try { await api.cancelIllustration(channelId, id); onQueued(); } catch (e: any) { toast(e.message, 'error'); } };
  const recent = jobs.slice(0, 3);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal col illustrate" role="dialog" aria-modal="true" aria-label={tr('Illustrate a moment')} onClick={(e) => e.stopPropagation()}>
        <h3>{tr('Illustrate a moment')}</h3>
        <div className="section-label">{tr('Characters in the picture')} <span className="tiny muted">{picked.length}/{MAX_CHARACTERS}</span></div>
        {characters.length === 0 ? <div className="muted small">{tr('No characters yet: the picture follows your description only.')}</div> : (
          <div className="illustrate-cast">
            {characters.map((c) => {
              const on = picked.includes(c.id);
              return (
                <label key={c.id} className={`illustrate-who ${on ? 'on' : ''}`} title={c.portrait_asset_id || c.avatar_asset_id ? tr('Their portrait is sent as the reference') : tr('No portrait: the appearance description is used')}>
                  <input type="checkbox" checked={on} disabled={!on && picked.length >= MAX_CHARACTERS} onChange={() => toggle(c.id)} />
                  <span className="avatar small">{c.avatar_asset_id ? <CachedImg src={api.mediaUrl(channelId, c.avatar_asset_id, c.avatar_asset_version ?? undefined)} hash={c.avatar_asset_hash} alt="" /> : c.name.slice(0, 2).toUpperCase()}</span>
                  <span>{c.name}{c.kind === 'npc' ? tr(' (NPC)') : ''}</span>
                </label>
              );
            })}
          </div>
        )}
        {dressed.length > 0 && (
          <div className="col" style={{ gap: 4 }}>
            <span className="section-label">{tr('Outfits')}</span>
            {dressed.map((c) => (
              <label key={c.id} className="row small" style={{ gap: 8 }}>
                <span className="grow">{c.name}</span>
                <select value={outfitOf[c.id] ?? c.outfit_id ?? ''} onChange={(e) => setOutfitOf({ ...outfitOf, [c.id]: e.target.value })}>
                  <option value="">{tr('Base look')}{!c.outfit_id ? tr(' (worn now)') : ''}</option>
                  {c.outfits!.map((o) => <option key={o.id} value={o.id}>{o.name}{o.id === c.outfit_id ? tr(' (worn now)') : ''}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}
        <label className="col" style={{ gap: 4 }}>
          <span className="section-label">{tr('What happens: pose, action, place, light')}</span>
          <textarea rows={4} maxLength={MAX_PROMPT} value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus
            placeholder={tr('e.g. Ada and Mo whisper on the rainy pier at dusk, lanterns swaying behind them')} />
        </label>
        <label className="row" style={{ gap: 8 }}>
          <span className="small">{tr('Shape')}</span>
          <select value={orientation} onChange={(e) => setOrientation(e.target.value as typeof orientation)}>
            <option value="landscape">{tr('Landscape')}</option><option value="portrait">{tr('Portrait')}</option><option value="square">{tr('Square')}</option>
          </select>
        </label>
        <p className="tiny muted">{tr('The image AI is asked to dare a bold, unexpected viewpoint. Your description and the chosen characters’ portraits are sent to the server’s image service; the picture is posted in this window as your out-of-character line.')}</p>
        {recent.length > 0 && (
          <div className="col" style={{ gap: 2 }}>
            {recent.map((j) => (
              <div key={j.id} className="pick-row tiny">
                <span className="grow muted">{j.prompt}</span>
                <span className={`pill ${j.status === 'failed' ? 'gm' : ''}`}>{tr(j.status)}</span>
                {(j.status === 'pending' || j.status === 'running') && <button className="ghost small" onClick={() => cancel(j.id)}>{tr('Cancel')}</button>}
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}>{tr('Close')}</button>
          <button className="primary" onClick={draw} disabled={sending || busy || !prompt.trim()} title={busy ? tr('Your previous illustration is still being drawn') : undefined}>
            {sending ? tr('Sending…') : tr('Draw')}
          </button>
        </div>
      </div>
    </div>
  );
}
