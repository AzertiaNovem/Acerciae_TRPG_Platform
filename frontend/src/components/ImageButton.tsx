import { t as tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useChat } from '../store/chat';
import { useUi } from '../store/ui';
import { useEscape } from '../hooks/useEscape';
import CachedImg from './CachedImg';
import { MAX_PICTURE_BYTES, PICTURE_ACCEPT, PICTURE_TYPES, preparePicture } from '../lib/picture';
import type { IllustrationJob } from '../types';

const MAX_CHARACTERS = 6, MAX_PROMPT = 1500;

// The picture button beside Send. A member posts an image of their own (a handout, a map, a photo of a prop: picked
// here, or pasted or dropped into the message box) or, where the server and the GM allow it, has the image AI draw a
// moment. With drawing unavailable the button opens the file picker at once.
export default function ImageButton({ canDraw, onPick }: { canDraw: boolean; onPick: (file: File) => void }) {
  const { channelId, windowId, characters } = useNav();
  const toast = useUi((s) => s.toast);
  const [menu, setMenu] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [jobs, setJobs] = useState<IllustrationJob[]>([]);
  const reported = useRef(new Set<string>());
  const picker = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const busy = canDraw ? jobs.find((j) => j.status === 'pending' || j.status === 'running') : undefined;

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
  useEffect(() => { reported.current = new Set(); setJobs([]); if (channelId && canDraw) api.illustrations(channelId).then((mine) => { mine.forEach((j) => reported.current.add(j.id)); setJobs(mine); }).catch(() => undefined); }, [channelId, canDraw]);
  useEffect(() => { if (!busy) return; const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [busy?.id, channelId]);
  // The picture arrives as a new line over the live socket: check at once instead of at the next tick.
  const latest = useChat((s) => { const list = windowId ? s.byWindow[windowId] : undefined; return list?.length ? list[list.length - 1].id : undefined; });
  useEffect(() => { if (busy) refresh(); }, [latest]);
  // The menu closes on a click elsewhere and on Escape.
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [menu]);

  const choose = () => { setMenu(false); picker.current?.click(); };
  return (
    <span className="image-button" ref={wrap}>
      <button onClick={() => (canDraw ? setMenu((m) => !m) : choose())} aria-haspopup={canDraw ? 'menu' : undefined} aria-expanded={canDraw ? menu : undefined}
        title={canDraw ? tr('Post a picture: upload one, or have the AI draw this moment') : tr('Post a picture: a handout, a map, a photo')}>
        {busy ? tr('Drawing…') : tr('▣ Image')}
      </button>
      <input ref={picker} type="file" accept={PICTURE_ACCEPT} hidden data-testid="picture-file"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f); }} />
      {menu && (
        <div className="image-menu" role="menu">
          <button role="menuitem" className="ghost" onClick={choose}>
            <b>{tr('Upload an image…')}</b><span className="tiny muted">{tr('A handout, a map, a photo: posted here as your line')}</span>
          </button>
          <button role="menuitem" className="ghost" onClick={() => { setMenu(false); setDrawing(true); }}>
            <b>{tr('Draw with AI…')}</b><span className="tiny muted">{tr('Draw a picture of this moment and post it here')}</span>
          </button>
        </div>
      )}
      {drawing && channelId && windowId && (
        <IllustrateDialog channelId={channelId} windowId={windowId} characters={characters} jobs={jobs} busy={!!busy}
          onClose={() => setDrawing(false)} onQueued={refresh} />
      )}
    </span>
  );
}

// A picture of the member's own, about to be posted: a preview, an optional caption, and how it will be posted (as
// the message box is set: in character, as narration or out of character, as which character, to whom).
export function UploadPictureDialog({ file, channelId, windowId, caption: initial, fields, postedAs, onClose, onPosted }: {
  file: File; channelId: string; windowId: string; caption: string;
  fields: { kind: string; character_id?: string; visibility?: string; whisper_to?: string };
  postedAs: string; onClose: () => void; onPosted: (caption: string) => void;
}) {
  useEscape(onClose);
  const toast = useUi((s) => s.toast);
  const [caption, setCaption] = useState(initial);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState('');
  useEffect(() => { const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url); }, [file]);
  const known = !file.type || PICTURE_TYPES.includes(file.type);
  const post = async () => {
    setSending(true);
    try {
      const ready = await preparePicture(file);
      if (ready.size > MAX_PICTURE_BYTES) { toast(tr('The picture is too large (at most {n} MB).', { n: MAX_PICTURE_BYTES / (1024 * 1024) }), 'error'); return; }
      await api.postPicture(channelId, windowId, ready, { ...fields, content: caption.trim() });
      onPosted(caption.trim()); onClose();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setSending(false); }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal col upload-picture" role="dialog" aria-modal="true" aria-label={tr('Post a picture')} onClick={(e) => e.stopPropagation()}>
        <h3>{tr('Post a picture')}</h3>
        {known ? <img className="upload-preview" src={preview} alt="" /> : <div className="muted small">{tr('Choose a PNG, JPEG, WebP or GIF image.')}</div>}
        <div className="tiny muted">{file.name} · {(file.size / 1024 / 1024).toFixed(file.size < 1024 * 1024 ? 2 : 1)} MB</div>
        <label className="col" style={{ gap: 4 }}>
          <span className="section-label">{tr('Caption (optional)')}</span>
          <textarea rows={3} maxLength={2000} value={caption} onChange={(e) => setCaption(e.target.value)} autoFocus
            placeholder={tr('What the picture shows: a clue, a place, a handout…')}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && known && !sending) { e.preventDefault(); post(); } }} />
        </label>
        <p className="tiny muted">{tr('The AI helpers cannot see pictures: they read the caption.')}{file.type === 'image/jpeg' ? ' ' + tr('A photo is redrawn in your browser first, which leaves out where and when it was taken.') : ''}</p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
          <span className="tiny muted grow">{tr('Posted as {who}', { who: postedAs })}</span>
          <button onClick={onClose}>{tr('Cancel')}</button>
          <button className="primary" onClick={post} disabled={sending || !known}>{sending ? tr('Sending…') : tr('Post')}</button>
        </div>
      </div>
    </div>
  );
}

// Illustrate a moment: pick characters as visual references (their main portraits), describe the pose, action and
// place, and the server's image AI draws it. The platform asks it to dare an unexpected viewpoint. The picture is
// posted in this window as the requester's out-of-character line.
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
