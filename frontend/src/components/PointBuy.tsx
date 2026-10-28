import { t as tr } from '../i18n';
import { useMemo, useState } from 'react';
import type { Coc7Career, Coc7Rules, PointsReport, RoleCard, SkillPoints } from '../types';

// Point-buy mode of the role card (server feature coc7_points). The player picks a career from the built-in list,
// resolves its option groups and free specialties, then spends career points on those skills and hobby points on
// any skill. Totals here are previews; the server recomputes them on save and refuses a card that breaks a limit.

const SPECIAL_BASE: Record<string, Record<string, number>> = {
  Fighting: { brawl: 25, axe: 15, chainsaw: 10, flail: 10, garrote: 15, spear: 20, sword: 20, whip: 5 },
  Firearms: { handgun: 20, 'rifle/shotgun': 25, rifle: 25, shotgun: 25, bow: 15, smg: 15, flamethrower: 10, 'heavy weapons': 10, 'machine gun': 10 },
};
export function familyOf(key: string, rules: Coc7Rules): string {
  const k = key.trim();
  if (rules.skills.some((s) => s.name === k)) return k === 'Fighting (Brawl)' ? 'Fighting' : k.startsWith('Firearms (') ? 'Firearms' : k;
  // The specialisation is the LAST parenthesised part: "Language (Other) (Latin)" belongs to "Language (Other)".
  const m = k.match(/^(.*)[(（][^()（）]*[)）]?\s*$/);
  if (!m) return k;
  const fam = m[1].trim();
  return rules.families.some((f) => f.name === fam) ? fam : k;
}
function specOf(key: string): string { const m = key.trim().match(/[(（]([^()（）]*)[)）]?\s*$/); return m ? m[1].trim() : ''; }
export function baseOf(key: string, chars: RoleCard['characteristics'], rules: Coc7Rules, custom?: number): number {
  const s = rules.skills.find((x) => x.name === key.trim());
  if (s) return s.base === 'DEX/2' ? Math.floor((chars.DEX ?? 0) / 2) : s.base === 'EDU' ? chars.EDU ?? 0 : s.base;
  const fam = familyOf(key, rules);
  if (fam === key.trim()) return custom ?? 0;
  const special = SPECIAL_BASE[fam]?.[specOf(key).toLowerCase()];
  return special ?? rules.families.find((f) => f.name === fam)?.base ?? 0;
}
export function careerBudget(c: Coc7Career | undefined, chars: RoleCard['characteristics']): number {
  if (!c) return 0;
  return c.points.reduce((sum, term) => sum + term.mult * Math.max(0, ...term.attrs.map((a) => (chars as Record<string, number | undefined>)[a] ?? 0)), 0);
}
// What career points may go to, mirroring the server: "fam|*" = any specialisation, "fam|spec" = that one, a plain
// name = that skill. A career naming Science (Biology) opens Biology only.
export function allowedSkills(c: Coc7Career | undefined, card: RoleCard, rules: Coc7Rules): Set<string> {
  const out = new Set<string>();
  if (!c) return out;
  const addKey = (key: string, any = false) => { const fam = familyOf(key, rules), spec = specOf(key); out.add(any ? `${fam}|*` : spec && fam !== key.trim() ? `${fam}|${spec.toLowerCase()}` : key.trim()); };
  out.add('Credit Rating');
  for (const f of c.fixed) { if (f.any) out.add(`${f.skill}|*`); else if (f.spec) out.add(`${f.skill}|${f.spec.toLowerCase()}`); else out.add(f.skill); }
  (card.career?.choices ?? []).forEach((picks, i) => { if (c.choices[i]) for (const p of picks) if (p) addKey(p); });
  for (const s of card.career?.specialties ?? []) if (s) addKey(s);
  return out;
}
export function careerAllows(allowed: Set<string>, key: string, rules: Coc7Rules): boolean {
  const k = key.trim(), fam = familyOf(k, rules), spec = specOf(k).toLowerCase();
  if (allowed.has(k) || allowed.has(`${fam}|*`)) return true;
  if (!spec || fam === k) return false;
  for (const a of allowed) { if (!a.startsWith(`${fam}|`)) continue; const want = a.slice(fam.length + 1); if (want !== '*' && (spec.includes(want) || want.includes(spec))) return true; }
  return false;
}
const optionKey = (o: { skill: string; spec?: string }) => (o.spec ? `${o.skill} (${o.spec})` : o.skill);
const optionLabel = (o: { skill: string; label: string; spec?: string; any?: boolean }) => `${o.label}${o.spec ? `（${o.spec}）` : o.any ? tr(' (any)') : ''} · ${o.skill}`;

export default function PointBuy({ card, rules, editable, isKeeper, report, setCard }: { card: RoleCard; rules: Coc7Rules; editable: boolean; isKeeper: boolean; report: PointsReport; setCard: (fn: (c: RoleCard) => void) => void }) {
  const [newSkill, setNewSkill] = useState('');
  const career = useMemo(() => rules.careers.find((c) => c.name === card.career?.name), [rules, card.career?.name]);
  const chars = card.characteristics;
  const budget = careerBudget(career, chars), hobbyBudget = (chars.INT ?? 0) * 2;
  const allowed = useMemo(() => allowedSkills(career, card, rules), [career, card, rules]);
  const points = card.skill_points ?? {};
  const spent = Object.values(points).reduce((a, p) => ({ career: a.career + (p.career || 0), hobby: a.hobby + (p.hobby || 0) }), { career: 0, hobby: 0 });
  const rows = useMemo(() => {
    const names = new Set<string>([...rules.skills.map((s) => s.name), ...Object.keys(points), ...Object.keys(card.skills)]);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [rules, points, card.skills]);
  const setPoints = (key: string, patch: Partial<SkillPoints>) => setCard((x) => { x.skill_points = x.skill_points ?? {}; const cur = x.skill_points[key] ?? { career: 0, hobby: 0, growth: 0 }; x.skill_points[key] = { ...cur, ...patch }; });
  const num = (v: string) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const half = (v: number) => `${Math.floor(v / 2)} / ${Math.floor(v / 5)}`;
  const isAllowed = (key: string) => careerAllows(allowed, key, rules);
  const totalOf = (key: string) => { const p = points[key]; if (!p) return card.skills[key] ?? baseOf(key, chars, rules); return baseOf(key, chars, rules, p.base) + (p.career || 0) + (p.hobby || 0) + (p.growth || 0); };
  const isStandard = (key: string) => rules.skills.some((s) => s.name === key) || familyOf(key, rules) !== key.trim();
  const setCareer = (name: string) => setCard((x) => { x.career = { name, choices: [], specialties: [] }; });
  const toggleChoice = (g: number, key: string, pick: number) => setCard((x) => { x.career = x.career ?? { name: '', choices: [], specialties: [] }; while (x.career.choices.length <= g) x.career.choices.push([]); const cur = x.career.choices[g]; const i = cur.indexOf(key); if (i >= 0) cur.splice(i, 1); else if (cur.length < pick) cur.push(key); });
  // Slots keep their positions (an empty earlier slot no longer pulls later ones forward).
  const setSpecialty = (i: number, v: string) => setCard((x) => { x.career = x.career ?? { name: '', choices: [], specialties: [] }; const list = [...x.career.specialties]; while (list.length <= i) list.push(''); list[i] = v; while (list.length && !list[list.length - 1]) list.pop(); x.career.specialties = list; });
  const over = { career: spent.career > budget, hobby: spent.hobby > hobbyBudget };
  return (
    <>
      <h4>{tr('Career')}</h4>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="col" style={{ minWidth: 260 }}>
          {editable ? <><input list="coc7-careers" value={card.career?.name ?? ''} placeholder={tr('Choose a career from the list')} onChange={(e) => setCareer(e.target.value)} /><datalist id="coc7-careers">{rules.careers.map((c) => <option key={c.id} value={c.name}>{c.credit ? `${tr('Credit Rating')} ${c.credit[0]}–${c.credit[1]} · ${c.formula}` : c.formula}</option>)}</datalist></> : <b>{card.career?.name || '—'}</b>}
          {card.career?.name && !career && <div className="tiny" style={{ color: 'var(--danger)' }}>{tr('Not in the career list; career points stay locked until a listed career is chosen.')}</div>}
        </div>
        {career && (
          <div className="col grow tiny">
            <div><span className="pill">{tr('Credit Rating')} {career.credit ? `${career.credit[0]}–${career.credit[1]}` : tr('set with your Keeper')}</span> <span className="pill">{tr('Career points')} {career.formula} = {budget}</span> <span className="pill">{tr('Hobby points')} INT×2 = {hobbyBudget}</span></div>
            <div className="muted">{career.description}</div>
          </div>
        )}
      </div>
      {career && career.choices.map((g, gi) => (
        <div key={gi} className="row tiny" style={{ flexWrap: 'wrap', marginTop: 6 }}>
          <span className="muted">{tr('Pick {n} of:', { n: g.pick })}</span>
          {g.from.map((o) => { const key = optionKey(o); const on = (card.career?.choices?.[gi] ?? []).includes(key); return <label key={key} className={`pill ${on ? 'ok' : ''}`} style={{ cursor: editable ? 'pointer' : 'default' }}><input type="checkbox" checked={on} disabled={!editable} onChange={() => toggleChoice(gi, key, g.pick)} /> {optionLabel(o)}</label>; })}
        </div>
      ))}
      {career && career.free > 0 && (
        <div className="row tiny" style={{ flexWrap: 'wrap', marginTop: 6 }}>
          <span className="muted">{tr('{n} specialties of your choice (career points allowed):', { n: career.free })}</span>
          {Array.from({ length: career.free }).map((_, i) => <input key={i} list="coc7-skill-names" value={card.career?.specialties?.[i] ?? ''} disabled={!editable} placeholder={tr('skill')} style={{ width: 150 }} onChange={(e) => setSpecialty(i, e.target.value)} />)}
        </div>
      )}
      <datalist id="coc7-skill-names">{rules.skills.map((s) => <option key={s.name} value={s.name} />)}{rules.families.map((f) => <option key={f.name} value={f.name} />)}</datalist>

      <div className="row" style={{ marginTop: 12 }}>
        <h4 style={{ margin: 0 }}>{tr('Skills')}</h4><span className="grow" />
        <span className={`pill ${over.career ? 'danger' : ''}`}>{tr('Career points')} {spent.career} / {budget}</span>
        <span className={`pill ${over.hobby ? 'danger' : ''}`}>{tr('Hobby points')} {spent.hobby} / {hobbyBudget}</span>
      </div>
      <div className="tiny muted" style={{ marginTop: 2 }}>{tr('★ marks skills that may take career points: the career\'s own skills, your picks above and your specialties. Hobby points go to any skill. Total = base + growth + career + hobby.')}</div>
      <table className="simple points-table">
        <thead><tr><th>★</th><th>{tr('Skill')}</th><th>{tr('Base')}</th><th>{tr('Growth')}</th><th>{tr('Career')}</th><th>{tr('Hobby')}</th><th>{tr('Total')}</th><th>½ / ⅕</th></tr></thead>
        <tbody>
          {rows.map((key) => {
            const p = points[key]; const total = totalOf(key); const ok = isAllowed(key); const mythos = key === 'Cthulhu Mythos'; const custom = !isStandard(key);
            return (
              <tr key={key} className={ok ? 'allowed' : ''}>
                <td>{ok ? '★' : ''}</td>
                <td>{key}{custom && editable && <button className="ghost small" title={tr('remove')} onClick={() => setCard((x) => { delete x.skill_points?.[key]; delete x.skills[key]; })}>×</button>}</td>
                <td>{custom && editable ? <input inputMode="numeric" value={p?.base ?? 0} onChange={(e) => setPoints(key, { base: Math.min(99, num(e.target.value)) })} /> : baseOf(key, chars, rules, p?.base)}</td>
                <td>{editable && !mythos && isKeeper ? <input inputMode="numeric" aria-label={tr('Growth points for {skill}', { skill: key })} value={p?.growth ?? 0} onChange={(e) => setPoints(key, { growth: num(e.target.value) })} /> : <span title={tr('Growth comes from improvement checks; the Keeper records it.')}>{p?.growth ?? 0}</span>}</td>
                <td>{editable && ok && !mythos ? <input inputMode="numeric" value={p?.career ?? 0} onChange={(e) => setPoints(key, { career: num(e.target.value) })} /> : mythos ? '—' : p?.career ?? 0}</td>
                <td>{editable && !mythos ? <input inputMode="numeric" value={p?.hobby ?? 0} onChange={(e) => setPoints(key, { hobby: num(e.target.value) })} /> : mythos ? '—' : p?.hobby ?? 0}</td>
                <td className={total > 99 ? 'over' : ''}><b>{total}</b></td>
                <td className="muted">{half(total)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editable && (
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <input list="coc7-skill-names" placeholder={tr('Add a specialisation or custom skill, e.g. Science (Biology)')} value={newSkill} onChange={(e) => setNewSkill(e.target.value)} style={{ minWidth: 280 }} onKeyDown={(e) => { if (e.key === 'Enter' && newSkill.trim()) { setPoints(newSkill.trim(), {}); setNewSkill(''); } }} />
          <button className="small" onClick={() => { if (newSkill.trim()) { setPoints(newSkill.trim(), {}); setNewSkill(''); } }}>{tr('Add')}</button>
        </div>
      )}
      {(report.violations?.length || report.warnings?.length) ? (
        <div className="tiny" style={{ marginTop: 8 }}>
          {report.violations?.map((v, i) => <div key={'v' + i} style={{ color: 'var(--danger)' }}>{v.message}</div>)}
          {report.warnings?.map((w, i) => <div key={'w' + i} style={{ color: 'var(--warn)' }}>{w.message}</div>)}
        </div>
      ) : null}
    </>
  );
}
