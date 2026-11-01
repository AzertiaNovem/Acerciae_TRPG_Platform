// Classification helpers shared by the adapters: a port of LogModel.cpp (isOocText, parseDice, classifyMessage,
// extractCqMedia) and of the speaker-role guess in LogAdapters.cpp. Same regexes, same rules.
import type { DiceInfo, EventType, MediaRef, SpeakerRole } from '../types';
import { asciiLower, asciiTrim, utf8Length } from './util';

// Table conventions for out-of-character talk: ( … ), （ … ）, // …, # …, "ooc …", "[ooc] …".
export function isOocText(text: string): boolean {
  const t = asciiTrim(text);
  if (!t) return false;
  if (t[0] === '(' || t.startsWith('（')) return true;
  if (t.startsWith('//') || t.startsWith('#')) return true;
  const l = asciiLower(t);
  return l.startsWith('ooc') || l.startsWith('[ooc]') || l.startsWith('(ooc');
}

// SealDice result lines: "<name>的侦查检定结果为: D100=37/55 成功", "… D100=37/55 困难成功".
const SEAL_RESULT = /D(\d+)\s*=\s*(\d+)\s*\/\s*(\d+)\s*(大成功|极难成功|困难成功|成功|失败|大失败|critical|extreme success|hard success|success|failure|fumble)?/i;
// Generic "2d6+3=10", "1d100=37", "3d6=[2, 5, 1]=8".
const GENERIC_RESULT = /(\d*d\d+(?:[+\-]\d+)?)\s*=\s*(?:\[([\d, ]+)\][+\-\d ]*=?\s*)?(\d+)/i;
// A command without a result: ".r 1d100", ".ra 侦查 60".
const DICE_COMMAND = /^[.。/!！]\s*(r[acdh]?|rc|ra|roll|sc|st|en)\b\s*(.*)$/i;
const CHECK_NAME_EXCLUDED = /[\s:：]/;

// The server's `的([^\s:：]{1,16})检定`: the check name is the longest run of at most 16 UTF-8 bytes after a "的"
// that is followed by "检定"; the first "的" that has one wins.
function sealCheckName(t: string): string {
  for (let i = t.indexOf('的'); i >= 0; i = t.indexOf('的', i + 1)) {
    let pos = i + 1, bytes = 0, best = -1;
    while (pos < t.length) {
      const cp = t.codePointAt(pos) ?? 0;
      const ch = String.fromCodePoint(cp);
      if (CHECK_NAME_EXCLUDED.test(ch)) break;
      bytes += utf8Length(cp);
      if (bytes > 16) break;
      pos += ch.length;
      if (t.startsWith('检定', pos)) best = pos;
    }
    if (best > i + 1) return t.slice(i + 1, best);
  }
  return '';
}

export function parseDice(t: string): DiceInfo | null {
  let m = SEAL_RESULT.exec(t);
  if (m) {
    const total = parseInt(m[2], 10);
    return { expression: '1d' + m[1], rolls: [total], total, check_name: sealCheckName(t), outcome: m[4] ?? '', raw: t };
  }
  m = GENERIC_RESULT.exec(t);
  if (m) {
    const rolls = m[2] !== undefined ? (m[2].match(/\d+/g) ?? []).map((x) => parseInt(x, 10)) : [];
    return { expression: m[1], rolls, total: parseInt(m[3], 10), check_name: '', outcome: '', raw: t };
  }
  m = DICE_COMMAND.exec(t);
  if (m) return { expression: asciiTrim(m[2]), rolls: [], total: null, check_name: '', outcome: '', raw: t };
  return null;
}

const COMMAND_LIKE = /^[.。/!！]\s*[a-zA-Z]{1,8}\b/;

export function classifyMessage(text: string, isDiceBot: boolean, speakerIsGm: boolean): EventType {
  const tt = asciiTrim(text);
  if (isDiceBot) return parseDice(tt) ? 'dice_roll' : 'system';
  if (isOocText(tt)) return 'ooc';
  // A result-shaped roll ("D100=37/55 成功", "2d6+3=10") is a dice roll whoever posted it.
  const d = parseDice(tt);
  if (d && d.total !== null) return 'dice_roll';
  if (COMMAND_LIKE.test(tt)) return 'dice_roll';
  if (tt.includes('[CQ:image') || tt.includes('[图片]')) return 'media';
  if (speakerIsGm) return 'narration';
  // Quoted text is dialogue; a line starting with * or / is an action; anything else is dialogue.
  if (tt.includes('"') || tt.includes('“') || tt.includes('「')) return 'dialogue';
  if (tt[0] === '*' || tt[0] === '/') return 'action';
  return 'dialogue';
}

const CQ = /\[CQ:(image|record|video|face),([^\]]*)\]/g;
const CQ_KIND: Record<string, MediaRef['kind']> = { image: 'image', record: 'audio', video: 'other', face: 'other' };

function cqParam(params: string, name: string): string | undefined {
  const p = params.indexOf(name + '=');
  if (p < 0) return undefined;
  const e = params.indexOf(',', p);
  return params.slice(p + name.length + 1, e < 0 ? undefined : e);
}

// [CQ:image,file=…,url=…] codes → media entries; `cleaned` is the text with each code replaced by "[图片]" (images)
// or "[record]"/"[video]"/"[face]". The event content itself keeps the codes.
export function extractCqMedia(text: string): { media: MediaRef[] | null; cleaned: string } {
  const media: MediaRef[] = [];
  const cleaned = text.replace(CQ, (_all, kind: string, params: string) => {
    const ref: MediaRef = { kind: CQ_KIND[kind] ?? 'other' };
    const file = cqParam(params, 'file'), url = cqParam(params, 'url');
    if (file !== undefined) ref.file = file;
    if (url !== undefined) ref.url = url;
    media.push(ref);
    return kind === 'image' ? '[图片]' : `[${kind}]`;
  });
  return media.length ? { media, cleaned } : { media: null, cleaned: text };
}

// The server's speaker-role guess from a nickname: dice bots (骰, dice, bot, 海豹), observers (ob…), the Keeper
// (kp, gm, keeper, 守秘人, 主持); everyone else is a player character.
export function guessRole(nick: string, isDice: boolean): SpeakerRole {
  const l = asciiLower(nick);
  const botName = l.includes('骰') || l.includes('dice') || l.includes('bot') || l.includes('海豹');
  if (isDice || botName) return 'dice';
  if (l.startsWith('ob')) return 'hidden';
  if (l === 'kp' || l === 'gm' || l === 'keeper' || l.includes('keeper') || l.includes('守秘人') || l.includes('主持')) return 'gm';
  return 'pc';
}

const ROLES: readonly SpeakerRole[] = ['gm', 'pc', 'npc', 'dice', 'system', 'hidden'];
const TYPES: readonly EventType[] = ['dialogue', 'action', 'narration', 'dice_roll', 'system', 'ooc', 'scene_change', 'media', 'secret'];
export function asRole(v: unknown): SpeakerRole | null {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v) ? (v as SpeakerRole) : null;
}
export function asEventType(v: unknown): EventType | null {
  return typeof v === 'string' && (TYPES as readonly string[]).includes(v) ? (v as EventType) : null;
}
