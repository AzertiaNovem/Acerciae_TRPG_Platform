import { t as tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import type { CharacterSpace as Space, Coc7Rules, RoleCard } from '../types';
import PointBuy from './PointBuy';

let rulesPromise: Promise<Coc7Rules> | null = null;
const loadRules = () => (rulesPromise ??= api.coc7Rules());

const CHARS: (keyof RoleCard['characteristics'])[] = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU', 'LUK'];
const BACKGROUND: (keyof RoleCard['background'])[] = ['personal_description', 'ideology', 'significant_people', 'meaningful_locations', 'treasured_possessions', 'traits', 'injuries', 'phobias', 'arcane', 'encounters'];
const BG_LABEL: Record<string, string> = { personal_description: 'Personal description', ideology: 'Ideology / beliefs', significant_people: 'Significant people', meaningful_locations: 'Meaningful locations', treasured_possessions: 'Treasured possessions', traits: 'Traits', injuries: 'Injuries & scars', phobias: 'Phobias & manias', arcane: 'Arcane tomes, spells & artifacts', encounters: 'Encounters with strange entities' };
const COC_SKILLS = ['Accounting', 'Anthropology', 'Appraise', 'Archaeology', 'Art/Craft', 'Charm', 'Climb', 'Credit Rating', 'Cthulhu Mythos', 'Disguise', 'Dodge', 'Drive Auto', 'Electrical Repair', 'Fast Talk', 'Fighting (Brawl)', 'Firearms (Handgun)', 'Firearms (Rifle/Shotgun)', 'First Aid', 'History', 'Intimidate', 'Jump', 'Language (Other)', 'Language (Own)', 'Law', 'Library Use', 'Listen', 'Locksmith', 'Mechanical Repair', 'Medicine', 'Natural World', 'Navigate', 'Occult', 'Operate Heavy Machinery', 'Persuade', 'Pilot', 'Psychoanalysis', 'Psychology', 'Ride', 'Science', 'Sleight of Hand', 'Spot Hidden', 'Stealth', 'Survival', 'Swim', 'Throw', 'Track'];
const DEFAULT_SUBTITLES = ['IDLE', 'SAY', 'HAPPY', 'SAD', 'ANGRY', 'SCARED', 'FIGHT'];

type Tab = 'card' | 'look' | 'background' | 'items';

// The character space: avatar, main portrait, basic information, the COC7-styled role card, background and items.
// The Keeper and the character's actor edit; everyone else reads. Images come from uploads or from image AI.
export default function CharacterSpace({ characterId }: { characterId: string }) {
  const { channelId, characters, openCharacter } = useNav();
  const toast = useUi((s) => s.toast);
  const [space, setSpace] = useState<Space | null>(null);
  const [card, setCard] = useState<RoleCard | null>(null);
  const [head, setHead] = useState({ name: '', speaking_style: '', bio: '' });
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>('card');
  const [look, setLook] = useState({ asset_mode: 'uploaded' as 'uploaded' | 'generated', appearance_prompt: '' });
  const [newSkill, setNewSkill] = useState('');
  const [newItem, setNewItem] = useState({ name: '', note: '' });
  const [subtitleName, setSubtitleName] = useState('IDLE');
  const [genSubs, setGenSubs] = useState<string[]>(['IDLE', 'SAY']);
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<Coc7Rules | null>(null);
  const fileFor = useRef<{ slot: 'avatar' | 'portrait' | 'subtitle'; subtitle?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const apply = (s: Space) => { setSpace(s); setCard(s.character.role_card); setHead({ name: s.character.name, speaking_style: s.character.speaking_style, bio: s.character.bio ?? '' }); setLook({ asset_mode: s.character.asset_mode ?? 'uploaded', appearance_prompt: s.character.appearance_prompt ?? '' }); setDirty(false); };
  const load = async () => { if (!channelId) return; try { apply(await api.characterSpace(channelId, characterId)); } catch (e: any) { toast(e.message, 'error'); } };
  useEffect(() => { load(); }, [channelId, characterId]);
  const pointsOn = !!space?.points?.enabled;
  useEffect(() => { if (pointsOn && !rules) loadRules().then(setRules).catch((e) => toast(e.message, 'error')); }, [pointsOn]);
  // Live updates (generation finished, another editor saved) arrive as character.updated → characters refresh.
  const version = characters.find((c) => c.id === characterId);
  useEffect(() => { if (space && !dirty) load(); }, [version?.avatar_asset_id, version?.portrait_asset_id, version?.asset_mode]);
  useEffect(() => { if (!space || !space.jobs.some((j) => j.status === 'pending' || j.status === 'running')) return; const t = setTimeout(load, 2500); return () => clearTimeout(t); }, [space]);
  if (!channelId || !space || !card) return <div className="workspace"><div className="content muted">{tr("Loading…")}</div></div>;
  const c = space.character; const editable = c.editable;
  const url = (a: { id: string; version: number } | null) => (a ? api.mediaUrl(channelId, a.id, a.version) : '');
  const half = (v?: number) => (v === undefined ? '' : `${Math.floor(v / 2)} / ${Math.floor(v / 5)}`);
  const setCardField = (fn: (c: RoleCard) => void) => { const next = JSON.parse(JSON.stringify(card)) as RoleCard; fn(next); setCard(next); setDirty(true); };
  const save = async () => { setBusy(true); try { apply(await api.updateCharacterCard(channelId, characterId, { ...head, role_card: card })); toast(tr('Character saved')); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); } };
  const saveLook = async (patch: Partial<typeof look>) => { const next = { ...look, ...patch }; setLook(next); try { apply(await api.updateCharacterAppearance(channelId, characterId, next)); } catch (e: any) { toast(e.message, 'error'); } };
  const pickFile = (slot: 'avatar' | 'portrait' | 'subtitle', subtitle?: string) => { fileFor.current = { slot, subtitle }; fileInput.current?.click(); };
  const onFile = async (f: File | undefined) => { if (!f || !fileFor.current) return; setBusy(true); try { apply(await api.uploadCharacterAsset(channelId, characterId, fileFor.current.slot, f, fileFor.current.subtitle ?? '')); toast(tr('Image uploaded')); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; } };
  const generate = async (slots: string[], subtitles: string[]) => { setBusy(true); try { const r = await api.generateCharacterAssets(channelId, characterId, { slots, subtitles, allow_cloud: true }); apply(r.space); toast(tr('Image generation queued')); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); } };
  const remove = async (assetId: string) => { if (!confirm(tr('Remove this image from the character?'))) return; try { apply(await api.deleteCharacterAsset(channelId, characterId, assetId)); } catch (e: any) { toast(e.message, 'error'); } };
  const pending = space.jobs.filter((j) => j.status === 'pending' || j.status === 'running');
  const canGenerate = editable && look.asset_mode === 'generated' && space.generation_available;
  return (
    <div className="workspace character-space">
      <input ref={fileInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
      <div className="tabs">
        {(['card', 'look', 'background', 'items'] as Tab[]).map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{tr(t === 'card' ? 'Role card' : t === 'look' ? 'Appearance & images' : t === 'background' ? 'Background' : 'Items')}</button>)}
        <span className="grow" />
        {editable && dirty && <button className="primary" onClick={save} disabled={busy}>{tr('Save')}</button>}
        <button className="ghost" onClick={() => openCharacter(null)}>{tr('← back to chat')}</button>
      </div>
      <div className="content">
        <div className="card hero">
          <div>
            <div className="portrait">{space.portrait ? <img src={url(space.portrait)} alt="" /> : <span className="small muted">{tr('No portrait yet')}</span>}</div>
            {editable && <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}><button className="small" onClick={() => pickFile('portrait')}>{tr('Upload portrait')}</button>{look.asset_mode === 'generated' && <button className="small" onClick={() => generate(['portrait'], [])} disabled={!canGenerate || busy}>{tr('Generate portrait')}</button>}{space.portrait && <button className="ghost small" onClick={() => remove(space.portrait!.id)}>{tr('remove')}</button>}</div>}
          </div>
          <div className="col">
            <div className="row">
              <div className="big-avatar">{space.avatar ? <img src={url(space.avatar)} alt="" /> : c.name.slice(0, 1)}</div>
              <div className="col grow">
                {editable ? <input value={head.name} onChange={(e) => { setHead({ ...head, name: e.target.value }); setDirty(true); }} style={{ fontSize: 18, fontWeight: 700 }} /> : <h2 style={{ margin: 0 }}>{c.name}</h2>}
                <div className="row tiny muted"><span className="pill">{c.kind === 'npc' ? tr('NPC') : tr('PC')}</span>{c.player_name && <span>{tr('played by')} {c.player_name}</span>}<span className="pill">{look.asset_mode === 'generated' ? tr('Generated assets') : tr('Uploaded assets')}</span>{space.era && <span>{space.era}</span>}</div>
              </div>
              {editable && (look.asset_mode === 'uploaded' ? <button className="small" onClick={() => pickFile('avatar')}>{tr('Upload avatar')}</button> : <button className="small" onClick={() => generate(['avatar'], [])} disabled={!canGenerate || busy}>{tr('Generate avatar')}</button>)}
            </div>
            <div className="role-card">
              <h4>{tr('Basic information')}</h4>
              <div className="char-grid">
                {(['player', 'occupation', 'age', 'sex', 'residence', 'birthplace'] as const).map((k) => (
                  <div key={k} className="cell"><b>{tr(k === 'player' ? 'Player' : k === 'occupation' ? 'Occupation' : k === 'age' ? 'Age' : k === 'sex' ? 'Sex' : k === 'residence' ? 'Residence' : 'Birthplace')}</b>{editable ? <input style={{ fontSize: 13, fontWeight: 500 }} value={card.basic[k]} onChange={(e) => setCardField((x) => { x.basic[k] = e.target.value; })} /> : <span className="v" style={{ fontSize: 13, fontWeight: 500 }}>{card.basic[k] || '—'}</span>}</div>
                ))}
              </div>
              {editable ? <label className="field" style={{ marginTop: 8 }}><span className="tiny muted">{tr('Speaking style')}</span><input value={head.speaking_style} onChange={(e) => { setHead({ ...head, speaking_style: e.target.value }); setDirty(true); }} /></label> : head.speaking_style && <div className="tiny muted" style={{ marginTop: 6 }}>{tr('Speaking style')}: {head.speaking_style}</div>}
            </div>
          </div>
        </div>

        {tab === 'card' && (
          <div className="card role-card">
            <div className="row"><h4 style={{ margin: '10px 0 6px' }}>{tr('Characteristics')}</h4><span className="grow" />{pointsOn && <span className="pill" title={tr('STR+CON+SIZ+DEX+APP+INT+POW+EDU; Luck apart')}>{tr('Total')} {CHARS.filter((k) => k !== 'LUK').reduce((a, k) => a + (card.characteristics[k] ?? 0), 0)} · LUK {card.characteristics.LUK ?? 0}</span>}</div>
            <div className="char-grid">
              {CHARS.map((k) => <div key={k} className="cell"><b>{k}</b>{editable ? <input inputMode="numeric" value={card.characteristics[k] ?? ''} onChange={(e) => setCardField((x) => { const v = Number(e.target.value); if (e.target.value === '') delete x.characteristics[k]; else if (Number.isFinite(v)) x.characteristics[k] = Math.round(v); })} /> : <span className="v">{card.characteristics[k] ?? '—'}</span>}<span className="halves">{half(card.characteristics[k])}</span></div>)}
            </div>
            <h4>{tr('Derived')}</h4>
            <div className="char-grid">
              {([['hp', 'HP'], ['hp_max', 'HP max'], ['mp', 'MP'], ['mp_max', 'MP max'], ['san', 'SAN'], ['san_max', 'SAN max'], ['mov', 'MOV'], ['build', 'Build']] as const).map(([k, label]) => <div key={k} className="cell"><b>{label}</b>{editable ? <input inputMode="numeric" value={card.derived[k] ?? ''} onChange={(e) => setCardField((x) => { const v = Number(e.target.value); if (e.target.value === '') delete (x.derived as any)[k]; else if (Number.isFinite(v)) (x.derived as any)[k] = Math.round(v); })} /> : <span className="v">{card.derived[k] ?? '—'}</span>}</div>)}
              <div className="cell"><b>DB</b>{editable ? <input value={card.derived.db} onChange={(e) => setCardField((x) => { x.derived.db = e.target.value; })} /> : <span className="v">{card.derived.db || '—'}</span>}</div>
            </div>
            {pointsOn && rules && <PointBuy card={card} rules={rules} editable={!!editable} report={space.points} setCard={setCardField} />}
            {pointsOn && !rules && <div className="tiny muted">{tr('Loading…')}</div>}
            {!pointsOn && <><h4>{tr('Skills')}</h4>
            <div className="skills">
              {Object.keys(card.skills).sort().map((k) => <div key={k} className="skill"><span>{k}</span><span className="grow" />{editable ? <input inputMode="numeric" value={card.skills[k]} onChange={(e) => setCardField((x) => { const v = Number(e.target.value); if (Number.isFinite(v)) x.skills[k] = Math.round(v); })} /> : <b>{card.skills[k]}</b>}<span className="tiny muted">{half(card.skills[k])}</span>{editable && <button className="ghost small" onClick={() => setCardField((x) => { delete x.skills[k]; })}>×</button>}</div>)}
            </div>
            {editable && (
              <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                <input list="coc-skills" placeholder={tr('Add a skill')} value={newSkill} onChange={(e) => setNewSkill(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newSkill.trim()) { setCardField((x) => { x.skills[newSkill.trim()] = x.skills[newSkill.trim()] ?? 0; }); setNewSkill(''); } }} />
                <datalist id="coc-skills">{COC_SKILLS.filter((s) => !(s in card.skills)).map((s) => <option key={s} value={s} />)}</datalist>
                <button className="small" onClick={() => { if (newSkill.trim()) { setCardField((x) => { x.skills[newSkill.trim()] = x.skills[newSkill.trim()] ?? 0; }); setNewSkill(''); } }}>{tr('Add')}</button>
                <span className="tiny muted">{tr('Characteristics, HP/MP/SAN and skills are what .ra, .sc and .st read in chat.')}</span>
              </div>
            )}</>}
            <h4>{tr('Wealth')}</h4>
            <div className="char-grid">
              {(['cash', 'assets', 'spending_level'] as const).map((k) => <div key={k} className="cell"><b>{tr(k === 'cash' ? 'Cash' : k === 'assets' ? 'Assets' : 'Spending level')}</b>{editable ? <input style={{ fontSize: 13, fontWeight: 500 }} value={card.wealth[k]} onChange={(e) => setCardField((x) => { x.wealth[k] = e.target.value; })} /> : <span className="v" style={{ fontSize: 13, fontWeight: 500 }}>{card.wealth[k] || '—'}</span>}</div>)}
            </div>
          </div>
        )}

        {tab === 'look' && (
          <div className="card">
            <h3>{tr('Appearance & images')}</h3>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <span className="small">{tr('Mode')}</span>
              <button className={`small ${look.asset_mode === 'uploaded' ? 'primary' : ''}`} disabled={!editable} onClick={() => saveLook({ asset_mode: 'uploaded' })}>{tr('Uploaded assets')}</button>
              <button className={`small ${look.asset_mode === 'generated' ? 'primary' : ''}`} disabled={!editable} onClick={() => saveLook({ asset_mode: 'generated' })}>{tr('Generated assets')}</button>
              {!space.generation_available && <span className="tiny muted">{tr('Image generation is not configured on this server; uploads still work.')}</span>}
            </div>
            <div className="tiny muted" style={{ marginTop: 6 }}>{tr('In uploaded mode you supply the avatar, the portrait and one image per subtitle (IDLE, SAY, FIGHT, …); the visual novel can only use those subtitles. In generated mode the appearance prompt below drives the image AI, which also takes the campaign\'s era and the current moment of the story into account.')}</div>
            <label className="field" style={{ marginTop: 8 }}><span>{tr('Appearance prompt')}</span><textarea value={look.appearance_prompt} disabled={!editable} onChange={(e) => setLook({ ...look, appearance_prompt: e.target.value })} onBlur={() => editable && look.appearance_prompt !== (c.appearance_prompt ?? '') && saveLook({})} placeholder={tr('e.g. A gaunt woman in her forties, grey wool coat, cropped dark hair, round spectacles, a pistol holster under the coat')} style={{ minHeight: 70 }} /></label>
            <div className="tiny muted">{tr('Era')}: {space.era || '—'}{space.narrative_time ? ` · ${tr('now')}: ${space.narrative_time}` : ''}</div>
            <h4 style={{ marginTop: 12 }}>{tr('Subtitle portraits')}</h4>
            <div className="subtitle-grid">
              {space.subtitles.map((s) => <div key={s.id} className="tile"><img src={url(s)} alt="" /><div className="cap row"><b className="grow">{s.subtitle}</b>{editable && <button className="ghost small" onClick={() => remove(s.id)}>×</button>}</div></div>)}
              {space.subtitles.length === 0 && <div className="small muted">{tr('No subtitle portraits yet.')}</div>}
            </div>
            {editable && look.asset_mode === 'uploaded' && (
              <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                <input list="subtitle-names" value={subtitleName} onChange={(e) => setSubtitleName(e.target.value)} placeholder="IDLE" style={{ width: 120 }} />
                <datalist id="subtitle-names">{DEFAULT_SUBTITLES.map((s) => <option key={s} value={s} />)}</datalist>
                <button className="small" onClick={() => pickFile('subtitle', subtitleName)} disabled={!subtitleName.trim() || busy}>{tr('Upload image for this subtitle')}</button>
              </div>
            )}
            {editable && look.asset_mode === 'generated' && (
              <div className="col" style={{ marginTop: 8 }}>
                <div className="tiny muted">{tr('Pose images use the main portrait as their reference. Generate or upload it first; a batch creates the main portrait before its poses.')}</div>
                <div className="row" style={{ flexWrap: 'wrap' }}>{DEFAULT_SUBTITLES.map((s) => <label key={s} className="tiny"><input type="checkbox" checked={genSubs.includes(s)} onChange={(e) => setGenSubs(e.target.checked ? [...genSubs, s] : genSubs.filter((x) => x !== s))} /> {s}</label>)}</div>
                <div className="row"><button className="primary small" onClick={() => generate(['portrait', 'avatar'], genSubs)} disabled={!canGenerate || busy || !look.appearance_prompt.trim()}>{tr('Generate portrait, avatar and the chosen subtitles')}</button><button className="small" onClick={() => generate([], genSubs)} disabled={!canGenerate || busy || genSubs.length === 0 || !space.portrait}>{tr('Generate the chosen subtitles only')}</button></div>
              </div>
            )}
            {space.jobs.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <h4>{tr('Image jobs')}{pending.length > 0 && <span className="pill ai" style={{ marginLeft: 6 }}>{pending.length} {tr('running')}</span>}</h4>
                {space.jobs.slice(0, 8).map((j) => <div key={j.id} className="row tiny"><span className={`pill ${j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'danger' : ''}`}>{tr(j.status)}</span><span>{j.attach?.slot === 'subtitle' ? j.attach.subtitle : j.attach?.slot ?? j.kind}</span>{j.error && <span className="muted">{j.error}</span>}</div>)}
              </div>
            )}
          </div>
        )}

        {tab === 'background' && (
          <div className="card role-card">
            <h4>{tr('Background story')}</h4>
            {editable ? <textarea value={head.bio} onChange={(e) => { setHead({ ...head, bio: e.target.value }); setDirty(true); }} style={{ width: '100%', minHeight: 120 }} placeholder={tr('Who this character is, where they come from, what they want…')} /> : <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{head.bio || <span className="muted">—</span>}</div>}
            {BACKGROUND.map((k) => (
              <div key={k}><h4>{tr(BG_LABEL[k])}</h4>{editable ? <textarea value={card.background[k]} onChange={(e) => setCardField((x) => { x.background[k] = e.target.value; })} style={{ width: '100%', minHeight: 48 }} /> : <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{card.background[k] || <span className="muted">—</span>}</div>}</div>
            ))}
          </div>
        )}

        {tab === 'items' && (
          <div className="card role-card">
            <h4>{tr('Gear & possessions')}</h4>
            {card.items.length === 0 && <div className="small muted">{tr('Nothing carried yet.')}</div>}
            {card.items.map((it, i) => (
              <div key={i} className="row small" style={{ borderBottom: '1px solid var(--bg-4)', padding: '4px 0' }}>
                {editable ? <><input value={it.name} onChange={(e) => setCardField((x) => { x.items[i].name = e.target.value; })} style={{ width: 180 }} /><input inputMode="numeric" value={it.qty} onChange={(e) => setCardField((x) => { const v = Number(e.target.value); if (Number.isFinite(v)) x.items[i].qty = Math.round(v); })} style={{ width: 50 }} /><input className="grow" value={it.note} onChange={(e) => setCardField((x) => { x.items[i].note = e.target.value; })} /><button className="ghost small" onClick={() => setCardField((x) => { x.items.splice(i, 1); })}>×</button></>
                  : <><b>{it.name}</b>{it.qty !== 1 && <span className="muted">×{it.qty}</span>}<span className="muted grow">{it.note}</span></>}
              </div>
            ))}
            {editable && <div className="row" style={{ marginTop: 8 }}><input placeholder={tr('Item')} value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} /><input className="grow" placeholder={tr('Note')} value={newItem.note} onChange={(e) => setNewItem({ ...newItem, note: e.target.value })} /><button className="small" onClick={() => { if (!newItem.name.trim()) return; setCardField((x) => { x.items.push({ name: newItem.name.trim(), note: newItem.note, qty: 1 }); }); setNewItem({ name: '', note: '' }); }}>{tr('Add')}</button></div>}
          </div>
        )}
      </div>
    </div>
  );
}
