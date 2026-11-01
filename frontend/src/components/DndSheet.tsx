import { useMemo } from 'react';
import { t as tr, useLocale } from '../i18n';
import type { DndAbility, DndCard, DndRules, PointsReport } from '../types';

// The D&D 2024 role card (SRD 5.2): the build the GM and the player edit (class, species, background, ability scores,
// proficiencies, armor, spell slots) and the live values the dice change in play (Hit Points, spell slots left, Death
// Saving Throws). The build is saved with the card; live values are written at once, like .st in chat.
export const EMPTY_DND: DndCard = {
  class: '', subclass: '', species: '', background: '', level: 1, method: 'point_buy',
  base: { STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 }, increases: {}, improvements: {},
  saves: [], skills: {}, ac: 10, hp_max: 0, speed: 30, initiative: 0, hit_dice: '', spellcasting_ability: '', slots: {}, features: '', spells: '',
};
const ABILITIES: DndAbility[] = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
export const modifier = (score: number) => Math.floor((score - 10) / 2);
export const proficiencyBonus = (level: number) => 2 + Math.floor((Math.min(20, Math.max(1, level)) - 1) / 4);
const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
export function finalScores(d: DndCard): Record<DndAbility, number> {
  const out = {} as Record<DndAbility, number>;
  for (const a of ABILITIES) out[a] = Math.min(30, (d.base[a] ?? 10) + (d.increases[a] ?? 0) + (d.improvements[a] ?? 0));
  return out;
}
export function pointBuySpent(d: DndCard, rules: DndRules): number {
  return ABILITIES.reduce((sum, a) => sum + (rules.point_buy.costs[String(d.base[a] ?? 8)] ?? 0), 0);
}
// Slots per long rest for a class at a level, from the SRD tables: {spell level: count}.
export function slotsFor(rules: DndRules, className: string, level: number): Record<string, number> {
  const c = rules.classes.find((x) => x.name === className);
  const i = Math.min(20, Math.max(1, level)) - 1;
  if (!c || c.caster === 'none') return {};
  if (c.caster === 'pact') { const p = rules.slots.pact[i]; return { [String(p.level)]: p.slots }; }
  const row = rules.slots[c.caster][i] ?? [];
  return Object.fromEntries(row.map((n, k) => [String(k + 1), n]));
}

type Props = {
  card: DndCard; rules: DndRules; editable: boolean; isGm: boolean; pointsOn: boolean; report: PointsReport;
  attrs: Record<string, number>;
  setCard: (fn: (d: DndCard) => void) => void;
  setLive: (set: Record<string, number>) => void;
};

export default function DndSheet({ card: d, rules, editable, isGm, pointsOn, report, attrs, setCard, setLive }: Props) {
  const lang = useLocale((s) => s.language);
  const nameOf = (key: string) => rules.names[key]?.[lang] ?? rules.names[key]?.en ?? key;
  const local = (x: { name: string; names: Record<string, string> }) => x.names[lang] ?? x.name;
  const scores = finalScores(d);
  const pb = proficiencyBonus(d.level);
  const cls = rules.classes.find((c) => c.name === d.class);
  const species = rules.species.find((s) => s.name === d.species);
  const background = rules.backgrounds.find((b) => b.name === d.background);
  const spent = pointBuySpent(d, rules);
  const improvementsOpen = !pointsOn || isGm;   // later improvements are the GM's to grant under point buy
  const live = (key: string, fallback = 0) => attrs[key] ?? fallback;
  const num = (v: string) => (v === '' || !Number.isFinite(Number(v)) ? 0 : Math.round(Number(v)));
  const skillSources = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const s of background?.skills ?? []) (m[s] ??= []).push(tr('character background'));
    for (const s of cls?.skills.length ? cls.skills : rules.skills.map((x) => x.name)) if (cls) (m[s] ??= []).push(tr('class'));
    for (const s of species?.extra_skills ? (species.skill_from.length ? species.skill_from : []) : []) (m[s] ??= []).push(tr('species'));
    return m;
  }, [cls, background, species, rules]);
  const pickClass = (name: string) => setCard((x) => {
    x.class = name;
    const c = rules.classes.find((k) => k.name === name);
    if (c) { x.saves = [...c.saves]; x.hit_dice = `${x.level}d${c.hit_die}`; if (c.caster === 'none') x.spellcasting_ability = ''; }
  });
  const pickSpecies = (name: string) => setCard((x) => { x.species = name; const s = rules.species.find((k) => k.name === name); if (s) x.speed = s.speed; });
  const pickBackground = (name: string) => setCard((x) => {
    const old = rules.backgrounds.find((b) => b.name === x.background);
    for (const s of old?.skills ?? []) if (x.skills[s] === 1) delete x.skills[s];
    x.background = name; x.increases = {};
    for (const s of rules.backgrounds.find((b) => b.name === name)?.skills ?? []) x.skills[s] = Math.max(1, x.skills[s] ?? 0);
  });
  // Level 1: the hit die's maximum; later levels: its average (rounded up), each plus the CON modifier.
  const suggestedHp = cls ? cls.hit_die + modifier(scores.CON) + (d.level - 1) * (cls.hit_die / 2 + 1 + modifier(scores.CON)) : 0;
  const castMod = d.spellcasting_ability ? modifier(scores[d.spellcasting_ability]) : 0;
  const select = (value: string, options: { value: string; label: string }[], onChange: (v: string) => void, custom = true) => (
    <select value={value} disabled={!editable} onChange={(e) => onChange(e.target.value)}>
      <option value="">{tr('— choose —')}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {custom && value && !options.some((o) => o.value === value) && <option value={value}>{value}</option>}
    </select>
  );

  return (
    <div className="dnd-sheet">
      <div className="char-grid">
        <div className="cell"><b>{tr('Class')}</b>{select(d.class, rules.classes.map((c) => ({ value: c.name, label: local(c) })), pickClass)}</div>
        <div className="cell"><b>{tr('Subclass')}</b>{editable ? <input value={d.subclass} onChange={(e) => setCard((x) => { x.subclass = e.target.value; })} /> : <span className="v">{d.subclass || '—'}</span>}</div>
        <div className="cell"><b>{tr('Level')}</b>{editable ? <input inputMode="numeric" value={d.level} onChange={(e) => setCard((x) => { x.level = Math.min(20, Math.max(1, num(e.target.value) || 1)); })} /> : <span className="v">{d.level}</span>}</div>
        <div className="cell"><b>{tr('Species')}</b>{select(d.species, rules.species.map((s) => ({ value: s.name, label: local(s) })), pickSpecies)}</div>
        <div className="cell"><b>{tr('Character background')}</b>{select(d.background, rules.backgrounds.map((b) => ({ value: b.name, label: local(b) })), pickBackground)}</div>
        <div className="cell"><b>{tr('Proficiency Bonus')}</b><span className="v">{signed(pb)}</span></div>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <h4 style={{ margin: 0 }}>{tr('Ability scores')}</h4><span className="grow" />
        {editable && <select value={d.method} onChange={(e) => setCard((x) => { x.method = e.target.value as DndCard['method']; })}>
          <option value="point_buy">{tr('Point buy (27 points)')}</option>
          <option value="standard_array">{tr('Standard array (15, 14, 13, 12, 10, 8)')}</option>
          <option value="manual" disabled={pointsOn}>{tr('Rolled or entered')}</option>
        </select>}
        {d.method === 'point_buy' && <span className={`pill ${spent > rules.point_buy.budget ? 'danger' : ''}`}>{tr('{spent} / {budget} points', { spent, budget: rules.point_buy.budget })}</span>}
      </div>
      <table className="simple dnd-abilities"><thead><tr>
        <th>{tr('Ability')}</th><th>{tr('Base')}</th><th title={background ? background.abilities.map(nameOf).join(', ') : ''}>{tr('Character background')}</th><th>{tr('Later')}</th><th>{tr('Score')}</th><th>{tr('Modifier')}</th><th>{tr('Saving Throw')}</th>
      </tr></thead><tbody>
        {ABILITIES.map((a) => {
          const save = d.saves.includes(a);
          const canRaise = !background || background.abilities.includes(a);
          return (
            <tr key={a}>
              <td><b>{nameOf(a)}</b> <span className="tiny muted">{a}</span></td>
              <td>{!editable ? d.base[a] ?? 10 : d.method === 'standard_array'
                ? <select value={d.base[a] ?? ''} onChange={(e) => setCard((x) => { x.base[a] = num(e.target.value); })}><option value="">—</option>{rules.standard_array.map((v, i) => <option key={i} value={v}>{v}</option>)}</select>
                : <input inputMode="numeric" style={{ width: 52 }} value={d.base[a] ?? ''} onChange={(e) => setCard((x) => { x.base[a] = num(e.target.value); })} />}</td>
              <td>{editable ? <select value={d.increases[a] ?? 0} disabled={!canRaise} onChange={(e) => setCard((x) => { const v = num(e.target.value); if (v) x.increases[a] = v; else delete x.increases[a]; })}>
                {[0, 1, 2].map((v) => <option key={v} value={v}>{v ? `+${v}` : '—'}</option>)}</select> : d.increases[a] ? `+${d.increases[a]}` : '—'}</td>
              <td title={tr('Ability Score Improvements and feats after level 1')}>{editable && improvementsOpen ? <input inputMode="numeric" style={{ width: 44 }} value={d.improvements[a] ?? 0} onChange={(e) => setCard((x) => { const v = num(e.target.value); if (v) x.improvements[a] = v; else delete x.improvements[a]; })} /> : d.improvements[a] ? `+${d.improvements[a]}` : '—'}</td>
              <td><b>{scores[a]}</b></td>
              <td>{signed(modifier(scores[a]))}</td>
              <td><label className="row tiny"><input type="checkbox" checked={save} disabled={!editable} onChange={(e) => setCard((x) => { x.saves = e.target.checked ? [...x.saves, a] : x.saves.filter((s) => s !== a); })} />{signed(modifier(scores[a]) + (save ? pb : 0))}</label></td>
            </tr>
          );
        })}
      </tbody></table>
      {background && <div className="tiny muted">{tr('{background}: +2 and +1, or +1 to each of {abilities} (at most 20).', { background: local(background), abilities: background.abilities.map(nameOf).join(', ') })}</div>}
      {pointsOn && (report.violations?.length ?? 0) > 0 && <ul className="tiny" style={{ color: 'var(--danger)', margin: '6px 0' }}>{report.violations!.map((v, i) => <li key={i}>{v.message}</li>)}</ul>}

      <h4>{tr('Skills')}</h4>
      {cls && <div className="tiny muted">{tr('{class}: choose {n} from the marked skills; the background adds its two.', { class: local(cls), n: cls.skill_count })}</div>}
      <div className="skills dnd-skills">
        {rules.skills.map(({ name, ability }) => {
          const p = d.skills[name] ?? 0;
          const bonus = modifier(scores[ability]) + p * pb;
          return (
            <div key={name} className="skill">
              <span>{nameOf(name)} <span className="tiny muted">{ability}</span>{skillSources[name] && <span className="tiny muted" title={skillSources[name].join(', ')}> •</span>}</span><span className="grow" />
              {editable ? <select value={p} onChange={(e) => setCard((x) => { const v = num(e.target.value); if (v) x.skills[name] = v; else delete x.skills[name]; })}>
                <option value={0}>—</option><option value={1}>{tr('Proficient')}</option><option value={2}>{tr('Expertise')}</option></select>
                : p ? <span className="tiny">{p === 2 ? tr('Expertise') : tr('Proficient')}</span> : null}
              <b style={{ minWidth: 30, textAlign: 'right' }}>{signed(bonus)}</b>
            </div>
          );
        })}
      </div>

      <h4>{tr('Combat')}</h4>
      <div className="char-grid">
        {([['ac', 'Armor Class'], ['speed', 'Speed'], ['initiative', 'Initiative bonus']] as const).map(([k, label]) => (
          <div key={k} className="cell"><b>{tr(label)}</b>{editable ? <input inputMode="numeric" value={d[k]} onChange={(e) => setCard((x) => { x[k] = num(e.target.value); })} /> : <span className="v">{d[k]}</span>}</div>
        ))}
        <div className="cell"><b>{tr('Hit Point maximum')}</b>{editable ? <span className="row" style={{ gap: 4 }}><input inputMode="numeric" value={d.hp_max} onChange={(e) => setCard((x) => { x.hp_max = num(e.target.value); })} />{cls && suggestedHp > 0 && suggestedHp !== d.hp_max && <button className="ghost small" title={tr('Hit die maximum at level 1, then its average per level, each plus the CON modifier')} onClick={() => setCard((x) => { x.hp_max = Math.max(1, Math.floor(suggestedHp)); })}>{Math.floor(suggestedHp)}</button>}</span> : <span className="v">{d.hp_max}</span>}</div>
        <div className="cell"><b>{tr('Hit Dice')}</b>{editable ? <input value={d.hit_dice} onChange={(e) => setCard((x) => { x.hit_dice = e.target.value; })} /> : <span className="v">{d.hit_dice || '—'}</span>}</div>
        <div className="cell"><b>{tr('Initiative')}</b><span className="v">{signed(modifier(scores.DEX) + d.initiative)}</span></div>
      </div>
      <div className="row dnd-live" style={{ marginTop: 8, gap: 12, flexWrap: 'wrap' }}>
        <label className="row small">{tr('Hit Points')} <input inputMode="numeric" style={{ width: 56 }} disabled={!editable} defaultValue={live('HP', d.hp_max)} key={`hp-${live('HP', d.hp_max)}`} onBlur={(e) => { const v = num(e.target.value); if (v !== live('HP', d.hp_max)) setLive({ HP: v }); }} /> / {d.hp_max}</label>
        <label className="row small">{tr('Temporary Hit Points')} <input inputMode="numeric" style={{ width: 48 }} disabled={!editable} defaultValue={live('Temp HP')} key={`thp-${live('Temp HP')}`} onBlur={(e) => { const v = num(e.target.value); if (v !== live('Temp HP')) setLive({ 'Temp HP': v }); }} /></label>
        <span className="small">{tr('Death Saving Throws')}: ✓ {live('Death Successes')} · ✗ {live('Death Failures')}</span>
        {editable && (live('Death Successes') || live('Death Failures')) ? <button className="ghost small" onClick={() => setLive({ 'Death Successes': 0, 'Death Failures': 0 })}>{tr('Reset')}</button> : null}
      </div>

      <h4>{tr('Spellcasting')}</h4>
      <div className="char-grid">
        <div className="cell"><b>{tr('Spellcasting ability')}</b>{editable ? <select value={d.spellcasting_ability} onChange={(e) => setCard((x) => { x.spellcasting_ability = e.target.value as DndCard['spellcasting_ability']; })}><option value="">—</option>{ABILITIES.map((a) => <option key={a} value={a}>{nameOf(a)}</option>)}</select> : <span className="v">{d.spellcasting_ability ? nameOf(d.spellcasting_ability) : '—'}</span>}</div>
        {d.spellcasting_ability && <><div className="cell"><b>{tr('Spell save DC')}</b><span className="v">{8 + pb + castMod}</span></div><div className="cell"><b>{tr('Spell attack')}</b><span className="v">{signed(pb + castMod)}</span></div></>}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((lv) => {
          const max = d.slots[String(lv)] ?? 0;
          if (!editable && !max) return null;
          return (
            <span key={lv} className="pill dnd-slot" title={tr('Level {level} spell slots: left / per Long Rest', { level: lv })}>
              {lv}: {max ? `${live(`Slot ${lv}`, max)}/` : ''}{editable ? <input inputMode="numeric" style={{ width: 28 }} value={max || ''} placeholder="0" onChange={(e) => setCard((x) => { const v = Math.min(9, num(e.target.value)); if (v) x.slots[String(lv)] = v; else delete x.slots[String(lv)]; })} /> : max}
            </span>
          );
        })}
        {editable && cls && cls.caster !== 'none' && <button className="ghost small" onClick={() => setCard((x) => { x.slots = slotsFor(rules, x.class, x.level); })}>{tr('Fill from class and level')}</button>}
        {editable && <button className="ghost small" onClick={() => { const set: Record<string, number> = {}; for (const [k, v] of Object.entries(d.slots)) set[`Slot ${k}`] = v; setLive(set); }}>{tr('Long Rest')}</button>}
      </div>
      <div className="char-grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 8 }}>
        <label className="field"><span>{tr('Features and feats')}</span>{editable ? <textarea rows={4} value={d.features} onChange={(e) => setCard((x) => { x.features = e.target.value; })} /> : <div className="v pre">{d.features || '—'}</div>}</label>
        <label className="field"><span>{tr('Spells')}</span>{editable ? <textarea rows={4} value={d.spells} onChange={(e) => setCard((x) => { x.spells = e.target.value; })} /> : <div className="v pre">{d.spells || '—'}</div>}</label>
      </div>
      <div className="tiny muted" style={{ marginTop: 6 }}>{tr('Scores, proficiencies, AC, Hit Points and spell slots are what .rc, .ri, .ds and .ss read in chat.')} {tr('Rules from the System Reference Document 5.2, CC-BY-4.0.')}</div>
    </div>
  );
}
