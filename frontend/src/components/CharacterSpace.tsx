import PbtaSheet from './pbta/Sheet';
import { t as tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import type { CardArchive, CharacterSpace as Space, Coc7Rules, DndCard, DndRules, PointsReport, RoleCard } from '../types';
import DndSheet, { EMPTY_DND } from './DndSheet';
import PointBuy from './PointBuy';
import { sessionEpoch } from '../store/session';
import { CachedImg } from './CachedImg';
import CharacterOutfits from './CharacterOutfits';

let rulesPromise: Promise<Coc7Rules> | null = null;
// A failed load is not cached: the next visit tries again.
const loadRules = () => (rulesPromise ??= api.coc7Rules().catch((e) => { rulesPromise = null; throw e; }));
let dndRulesPromise: Promise<DndRules> | null = null;
const loadDndRules = () => (dndRulesPromise ??= api.dndRules().catch((e) => { dndRulesPromise = null; throw e; }));

const CHARS: (keyof RoleCard['characteristics'])[] = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU', 'LUK'];
const BACKGROUND: (keyof RoleCard['background'])[] = ['personal_description', 'ideology', 'significant_people', 'meaningful_locations', 'treasured_possessions', 'traits', 'injuries', 'phobias', 'arcane', 'encounters'];
const BG_LABEL: Record<string, string> = { personal_description: 'Personal description', ideology: 'Ideology / beliefs', significant_people: 'Significant people', meaningful_locations: 'Meaningful locations', treasured_possessions: 'Treasured possessions', traits: 'Traits', injuries: 'Injuries & scars', phobias: 'Phobias & manias', arcane: 'Arcane tomes, spells & artifacts', encounters: 'Encounters with strange entities' };
const COC_SKILLS = ['Accounting', 'Anthropology', 'Appraise', 'Archaeology', 'Art/Craft', 'Charm', 'Climb', 'Credit Rating', 'Cthulhu Mythos', 'Disguise', 'Dodge', 'Drive Auto', 'Electrical Repair', 'Fast Talk', 'Fighting (Brawl)', 'Firearms (Handgun)', 'Firearms (Rifle/Shotgun)', 'First Aid', 'History', 'Intimidate', 'Jump', 'Language (Other)', 'Language (Own)', 'Law', 'Library Use', 'Listen', 'Locksmith', 'Mechanical Repair', 'Medicine', 'Natural World', 'Navigate', 'Occult', 'Operate Heavy Machinery', 'Persuade', 'Pilot', 'Psychoanalysis', 'Psychology', 'Ride', 'Science', 'Sleight of Hand', 'Spot Hidden', 'Stealth', 'Survival', 'Swim', 'Throw', 'Track'];
const DEFAULT_SUBTITLES = ['IDLE', 'SAY', 'HAPPY', 'SAD', 'ANGRY', 'SCARED', 'FIGHT'];

type Tab = 'card' | 'look' | 'background' | 'items';
const half = (v?: number) => (v === undefined ? '' : `${Math.floor(v / 2)} / ${Math.floor(v / 5)}`);
const systemName = (rs?: string) => (rs === 'dnd2024' ? tr('D&D 2024') : rs === 'pbta' ? 'PbtA' : tr('Call of Cthulhu 7e'));

// A former PbtA card in words: the playbook and its numbers, named by the channel's pack when it still has them.
function pbtaSummary(card: { book?: string; stats?: Record<string, number>; resources?: Record<string, number>; conditions?: Record<string, boolean> } | undefined, pack?: { books?: { id: string; name: string }[]; stats?: { id: string; name: string }[]; resources?: { id: string; name: string }[]; conditions?: { id: string; name: string }[] }) {
  if (!card) return '—';
  const name = (list: { id: string; name: string }[] | undefined, id: string) => list?.find((x) => x.id === id)?.name ?? id;
  const parts = [`${tr('Playbook')}: ${card.book ? name(pack?.books, card.book) : '—'}`];
  for (const [k, list] of [['stats', pack?.stats], ['resources', pack?.resources]] as const) {
    const v = card[k]; if (v && Object.keys(v).length) parts.push(Object.entries(v).map(([id, n]) => `${name(list, id)} ${n}`).join(' · '));
  }
  const on = Object.entries(card.conditions ?? {}).filter(([, v]) => v).map(([id]) => name(pack?.conditions, id));
  if (on.length) parts.push(on.join(' · '));
  return parts.join(' — ');
}

// The Call of Cthulhu number part of a card: characteristics, derived values, skills (or point buy) and wealth. Also
// draws a former card's numbers, read-only. A render helper (no state of its own): the skill being added lives in the
// character space.
interface CocNumbersProps { card: RoleCard; editable: boolean; pointsOn: boolean; rules: Coc7Rules | null; report: PointsReport; isKeeper: boolean; setCardField: (fn: (c: RoleCard) => void) => void; newSkill?: string; setNewSkill?: (s: string) => void }
function cocNumbers({ card, editable, pointsOn, rules, report, isKeeper, setCardField, newSkill = '', setNewSkill = () => undefined }: CocNumbersProps) {
  return <>
            <div className="row"><h4 style={{ margin: '10px 0 6px' }}>{tr('Characteristics')}</h4><span className="grow" />{pointsOn && <span className="pill" title={tr('STR+CON+SIZ+DEX+APP+INT+POW+EDU; Luck apart')}>{tr('Total')} {CHARS.filter((k) => k !== 'LUK').reduce((a, k) => a + (card.characteristics[k] ?? 0), 0)} · LUK {card.characteristics.LUK ?? 0}</span>}</div>
            <div className="char-grid">
              {CHARS.map((k) => <div key={k} className="cell"><b>{k}</b>{editable ? <input inputMode="numeric" value={card.characteristics[k] ?? ''} onChange={(e) => setCardField((x) => { const v = Number(e.target.value); if (e.target.value === '') delete x.characteristics[k]; else if (Number.isFinite(v)) x.characteristics[k] = Math.round(v); })} /> : <span className="v">{card.characteristics[k] ?? '—'}</span>}<span className="halves">{half(card.characteristics[k])}</span></div>)}
            </div>
            <h4>{tr('Derived')}</h4>
            <div className="char-grid">
              {([['hp', 'HP'], ['hp_max', 'HP max'], ['mp', 'MP'], ['mp_max', 'MP max'], ['san', 'SAN'], ['san_max', 'SAN max'], ['mov', 'MOV'], ['build', 'Build']] as const).map(([k, label]) => <div key={k} className="cell"><b>{label}</b>{editable ? <input inputMode="numeric" value={card.derived[k] ?? ''} onChange={(e) => setCardField((x) => { const v = Number(e.target.value); if (e.target.value === '') delete (x.derived as any)[k]; else if (Number.isFinite(v)) (x.derived as any)[k] = Math.round(v); })} /> : <span className="v">{card.derived[k] ?? '—'}</span>}</div>)}
              <div className="cell"><b>DB</b>{editable ? <input value={card.derived.db} onChange={(e) => setCardField((x) => { x.derived.db = e.target.value; })} /> : <span className="v">{card.derived.db || '—'}</span>}</div>
            </div>
            {pointsOn && rules && <PointBuy card={card} rules={rules} editable={!!editable} isKeeper={isKeeper} report={report} setCard={setCardField} />}
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
  </>;
}

// The character space: avatar, main portrait, basic information, the COC7-styled role card, background and items.
// The GM and the character's actor edit; everyone else reads. Images come from uploads or from image AI.
export default function CharacterSpace({ characterId }: { characterId: string }) {
  const { channelId, characters, openCharacter, channel } = useNav();
  const toast = useUi((s) => s.toast);
  const [space, setSpace] = useState<Space | null>(null);
  const [card, setCard] = useState<RoleCard | null>(null);
  const [head, setHead] = useState({ name: '', speaking_style: '', bio: '' });
  const [dirty, setDirtyState] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  const revision = useRef(0);
  const responseEpoch = useRef(0);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const setDirty = (value: boolean) => { dirtyRef.current = value; if (value) { ++revision.current; setSaveError(''); } setDirtyState(value); };
  const validResponse = () => { const epoch = sessionEpoch(), response = responseEpoch.current; return () => mounted.current && epoch === sessionEpoch() && response === responseEpoch.current; };
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
  const apply = (s: Space, savedRevision?: number) => {
    setSpace(s);
    // Image responses and polls contain the last saved card, not the local draft.
    // A save acknowledgement also must not erase edits made while it was in flight.
    if (!dirtyRef.current || savedRevision === revision.current) {
      setCard(s.character.role_card);
      setHead({ name: s.character.name, speaking_style: s.character.speaking_style, bio: s.character.bio ?? '' });
      setDirty(false);
    }
    setLook({ asset_mode: s.character.asset_mode ?? 'uploaded', appearance_prompt: s.character.appearance_prompt ?? '' });
  };
  const refresh = async () => {
    if (!channelId) return;
    const valid = validResponse();
    try { const s = await api.characterSpace(channelId, characterId); if (valid()) apply(s); }
    catch (e: any) { if (valid() && !space) toast(e.message, 'error'); }
  };
  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; ++responseEpoch.current; }; }, [channelId, characterId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const pointsOn = !!space?.points?.enabled;
  const dnd = space?.rule_system === 'dnd2024';
  const [dndRules, setDndRules] = useState<DndRules | null>(null);
  useEffect(() => { if (pointsOn && !dnd && !rules) loadRules().then(setRules).catch((e) => toast(e.message, 'error')); }, [pointsOn, dnd]);
  const needsDnd = dnd || !!space?.card_archives?.some((x) => x.rule_system === 'dnd2024');
  useEffect(() => { if (needsDnd && !dndRules) loadDndRules().then(setDndRules).catch((e) => toast(e.message, 'error')); }, [needsDnd]);
  // Live updates (generation finished, another editor saved) arrive as character.updated → characters refresh.
  const version = characters.find((c) => c.id === characterId);
  useEffect(() => { if (space) refresh(); }, [version?.avatar_asset_id, version?.portrait_asset_id, version?.asset_mode, version?.outfit_id]);
  useEffect(() => { if (!space || !space.jobs.some((j) => j.status === 'pending' || j.status === 'running')) return; const t = setTimeout(refresh, 2500); return () => clearTimeout(t); }, [space]);
  if (!channelId || !space || !card) return <div className="workspace"><div className="content muted">{tr("Loading…")}</div></div>;
  const c = space.character; const editable = c.editable;
  const url = (a: { id: string; version: number } | null) => (a ? api.mediaUrl(channelId, a.id, a.version) : '');
  const setCardField = (fn: (c: RoleCard) => void) => { const next = JSON.parse(JSON.stringify(card)) as RoleCard; fn(next); setCard(next); setDirty(true); };
  const mutate = async (request: () => Promise<Space>, message?: string, isCardSave = false) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setSaving(isCardSave);
    ++responseEpoch.current; // Drop polls started before this write.
    const valid = validResponse(), savedRevision = revision.current;
    if (isCardSave) setSaveError('');
    try {
      const result = await request();
      if (valid()) { ++responseEpoch.current; apply(result, isCardSave ? savedRevision : undefined); if (message) toast(message); }
    } catch (e: any) {
      if (valid()) { if (isCardSave) setSaveError(e.message); toast(e.message, 'error'); }
    } finally { busyRef.current = false; if (mounted.current) { setBusy(false); setSaving(false); } }
  };
  const save = () => mutate(() => api.updateCharacterCard(channelId, characterId, { ...head, rule_system: space.rule_system, pack_revision: space.pbta_rules?.revision, role_card: card }), tr('Character saved'), true);
  // D&D: the build is part of the card; live values (Hit Points, slots left, death saves) are written straight away.
  const setDnd = (fn: (d: DndCard) => void) => setCardField((x) => { x.dnd = x.dnd ?? JSON.parse(JSON.stringify(EMPTY_DND)); fn(x.dnd!); });
  const setLive = (set: Record<string, number>) => mutate(async () => { await api.updateAttributes(channelId, characterId, { set }); return api.characterSpace(channelId, characterId); });
  const saveLook = async (patch: Partial<typeof look>) => { if (busyRef.current) return; const next = { ...look, ...patch }; setLook(next); await mutate(() => api.updateCharacterAppearance(channelId, characterId, next)); };
  const pickFile = (slot: 'avatar' | 'portrait' | 'subtitle', subtitle?: string) => { fileFor.current = { slot, subtitle }; fileInput.current?.click(); };
  const onFile = async (f: File | undefined) => { if (!f || !fileFor.current) return; const target = fileFor.current; await mutate(() => api.uploadCharacterAsset(channelId, characterId, target.slot, f, target.subtitle ?? ''), tr('Image uploaded')); if (fileInput.current) fileInput.current.value = ''; };
  const generate = (slots: string[], subtitles: string[]) => mutate(async () => (await api.generateCharacterAssets(channelId, characterId, { slots, subtitles, allow_cloud: true })).space, tr('Image generation queued'));
  const remove = async (assetId: string) => { if (!confirm(tr('Remove this image from the character?'))) return; await mutate(() => api.deleteCharacterAsset(channelId, characterId, assetId)); };
  const back = () => { if (!dirtyRef.current || confirm(tr('Leave without saving character changes?'))) openCharacter(null); };
  // Rule transitions: numbers of earlier rules, read-only, and the rebuild the channel's switch asked for.
  const archives = space.card_archives ?? [];
  const restorable = archives.some((x) => x.rule_system === space.rule_system);
  const waive = () => mutate(() => api.updateCharacterCard(channelId, characterId, { ...head, rule_system: space.rule_system, pack_revision: space.pbta_rules?.revision, role_card: card, card_rebuilt: true }), tr('Marked as rebuilt'), true);
  const restore = async (x: CardArchive) => {
    if (!confirm(tr('Use this {system} card again? The numbers on the card now are set aside under Former cards.', { system: systemName(x.rule_system) }))) return;
    await mutate(() => api.restoreCardArchive(channelId, characterId, x.id), tr('Former card restored'));
  };
  const pending = space.jobs.filter((j) => j.status === 'pending' || j.status === 'running');
  const canGenerate = editable && look.asset_mode === 'generated' && space.generation_available;
  return (
    <div className="workspace character-space">
      <input ref={fileInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
      <div className="tabs">
        {(['card', 'look', 'background', 'items'] as Tab[]).map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{tr(t === 'card' ? 'Role card' : t === 'look' ? 'Appearance & images' : t === 'background' ? 'Background' : 'Items')}</button>)}
        <span className="grow" />
        <button className="ghost" onClick={back}>{tr('← back to chat')}</button>
      </div>
      <div className="content">
        <div className="card hero">
          <div>
            <div className="portrait">{space.portrait ? <CachedImg src={url(space.portrait)} hash={space.portrait.hash} alt="" /> : <span className="small muted">{tr('No portrait yet')}</span>}</div>
            {editable && <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}><button className="small" onClick={() => pickFile('portrait')}>{tr('Upload portrait')}</button>{look.asset_mode === 'generated' && <button className="small" onClick={() => generate(['portrait'], [])} disabled={!canGenerate || busy}>{tr('Generate portrait')}</button>}{space.portrait && <button className="ghost small" onClick={() => remove(space.portrait!.id)}>{tr('remove')}</button>}</div>}
          </div>
          <div className="col">
            <div className="row">
              <div className="big-avatar">{space.avatar ? <CachedImg src={url(space.avatar)} hash={space.avatar.hash} alt="" /> : c.name.slice(0, 1)}</div>
              <div className="col grow">
                {editable ? <input value={head.name} onChange={(e) => { setHead({ ...head, name: e.target.value }); setDirty(true); }} style={{ fontSize: 18, fontWeight: 700 }} /> : <h2 style={{ margin: 0 }}>{c.name}</h2>}
                <div className="row tiny muted"><span className="pill">{c.kind === 'npc' ? tr('NPC') : tr('PC')}</span>{c.player_name && <span>{tr('played by')} {c.player_name}</span>}<span className="pill">{look.asset_mode === 'generated' ? tr('Generated assets') : tr('Uploaded assets')}</span>{space.era && <span>{space.era}</span>}{(space.outfits?.length ?? 0) > 0 && <label className="row" style={{ gap: 4 }}>{tr('Wearing')}<select value={c.outfit_id ?? ''} disabled={!editable || busy} onChange={(e) => mutate(() => api.wearOutfit(channelId, characterId, e.target.value || null))}><option value="">{tr('Base look')}</option>{space.outfits!.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}</div>
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
            {c.card_pending && (
              <div className="rule-rebuild" role="status" data-testid="rule-rebuild">
                <b>{editable ? tr("Rebuild this character's numbers for {system}", { system: systemName(space.rule_system) }) : tr("This character's numbers are being rebuilt for {system}", { system: systemName(space.rule_system) })}</b>
                <div className="tiny">{tr('The rules of this channel changed. The story part of the card (name, basic information, background, items and look) is kept; the numbers of the earlier rules are kept read-only under Former cards.')}</div>
                {editable && <div className="tiny">{space.rule_system === 'pbta' ? tr('Choose a playbook and save to finish the rebuild.') : dnd ? tr('Choose a class and save to finish the rebuild.') : tr('Fill in the eight characteristics and save to finish the rebuild.')}{restorable ? ' ' + tr('A former card of these rules is below: you can use it again instead.') : ''}</div>}
                {channel?.my_role === 'gm' && <div className="row" style={{ marginTop: 6 }}><button className="small" disabled={busy} onClick={waive} title={tr('For a character that will not roll under these rules, or whose card is kept elsewhere')}>{tr('Mark as rebuilt')}</button></div>}
              </div>
            )}
            {space.rule_system === 'pbta' && space.pbta_rules ? <PbtaSheet pack={space.pbta_rules.pack} sheet={card.pbta} editable={!!editable} dirty={dirty} characterId={characterId} change={(v) => setCardField((x) => { x.pbta = v; })} />
              : dnd ? (dndRules ? <DndSheet card={card.dnd ?? EMPTY_DND} rules={dndRules} editable={!!editable} isGm={channel?.my_role === 'gm'} pointsOn={pointsOn} report={space.points} attrs={space.attrs} setCard={setDnd} setLive={setLive} /> : <div className="tiny muted">{tr('Loading…')}</div>)
              : cocNumbers({ card, editable: !!editable, pointsOn, rules, report: space.points, isKeeper: channel?.my_role === 'gm', setCardField, newSkill, setNewSkill })}
            {archives.length > 0 && (
              <div className="former-cards" data-testid="former-cards">
                <h4>{tr('Former cards')}</h4>
                <div className="tiny muted">{tr('Numbers from earlier rules of this channel, kept read-only. The story part stayed on the card above.')}</div>
                {archives.map((x, n) => (
                  <details key={x.id} className="former-card" open={n === 0 && !!c.card_pending}>
                    <summary><b>{systemName(x.rule_system)}</b> <span className="tiny muted">{new Date(x.archived_at).toLocaleDateString()}{x.archived_by_name ? ` · ${x.archived_by_name}` : ''} · {x.reason === 'restore' ? tr('set aside when a former card came back') : tr('set aside when the rules changed')}</span></summary>
                    {x.rule_system === 'pbta'
                      ? <div className="small">{pbtaSummary(x.numbers.pbta, space.pbta_rules?.pack)}</div>
                      : x.rule_system === 'dnd2024'
                      ? (dndRules ? <DndSheet card={{ ...EMPTY_DND, ...(x.numbers.dnd ?? {}) }} rules={dndRules} editable={false} isGm={false} pointsOn={false} report={{ enabled: false }} attrs={x.attrs} setCard={() => undefined} setLive={() => undefined} /> : <div className="tiny muted">{tr('Loading…')}</div>)
                      : cocNumbers({ card: { ...card, ...x.numbers } as RoleCard, editable: false, pointsOn: false, rules: null, report: { enabled: false }, isKeeper: false, setCardField: () => undefined })}
                    {Object.keys(x.attrs ?? {}).length > 0 && <details className="tiny muted" style={{ marginTop: 6 }}><summary>{tr('Dice values')}</summary>{Object.entries(x.attrs).map(([k, v]) => `${k} ${v}`).join(' · ')}</details>}
                    {editable && x.rule_system === space.rule_system && <div className="row" style={{ marginTop: 6 }}><button className="small" disabled={busy || dirty} title={dirty ? tr('Save or discard your changes first') : undefined} onClick={() => restore(x)}>{tr('Use this card again')}</button></div>}
                  </details>
                ))}
              </div>
            )}
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
            <div className="tiny muted" style={{ marginTop: 6 }}>{tr("In uploaded mode you supply the avatar, the portrait and one image per subtitle (IDLE, SAY, FIGHT, …); the visual novel can only use those subtitles. In generated mode the appearance prompt below drives the image AI, which also takes the campaign's era and the current moment of the story into account.")}</div>
            <label className="field" style={{ marginTop: 8 }}><span>{tr('Appearance prompt')}</span><textarea value={look.appearance_prompt} disabled={!editable} onChange={(e) => setLook({ ...look, appearance_prompt: e.target.value })} onBlur={() => editable && look.appearance_prompt !== (c.appearance_prompt ?? '') && saveLook({})} placeholder={tr('e.g. A gaunt woman in her forties, grey wool coat, cropped dark hair, round spectacles, a pistol holster under the coat')} style={{ minHeight: 70 }} /></label>
            <div className="tiny muted">{tr('Era')}: {space.era || '—'}{space.narrative_time ? ` · ${tr('now')}: ${space.narrative_time}` : ''}</div>
            <h4 style={{ marginTop: 12 }}>{tr('Subtitle portraits')}</h4>
            <div className="subtitle-grid">
              {space.subtitles.map((s) => <div key={s.id} className="tile"><CachedImg src={url(s)} hash={s.hash} alt="" /><div className="cap row"><b className="grow">{s.subtitle}</b>{editable && <button className="ghost small" onClick={() => remove(s.id)}>×</button>}</div></div>)}
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
            {(look.asset_mode === 'generated' || (space.outfits?.length ?? 0) > 0) && (
              <CharacterOutfits channelId={channelId} characterId={characterId} space={space} editable={!!editable} busy={busy} canGenerate={canGenerate} subtitles={genSubs} mutate={mutate} />
            )}
            {space.jobs.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <h4>{tr('Image jobs')}{pending.length > 0 && <span className="pill ai" style={{ marginLeft: 6 }}>{pending.length} {tr('running')}</span>}</h4>
                {space.jobs.slice(0, 8).map((j) => <div key={j.id} className="row tiny"><span className={`pill ${j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'danger' : ''}`}>{tr(j.status)}</span><span>{j.attach?.outfit_id ? `${space.outfits?.find((o) => o.id === j.attach!.outfit_id)?.name ?? tr('Outfit')} · ` : ''}{j.attach?.slot === 'subtitle' ? j.attach.subtitle : j.attach?.slot ?? j.kind}</span>{j.error && <span className="muted">{j.error}</span>}</div>)}
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
      {editable && <div className="character-save-bar">
        <div className="grow" role="status" aria-live="polite">
          <span>{saving ? tr('Saving…') : dirty ? tr('Unsaved character changes') : tr('All character changes saved')}</span>
          {saveError && <div role="alert" className="small" style={{ color: 'var(--danger)' }}>{saveError}</div>}
        </div>
        <button className="primary" onClick={save} disabled={busy || !dirty}>{saving ? tr('Saving…') : tr('Save')}</button>
      </div>}
    </div>
  );
}
