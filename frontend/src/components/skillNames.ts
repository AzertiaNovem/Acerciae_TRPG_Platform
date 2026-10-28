import type { Coc7Rules } from '../types';

// COC7 skill names in the server language (point-buy mode). Keys stay the English names the server stores; only what
// the player reads and types is translated. A specialisation keeps its own words: Science (Biology) reads
// 科学（Biology） on a Chinese server.
type Named = { name: string; names?: Record<string, string> };
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_\-()（）/.'’:]/g, '');
const lastParen = /^(.*)[(（]([^()（）]*)[)）]\s*$/;
const entries = (rules: Coc7Rules): Named[] => [...rules.skills, ...rules.families];
const localOf = (e: Named | undefined, lang: string) => e?.names?.[lang] || '';
const labelOf = (rules: Coc7Rules, name: string, lang: string) => localOf(entries(rules).find((e) => e.name === name && localOf(e, lang)), lang);

export function skillLabel(key: string, rules: Coc7Rules, lang: string): string {
  const k = key.trim();
  const own = labelOf(rules, k, lang);
  if (own) return own;
  const m = k.match(lastParen);
  const fam = m ? labelOf(rules, m[1].trim(), lang) : '';
  if (!m || !fam || !m[2].trim()) return key;
  const spec = m[2].trim();
  return lang.startsWith('zh') || lang === 'ja' ? `${fam}（${spec}）` : lang === 'ko' ? `${fam}(${spec})` : `${fam} (${spec})`;
}

// What the player typed (English or the server language) as the stored key; unknown names stay as typed.
export function skillKey(text: string, rules: Coc7Rules, lang: string): string {
  const t = text.trim();
  const find = (s: string) => { const n = norm(s); return n ? entries(rules).find((e) => norm(e.name) === n || (!!localOf(e, lang) && norm(localOf(e, lang)) === n)) : undefined; };
  // The families without a skill of their own read as their usual member, as the dice do.
  const asSkill = (name: string) => (name === 'Fighting' ? 'Fighting (Brawl)' : name === 'Firearms' ? 'Firearms (Handgun)' : name);
  const asFamily = (name: string) => (name === 'Fighting (Brawl)' ? 'Fighting' : name.startsWith('Firearms (') ? 'Firearms' : name);
  const direct = find(t);
  if (direct) return asSkill(direct.name);
  const m = t.match(lastParen);
  const fam = m && m[2].trim() ? find(m[1]) : undefined;
  return fam && m ? `${asFamily(fam.name)} (${m[2].trim()})` : t;
}
