// Which dot commands a card may post as the clicker. A mirror of dice::parseCommand (backend/src/dice/Dice.cpp,
// "command parsing"): an ASCII trim, a "。"/"．" prefix read as ".", the literals tried case-insensitively (ASCII only)
// in exactly that order, and the rule for the character after a literal. The C++ hypertext::diceVerdict is
// authoritative (the server re-checks every line); the shared fixture section `dice_policy`
// (mobile/contracts/fixtures/hypertext.json) pins both, and Kotlin and Swift port this file.
import { asciiTrim, cpLength } from './text';

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
const space = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);   // C isspace in the C locale
const digit = (c: number) => c >= 0x30 && c <= 0x39;
const alpha = (c: number) => (c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a;   // ASCII letters only, as C isalpha

/** ri/rih join the initiative order as the speaking character only when nothing in the arguments names someone else:
 *  signed modifiers (+2, - 1, +1d4, +d6) and the words adv/advantage/dis/disadvantage (any case), each ending at a
 *  space, a sign or the end. A port of hypertext::modifiersOnly (backend/src/chat/Hypertext.cpp). */
export function modifiersOnly(args: string): boolean {
  const n = args.length, at = (k: number) => args.charCodeAt(k);
  const boundary = (k: number) => k >= n || space(at(k)) || at(k) === 0x2b || at(k) === 0x2d;
  let i = 0;
  for (;;) {
    while (i < n && space(at(i))) i++;
    if (i >= n) return true;
    if (at(i) === 0x2b || at(i) === 0x2d) {
      i++; while (i < n && space(at(i))) i++;
      const a = i; while (i < n && digit(at(i))) i++;
      const count = i > a;
      if (i < n && (at(i) | 0x20) === 0x64) {                     // NdM, or dM
        const b = ++i; while (i < n && digit(at(i))) i++;
        if (i === b) return false;
      } else if (!count) return false;
      if (!boundary(i)) return false;
    } else {
      const a = i; while (i < n && alpha(at(i))) i++;
      const w = args.slice(a, i).toLowerCase();
      if ((w !== 'adv' && w !== 'advantage' && w !== 'dis' && w !== 'disadvantage') || !boundary(i)) return false;
    }
  }
}

/** allowed: r/rh, ra/rc/rah/rch, ri/rih with modifiers only. confirm (the server answers 428): sc, ds, which change the
 *  sheet. refused: ri with a name, st, en, ss, init, move. none: not a command (free text, confirmed by the viewer).
 *  The same verdicts as hypertext::diceVerdict, pinned by the shared fixture's dice_policy. */
export function verdict(text: string): Verdict {
  const cmd = parseCommand(text);
  if (!cmd) return 'none';
  switch (cmd.name) {
    case 'r': case 'ra': return 'allowed';
    case 'ri': return modifiersOnly(cmd.args) ? 'allowed' : 'refused';
    case 'sc': case 'ds': return 'confirm';
    default: return 'refused';
  }
}

/** r/rh arguments that are only an expression: an optional "N#" repeat, then the characters of dice::parseRoll's
 *  expression prefix with no space. Anything after it is posted as the roll's reason. */
const EXPRESSION = /^(\d+#[ \t\n\v\f\r]*)?[0-9dD%+\-*/()kKhHlL]*$/;
/** Whether an allowed roll is nothing but the roll, so a script may post it as the clicker without asking. The server
 *  posts the whole line in the clicker's name, and r/ra keep the text after the expression or skill as the reason, so
 *  a script could otherwise attach any words to a roll. Bare: one line, and for r/rh only an expression; for
 *  ra/rc/rah/rch at most 32 code points and 3 words after the command, numbers and signed numbers not counted (a skill,
 *  a value and modifiers: "Fighting (Brawl) 50 +10"; without the sheet a client cannot tell a reason from a skill
 *  name, so this only bounds it); for ri/rih modifiers only. Client policy for script says: a declarative act.say is
 *  shown on its button instead, and the server allows every r and ra. */
export function bareRoll(text: string): boolean {
  const t = asciiTrim(text), cmd = parseCommand(t);
  if (!cmd || /[\n\v\f\r\u0085\u2028\u2029]/.test(t)) return false;
  switch (cmd.name) {
    case 'r': return EXPRESSION.test(cmd.args);
    case 'ra': return cpLength(cmd.args) <= 32 && cmd.args.split(/[ \t]+/).filter((w) => w && !/^[+-]?\d*$/.test(w)).length <= 3;
    case 'ri': return modifiersOnly(cmd.args);
    default: return false;
  }
}
