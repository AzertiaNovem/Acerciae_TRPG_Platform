import { t as tr } from '../../i18n';
import { useState } from 'react';
import { useUi } from '../../store/ui';
import type { CharacterSheet, Project, SpeakerRole } from '../types';
import { writeAsset } from '../storage';
import { paintCharacter, type ArtSlot } from '../actions';
import { loadAiSettings, TTS_VOICES } from '../providers/settings';
import { useAssetUrls } from './useAssetUrls';

const ROLES: SpeakerRole[] = ['pc', 'npc', 'gm', 'dice', 'hidden', 'system'];
const SUBTITLES = ['IDLE', 'SAY', 'SMILE', 'ANGRY', 'SAD', 'SURPRISED', 'FEAR', 'FIGHT', 'THINK'];

// The cast: who each speaker is, and each character's look (appearance prompt, avatar, main portrait, poses) and voice.
export default function CharactersPanel({ p, update }: { p: Project; update: (fn: (d: Project) => void) => void }) {
  const toast = useUi((s) => s.toast);
  const ai = loadAiSettings();
  const [busy, setBusy] = useState<string | null>(null);
  // Poses added but not yet given an image: shown with their buttons, not stored until they have one.
  const [pending, setPending] = useState<Record<number, string[]>>({});
  const url = useAssetUrls(p.id, p.characters.flatMap((c) => [c.avatar, c.portrait, ...Object.values(c.poses)]));
  const setRole = (key: string, role: SpeakerRole) => update((d) => {
    for (const s of d.speakers) if (s.key === key) s.role = role;
    for (const e of d.events) if (e.speaker_key === key) e.role = role;
  });
  const setOwner = (key: string, name: string) => update((d) => {
    for (const c of d.characters) c.speakers = c.speakers.filter((k) => k !== key);
    const c = d.characters.find((x) => x.name === name); if (c) c.speakers.push(key);
  });
  const edit = (i: number, fn: (c: CharacterSheet) => void) => update((d) => fn(d.characters[i]));
  const upload = async (i: number, slot: ArtSlot, file: File | undefined) => {
    if (!file) return;
    try {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      const path = await writeAsset(p.id, new Uint8Array(await file.arrayBuffer()), ext);
      edit(i, (c) => { if (slot.kind === 'portrait') c.portrait = path; else if (slot.kind === 'avatar') c.avatar = path; else c.poses = { ...c.poses, [slot.subtitle]: path }; });
    } catch (e: any) { toast(String(e?.message ?? e), 'error'); }
  };
  const paint = async (i: number, slot: ArtSlot) => {
    const label = `${p.characters[i].name} ${slot.kind === 'pose' ? slot.subtitle : slot.kind}`;
    setBusy(label);
    try {
      const copy = structuredClone(p.characters[i]);
      await paintCharacter(p, copy, slot, ai.image);
      edit(i, (c) => { c.portrait = copy.portrait; c.avatar = copy.avatar; c.poses = copy.poses; });
    } catch (e: any) { toast(String(e?.message ?? e), 'error'); }
    finally { setBusy(null); }
  };
  const canPaint = ai.image.provider !== 'none';
  const voices = ai.tts.provider === 'none' ? [] : TTS_VOICES[ai.tts.provider];
  const art = (i: number, c: CharacterSheet, slot: ArtSlot, label: string, path: string | null) => (
    <div className="open-studio-art">
      <div className="thumb">{path && url(path) ? <img src={url(path)!} alt="" /> : <span className="tiny muted">{label}</span>}</div>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
        <label className="button small ghost">{tr('Upload')}<input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={(e) => { upload(i, slot, e.target.files?.[0]); e.target.value = ''; }} /></label>
        {canPaint && <button className="ghost small" disabled={!!busy || (!c.appearance && slot.kind !== 'pose')} title={c.appearance ? '' : tr('Write the appearance first')} onClick={() => paint(i, slot)}>{tr('Generate')}</button>}
        {slot.kind === 'pose' && <button className="ghost small" onClick={() => { setPending({ ...pending, [i]: (pending[i] ?? []).filter((s) => s !== slot.subtitle) }); edit(i, (x) => { const poses = { ...x.poses }; delete poses[slot.subtitle]; x.poses = poses; }); }}>✕</button>}
      </div>
      <div className="tiny" style={{ textAlign: 'center' }}>{label}</div>
    </div>
  );
  return (
    <div className="col" style={{ gap: 12, maxWidth: 980 }}>
      <div className="card col" style={{ gap: 6 }}>
        <h3 style={{ margin: 0 }}>{tr('Speakers')}</h3>
        <p className="tiny muted" style={{ margin: 0 }}>{tr('Who each name in the log is: the role decides how lines are shown, the character decides whose look and voice they get.')}</p>
        <table className="simple"><tbody>
          {p.speakers.map((s) => (
            <tr key={s.key}>
              <td><b>{s.name}</b><div className="tiny muted">{tr('{n} lines', { n: s.message_count })}</div></td>
              <td><select value={s.role} onChange={(e) => setRole(s.key, e.target.value as SpeakerRole)}>{ROLES.map((r) => <option key={r} value={r}>{tr(r)}</option>)}</select></td>
              <td><select value={p.characters.find((c) => c.speakers.includes(s.key))?.name ?? ''} onChange={(e) => setOwner(s.key, e.target.value)}><option value="">{tr('— no character —')}</option>{p.characters.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      {busy && <div className="tiny muted">{tr('Generating {what}…', { what: busy })}</div>}
      {p.characters.map((c, i) => (
        <div key={i} className="card col" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input value={c.name} onChange={(e) => { const old = c.name, name = e.target.value; update((d) => { d.characters[i].name = name; if (d.vn) for (const s of d.vn.script.scenes) for (const l of s.lines) for (const st of l.stage ?? []) if (st.character === old) st.character = name; }); }} style={{ fontWeight: 600 }} />
            <select value={c.kind} onChange={(e) => edit(i, (x) => { x.kind = e.target.value as CharacterSheet['kind']; })}><option value="pc">PC</option><option value="npc">NPC</option><option value="gm">GM</option></select>
            <input placeholder={tr('Player')} value={c.player} onChange={(e) => edit(i, (x) => { x.player = e.target.value; })} style={{ width: 160 }} />
            {voices.length > 0 && <select value={c.voice} onChange={(e) => edit(i, (x) => { x.voice = e.target.value; })} title={tr('Voice')}><option value="">{tr('— no voice —')}</option>{voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select>}
            <span className="grow" />
            <button className="ghost small" onClick={() => { if (confirm(tr('Remove {name} from the cast?', { name: c.name }))) update((d) => { d.characters.splice(i, 1); }); }}>{tr('remove')}</button>
          </div>
          <label className="col tiny" style={{ gap: 4 }}>{tr('Appearance (used to generate images)')}<textarea rows={2} value={c.appearance} onChange={(e) => edit(i, (x) => { x.appearance = e.target.value; })} placeholder={tr('Face, hair, clothing, build, age, style…')} /></label>
          {c.role_card && <details className="tiny"><summary>{tr('Role card')}</summary><pre className="open-studio-card">{JSON.stringify(c.role_card, null, 2)}</pre></details>}
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {art(i, c, { kind: 'avatar' }, tr('Avatar'), c.avatar)}
            {art(i, c, { kind: 'portrait' }, tr('Main portrait'), c.portrait)}
            {Object.entries(c.poses).map(([sub, path]) => <div key={sub}>{art(i, c, { kind: 'pose', subtitle: sub }, sub, path)}</div>)}
            {(pending[i] ?? []).filter((sub) => !c.poses[sub]).map((sub) => <div key={'new-' + sub}>{art(i, c, { kind: 'pose', subtitle: sub }, sub, null)}</div>)}
            <AddPose onAdd={(sub) => setPending({ ...pending, [i]: [...(pending[i] ?? []), sub] })} existing={[...Object.keys(c.poses), ...(pending[i] ?? [])]} />
          </div>
        </div>
      ))}
      <button className="small" style={{ alignSelf: 'flex-start' }} onClick={() => update((d) => { d.characters.push({ name: tr('New character'), speakers: [], kind: 'npc', player: '', appearance: '', role_card: null, avatar: null, portrait: null, poses: {}, voice: '' }); })}>{tr('Add a character')}</button>
    </div>
  );
}

function AddPose({ onAdd, existing }: { onAdd: (subtitle: string) => void; existing: string[] }) {
  const [v, setV] = useState('');
  const add = () => { const s = v.trim().toUpperCase().replace(/\s+/g, '_').slice(0, 30); if (s && !existing.includes(s)) onAdd(s); setV(''); };
  return (
    <div className="open-studio-art">
      <div className="thumb"><span className="tiny muted">{tr('New pose')}</span></div>
      <div className="row" style={{ gap: 4 }}>
        <input list="pose-subtitles" value={v} onChange={(e) => setV(e.target.value)} placeholder="SAY" style={{ width: 90 }} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="small" onClick={add}>+</button>
      </div>
      <datalist id="pose-subtitles">{SUBTITLES.map((s) => <option key={s} value={s} />)}</datalist>
    </div>
  );
}
