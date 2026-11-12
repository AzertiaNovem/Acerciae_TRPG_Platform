import { t as tr } from '../i18n';
import { useTyping } from '../store/typing';
import type { Vitals } from '../types';

// What each character's entry in the sidebar shows besides the name: the few numbers that matter at the table (CoC:
// HP, SAN, DEX; D&D: HP, AC, DEX; PbtA: its resources and marked conditions) on a second line, and a pen next to the
// name while the character is being written as.
const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v));
const pair = (v: number | null | undefined, max: number | null | undefined) => (max ? `${num(v)}/${max}` : num(v));
export function vitalParts(v: Vitals | undefined): { label: string; value: string; low?: boolean }[] {
  if (!v) return [];
  if (v.rule_system === 'pbta') {
    const parts = (v.resources ?? []).map((r) => ({ label: r.name, value: num(r.value) }));
    for (const c of v.conditions ?? []) parts.push({ label: c.name, value: '' });
    return parts;
  }
  const low = v.hp !== null && v.hp !== undefined && (v.hp_max ? v.hp <= Math.ceil(v.hp_max / 3) : v.hp <= 0);
  if (v.rule_system === 'dnd2024') return [{ label: 'HP', value: pair(v.hp, v.hp_max), low }, { label: 'AC', value: num(v.ac) }, { label: 'DEX', value: num(v.dex) }];
  return [{ label: 'HP', value: pair(v.hp, v.hp_max), low }, { label: 'SAN', value: pair(v.san, v.san_max) }, { label: 'DEX', value: num(v.dex) }];
}

export function useIsTyping(characterId: string) { return useTyping((s) => !!s.byCharacter[characterId]); }

export function TypingMark({ characterId }: { characterId: string }) {
  const typing = useIsTyping(characterId);
  if (!typing) return null;
  return <span className="typing" role="img" aria-label={tr('typing…')} title={tr('typing…')}>✎</span>;
}

export function CharacterVitals({ vitals }: { vitals: Vitals | undefined }) {
  const parts = vitalParts(vitals);
  return <span className="char-vitals" data-testid="character-vitals">{parts.length === 0 ? '—' : parts.map((p, i) => <span key={p.label + i} className={`vital ${p.low ? 'low' : ''}`}>{p.label}{p.value ? ' ' + p.value : ''}</span>)}</span>;
}

export function PassiveMark({ since }: { since?: string | null }) {
  return since ? <span className="pill passive" title={tr('Player away: passively present')}>{tr('passive')}</span> : null;
}
