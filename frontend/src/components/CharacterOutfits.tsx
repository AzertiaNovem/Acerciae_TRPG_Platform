import { t as tr } from '../i18n';
import { useState } from 'react';
import { api } from '../api/client';
import { CachedImg } from './CachedImg';
import type { CharacterSpace as Space, Outfit } from '../types';

// Outfits of a generated character: other clothes for the same person, each with its own portrait, avatar and poses,
// drawn from the main portrait so the face stays the same. The one worn now shows in the chat; each line remembers it,
// so a visual novel shows every line in the clothes worn when it was written, and illustrations draw it.
export default function CharacterOutfits({ channelId, characterId, space, editable, busy, canGenerate, subtitles, mutate }: {
  channelId: string; characterId: string; space: Space; editable: boolean; busy: boolean; canGenerate: boolean; subtitles: string[];
  mutate: (request: () => Promise<Space>, message?: string) => Promise<void>;
}) {
  const outfits = space.outfits ?? [], max = space.max_outfits ?? 8;
  const worn = space.character.outfit_id ?? '';
  const [draft, setDraft] = useState({ name: '', attire: '' });
  const url = (a: { id: string; version: number }) => api.mediaUrl(channelId, a.id, a.version);
  const add = async () => {
    await mutate(() => api.createOutfit(channelId, characterId, { name: draft.name.trim(), attire: draft.attire.trim() }), tr('Outfit added'));
    setDraft({ name: '', attire: '' });
  };
  const wear = (id: string | null) => mutate(() => api.wearOutfit(channelId, characterId, id));
  const generate = (o: Outfit, slots: string[], subs: string[]) => mutate(async () => (await api.generateOutfit(channelId, characterId, o.id, { slots, subtitles: subs, allow_cloud: true })).space, tr('Image generation queued'));
  const remove = async (o: Outfit) => {
    if (!confirm(tr('Delete the outfit "{name}" and its images? Lines written in it will show the base look.', { name: o.name }))) return;
    await mutate(() => api.deleteOutfit(channelId, characterId, o.id));
  };
  const removeImage = async (assetId: string) => { if (!confirm(tr('Remove this image from the character?'))) return; await mutate(() => api.deleteCharacterAsset(channelId, characterId, assetId)); };
  const save = (o: Outfit, patch: { name?: string; attire?: string }) => mutate(() => api.updateOutfit(channelId, characterId, o.id, patch));
  const noPortrait = !space.portrait;
  return (
    <div className="outfits" data-testid="outfits">
      <h4 style={{ marginTop: 12 }}>{tr('Outfits')} <span className="tiny muted">{outfits.length}/{max}</span></h4>
      <div className="tiny muted">{tr('Other clothes for the same person. Each outfit gets its own portrait, avatar and poses, drawn from the main portrait so the face stays the same. The outfit worn now shows in the chat, and each line remembers it: a visual novel shows every line in the clothes worn when it was written, and illustrations draw the character in it.')}</div>
      {outfits.map((o) => (
        <div key={o.id} className={`outfit ${o.id === worn ? 'worn' : ''}`}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {editable
              ? <input className="grow" defaultValue={o.name} key={`n${o.name}`} aria-label={tr('Outfit name')} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== o.name && save(o, { name: e.target.value.trim() })} style={{ fontWeight: 600 }} />
              : <b className="grow">{o.name}</b>}
            {o.id === worn && <span className="pill ok">{tr('Worn now')}</span>}
            {editable && (o.id === worn
              ? <button className="small" disabled={busy} onClick={() => wear(null)}>{tr('Back to the base look')}</button>
              : <button className="small" disabled={busy} onClick={() => wear(o.id)}>{tr('Wear')}</button>)}
            {editable && <button className="ghost small" disabled={busy} onClick={() => remove(o)}>{tr('Delete')}</button>}
          </div>
          {editable
            ? <textarea defaultValue={o.attire} key={`a${o.attire}`} aria-label={tr('What they wear: clothes, shoes, accessories')} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== o.attire && save(o, { attire: e.target.value.trim() })} style={{ minHeight: 44 }} />
            : <div className="small">{o.attire}</div>}
          <div className="subtitle-grid">
            {o.portrait && <div className="tile"><CachedImg src={url(o.portrait)} hash={o.portrait.hash} alt="" /><div className="cap row"><b className="grow">{tr('Portrait')}</b>{editable && <button className="ghost small" onClick={() => removeImage(o.portrait!.id)}>×</button>}</div></div>}
            {o.avatar && <div className="tile"><CachedImg src={url(o.avatar)} hash={o.avatar.hash} alt="" /><div className="cap row"><b className="grow">{tr('Avatar')}</b>{editable && <button className="ghost small" onClick={() => removeImage(o.avatar!.id)}>×</button>}</div></div>}
            {o.subtitles.map((s) => <div key={s.id} className="tile"><CachedImg src={url(s)} hash={s.hash} alt="" /><div className="cap row"><b className="grow">{s.subtitle}</b>{editable && <button className="ghost small" onClick={() => removeImage(s.id)}>×</button>}</div></div>)}
            {!o.portrait && !o.avatar && o.subtitles.length === 0 && <div className="small muted">{tr('No images yet: until it has some, the base look stands in.')}</div>}
          </div>
          {editable && (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="primary small" disabled={!canGenerate || busy || noPortrait} title={noPortrait ? tr('Generate the main portrait first: outfits are drawn from it') : undefined} onClick={() => generate(o, ['portrait', 'avatar'], subtitles)}>{tr('Generate portrait, avatar and the chosen subtitles')}</button>
              <button className="small" disabled={!canGenerate || busy || !o.portrait || subtitles.length === 0} onClick={() => generate(o, [], subtitles)}>{tr('Generate the chosen subtitles only')}</button>
            </div>
          )}
        </div>
      ))}
      {editable && outfits.length < max && (
        <div className="col outfit-new" style={{ gap: 4, marginTop: 8 }}>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={tr('Outfit name, e.g. Ball gown')} aria-label={tr('Outfit name')} />
          <textarea value={draft.attire} onChange={(e) => setDraft({ ...draft, attire: e.target.value })} placeholder={tr('What they wear, e.g. an emerald silk ball gown, long white gloves, pearl earrings')} aria-label={tr('What they wear: clothes, shoes, accessories')} style={{ minHeight: 44 }} />
          <div className="row"><button className="small" disabled={busy || !draft.name.trim() || !draft.attire.trim()} onClick={add}>{tr('Add outfit')}</button></div>
        </div>
      )}
    </div>
  );
}
