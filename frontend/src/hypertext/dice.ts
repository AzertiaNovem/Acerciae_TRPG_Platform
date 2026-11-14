// Which dot commands a card may post as the clicker. A mirror of dice::parseCommand (backend/src/dice/Dice.cpp,
// "command parsing"): an ASCII trim, a "。"/"．" prefix read as ".", the literals tried case-insensitively (ASCII only)
// in exactly that order, and the rule for the character after a literal. The C++ hypertext::diceVerdict is
// authoritative (the server re-checks every line); the shared fixture section `dice_policy`
// (mobile/contracts/fixtures/hypertext.json) pins both, and Kotlin and Swift port this file.
import { asciiTrim } from './text';

export interface Command { name: string; args: string; raw: string; hidden: boolean }
const LITERALS: [string, string][] = [
  ['move', 'move'], ['init', 'init'], ['rah', 'ra'], ['rch', 'ra'], ['ra', 'ra'], ['rc', 'ra'], ['rih', 'ri'], ['ri', 'ri'], ['rh', 'r'], ['r', 'r'],
  ['sc', 'sc'], ['st', 'st'], ['en', 'en'], ['ds', 'ds'], ['ss', 'ss'],
];
const lower = (c: number) => c >= 0x41 && c <= 0x5a ? c + 32 : c;

export function parseCommand(content: string): Command | null {
  let s = asciiTrim(content);
  if (s.startsWith('。') || s.startsWith('．')) s = '.' + s.slice(1);
  if (s.length < 2 || s[0] !== '.') return null;
  const rest = s.slice(1);
  for (const [lit, name] of LITERALS) {
    const n = lit.length;
    if (rest.length < n) continue;
    let match = true;
    for (let i = 0; i < n; i++) if (lower(rest.charCodeAt(i)) !== lit.charCodeAt(i)) { match = false; break; }
    if (!match) continue;
    if (rest.length > n) {
      const c = rest[n], code = rest.charCodeAt(n);
      // As in C++: ASCII space, a digit, any non-ASCII character, one of "(%#+-/" (strchr also finds the NUL
      // terminator), or a d after the bare r.
      const ok = c === ' ' || c === '\t' || c === '\n' || c === '\r' || (code >= 0x30 && code <= 0x39) || code >= 0x80
        || code === 0 || '(%#+-/'.includes(c) || (lit === 'r' && (c === 'd' || c === 'D'));
      if (!ok) continue;
    }
    return { name, args: asciiTrim(rest.slice(n)), raw: '.' + lit, hidden: lit === 'rah' || lit === 'rch' || lit === 'rh' || lit === 'rih' };
  }
  return null;
}

export type Verdict = 'allowed' | 'confirm' | 'refused' | 'none';
/** Modifiers only, no name: "", "+2", "-1 +3" (whitespace as C++ isspace in the C locale). */
const MODIFIERS = /^([+-][ \t\n\v\f\r]*\d{1,4}[ \t\n\v\f\r]*)+$/;

/** allowed: r/rh, ra/rc/rah/rch, ri/rih with modifiers only. confirm (the server answers 428): sc, ds, which change the
 *  sheet. refused: ri with a name, st, en, ss, init, move. none: not a command (free text, confirmed by the viewer). */
export function verdict(text: string): Verdict {
  const cmd = parseCommand(text);
  if (!cmd) return 'none';
  switch (cmd.name) {
    case 'r': case 'ra': return 'allowed';
    case 'ri': return cmd.args === '' || MODIFIERS.test(cmd.args) ? 'allowed' : 'refused';
    case 'sc': case 'ds': return 'confirm';
    default: return 'refused';
  }
}
