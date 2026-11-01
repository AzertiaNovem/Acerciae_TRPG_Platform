// The JSON formats: native acerciae-log (schemaVersion 1.0 events, 2.0 messages) and SealDice's log JSON.
import type { CharacterSheet, DiceInfo, ImportIssue, LogEvent, MediaRef, ParsedLog } from '../types';
import { asEventType, asRole, classifyMessage, extractCqMedia, guessRole } from './classify';
import { blankEvent, finishEvent } from './headerFormats';
import { SpeakerTable } from './speakers';
import type { LogAdapter } from './adapter';
import type { CharacterSheetWithBio, LogEventWithVisibility, Visibility } from './nativeTypes';
import { bool, isObject, num, parseTime, str, truncateUtf8, type JsonObject } from './util';

function tryParse(t: string): unknown {
  try { return JSON.parse(t); } catch { return undefined; }
}

function unrecognisedEvent(adapter: ParsedLog['adapter'], file: string, line: number, value: unknown): LogEvent {
  const e = blankEvent(adapter, file, line);
  const raw = JSON.stringify(value) ?? String(value);
  return Object.assign(e, { type: 'system', role: 'system', content: raw, raw, unrecognised: true });
}

function mediaFrom(v: unknown): MediaRef[] | null {
  if (!Array.isArray(v)) return null;
  const out: MediaRef[] = [];
  for (const m of v) {
    if (!isObject(m)) continue;
    const k = str(m, 'kind');
    const ref: MediaRef = { kind: k === 'image' ? 'image' : k === 'record' || k === 'audio' ? 'audio' : 'other' };
    if (typeof m.file === 'string') ref.file = m.file;
    if (typeof m.url === 'string') ref.url = m.url;
    out.push(ref);
  }
  return out.length ? out : null;
}

function nonEmpty(s: string): string | undefined { return s ? s : undefined; }

// ---- native 1.0 -----------------------------------------------------------------------------------------------
// Events in the server's LogEvent::toJson shape. Old exports key speakers as "<nick>-<im id>"; that key only tells
// speakers apart here, the new key is the display name.
function parseNativeV1(j: JsonObject, file: string): ParsedLog {
  const speakers = new SpeakerTable();
  const events: LogEvent[] = [], issues: ImportIssue[] = [];
  const list = j.events as unknown[];
  list.forEach((ev, i) => {
    const line = i + 1;
    if (!isObject(ev)) {
      const e = unrecognisedEvent('native_json', file, line, ev);
      events.push(e); issues.push({ file, line, raw: e.raw, reason: 'non-object event retained', severity: 'warning' });
      return;
    }
    const e: LogEventWithVisibility = blankEvent('native_json', file, line);
    e.content = str(ev, 'content');
    e.speaker_name = str(ev, 'speaker_display_name');
    const type = asEventType(ev.event_type);
    if (ev.event_type !== undefined && !type) issues.push({ file, line, raw: str(ev, 'event_type'), reason: 'unknown event type read as dialogue', severity: 'warning' });
    e.type = type ?? 'dialogue';
    e.role = asRole(ev.speaker_role) ?? (e.speaker_name ? guessRole(e.speaker_name, false) : 'pc');
    if (e.speaker_name) {
      const ref = ev.source_reference;
      const identity = str(ev, 'speaker_key') || str(ref, 'im_user_id') || null;
      e.speaker_key = speakers.add(e.speaker_name, identity, e.role === 'dice', e.role);
    }
    e.time = num(ev.timestamp);
    e.time_text = str(ev, 'time_text');
    e.scene_title = str(ev, 'scene_title');
    e.window = str(ev.metadata, 'window');
    if (isObject(ev.dice)) {
      const d = ev.dice;
      e.dice = {
        expression: str(d, 'expression'), rolls: Array.isArray(d.rolls) ? d.rolls.filter((r): r is number => typeof r === 'number').map(Math.trunc) : [],
        total: num(d.total) === null ? null : Math.trunc(d.total as number), check_name: str(d, 'check_name'), outcome: str(d, 'outcome'), raw: str(d, 'raw'),
      };
    }
    e.media = mediaFrom(ev.media);
    e.raw = str(ev, 'raw_text') || JSON.stringify(ev);
    e.unrecognised = bool(ev, 'unrecognised');
    const player = str(ev.source_reference, 'player');
    if (player) e.player = player;
    const vis = str(ev, 'visibility_scope', 'public');
    if (vis === 'gm' || vis === 'character') e.visibility = vis === 'gm' ? 'gm' : 'private';
    events.push(e);
  });
  events.forEach((e, i) => { e.seq = i + 1; });
  return { adapter: 'native_json', format_version: '1.0', events, speakers: speakers.list(), issues };
}

// ---- native 2.0 -----------------------------------------------------------------------------------------------
function parseNativeV2(j: JsonObject, file: string): ParsedLog {
  const speakers = new SpeakerTable();
  const events: LogEvent[] = [], issues: ImportIssue[] = [];
  const scenarioTitle = new Map<number, string>();
  if (Array.isArray(j.scenarios)) for (const s of j.scenarios) { const n = num(isObject(s) ? s.sequence : null); if (n !== null) scenarioTitle.set(n, str(s, 'title')); }
  const keysOfCharacter = new Map<string, Set<string>>();

  (j.messages as unknown[]).forEach((m, i) => {
    const line = i + 1;
    if (!isObject(m)) {
      const e = unrecognisedEvent('native_json', file, line, m);
      events.push(e); issues.push({ file, line, raw: e.raw, reason: 'non-object message retained', severity: 'warning' });
      return;
    }
    const e: LogEventWithVisibility = blankEvent('native_json', file, line);
    e.content = str(m, 'content');
    e.raw = JSON.stringify(m);
    e.role = asRole(m.role) ?? 'pc';
    const character = str(m, 'character'), player = str(m, 'player');
    e.speaker_name = str(m, 'speaker') || character;
    if (e.speaker_name) {
      e.speaker_key = speakers.add(e.speaker_name, player || null, e.role === 'dice', e.role);
      if (character) {
        const set = keysOfCharacter.get(character) ?? new Set<string>();
        set.add(e.speaker_key); keysOfCharacter.set(character, set);
      }
    }
    const type = asEventType(m.type);
    if (m.type !== undefined && m.type !== null && !type) issues.push({ file, line, raw: str(m, 'type'), reason: 'unknown message type; classified from the text', severity: 'warning' });
    e.type = type ?? classifyMessage(e.content, e.role === 'dice', e.role === 'gm');
    e.time_text = str(m, 'time_text');
    if (typeof m.time === 'string' && m.time) {
      const ms = Date.parse(m.time);
      if (Number.isFinite(ms)) e.time = Math.floor(ms / 1000);
      else e.time_text = e.time_text || m.time;
    }
    const seq = num(m.scenario);
    if (seq !== null) e.scene_title = scenarioTitle.get(seq) ?? '';
    e.window = str(m, 'window');
    if (player) e.player = player;
    if (isObject(m.dice)) {
      const d = m.dice, total = num(d.total);
      e.dice = { expression: str(d, 'expression'), rolls: [], total: total === null ? null : Math.trunc(total), check_name: str(d, 'check_name'), outcome: str(d, 'outcome'), raw: str(d, 'text') };
    }
    e.media = extractCqMedia(e.content).media;
    const vis = str(m, 'visibility', 'public');
    if (vis === 'gm' || vis === 'private') e.visibility = vis as Visibility;
    events.push(e);
  });
  events.forEach((e, i) => { e.seq = i + 1; });

  const list = speakers.list();
  const characters: CharacterSheet[] = [];
  if (Array.isArray(j.characters)) for (const c of j.characters) {
    if (!isObject(c) || !str(c, 'name')) continue;
    const name = str(c, 'name');
    const keys = keysOfCharacter.get(name);
    const poses: Record<string, string> = {};
    if (isObject(c.poses)) for (const [k, v] of Object.entries(c.poses)) if (typeof v === 'string' && v) poses[k] = v;
    const sheet: CharacterSheetWithBio = {
      name,
      speakers: keys ? [...keys] : list.filter((s) => s.name === name).map((s) => s.key),
      kind: str(c, 'kind') === 'npc' ? 'npc' : 'pc',
      player: str(c, 'player'),
      appearance: str(c, 'appearance_prompt'),
      role_card: isObject(c.role_card) ? c.role_card : null,
      avatar: nonEmpty(str(c, 'avatar_url')) ?? null,
      portrait: nonEmpty(str(c, 'portrait_url')) ?? null,
      poses,
      voice: '',
      bio: str(c, 'bio'),
      speaking_style: str(c, 'speaking_style'),
    };
    characters.push(sheet);
  }
  const campaign = { name: str(j.campaign, 'name'), era: str(j.campaign, 'era'), description: str(j.campaign, 'description') };
  return { adapter: 'native_json', format_version: '2.0', events, speakers: list, issues, campaign, characters };
}

export const nativeJsonAdapter: LogAdapter = {
  name: 'native_json',
  supportedVersions: 'acerciae-log JSON: schemaVersion 1.0 (events) and 2.0 (campaign, players, characters, messages)',
  detect(t) {
    const j = tryParse(t);
    if (!isObject(j)) return false;
    if ('schemaVersion' in j && Array.isArray(j.events)) return true;
    return Array.isArray(j.messages) && ('schemaVersion' in j || j.format === 'acerciae-log');
  },
  parse(t, file = '') {
    const j = JSON.parse(t) as unknown;
    if (!isObject(j)) throw new Error('native JSON must be an object');
    const version = str(j, 'schemaVersion');
    if (version.startsWith('2.') && Array.isArray(j.messages)) return parseNativeV2(j, file);
    if (version === '1.0' && Array.isArray(j.events)) return parseNativeV1(j, file);
    throw new Error(`native JSON requires schemaVersion 1.0 (events) or 2.0 (messages); this file says "${version}"`);
  },
};

// ---- SealDice JSON --------------------------------------------------------------------------------------------
// {version, items:[{nickname, IMUserId, time, message, isDice, commandId, commandInfo?, …}]}; detection = items[0]
// has "isDice" and "message".
function emptyDice(d: DiceInfo): boolean {
  return !d.expression && !d.rolls.length && d.total === null && !d.check_name && !d.outcome;
}

export const sealDiceJsonAdapter: LogAdapter = {
  name: 'sealdice_json',
  supportedVersions: 'SealDice log JSON export: {version, items[{nickname, IMUserId, time, message, isDice, commandId, commandInfo}]}',
  detect(t) {
    const j = tryParse(t);
    return isObject(j) && Array.isArray(j.items) && j.items.length > 0 && isObject(j.items[0]) && 'isDice' in j.items[0] && 'message' in j.items[0];
  },
  parse(t, file = '') {
    const j = JSON.parse(t) as unknown;
    if (!isObject(j) || !Array.isArray(j.items)) throw new Error('SealDice JSON needs an items array');
    const version = j.version === undefined ? 'unknown' : typeof j.version === 'string' ? j.version : JSON.stringify(j.version);
    const speakers = new SpeakerTable();
    const events: LogEvent[] = [], issues: ImportIssue[] = [];
    j.items.forEach((it: unknown, i: number) => {
      const line = i + 1;
      const nick = str(it, 'nickname'), message = str(it, 'message');
      if (!isObject(it) || (!nick && !message)) {
        issues.push({ file, line, raw: truncateUtf8(JSON.stringify(it) ?? '', 200), reason: 'item without nickname and message', severity: 'warning' });
        const e = blankEvent('sealdice_json', file, line);
        events.push(Object.assign(e, { type: 'system', role: 'system', raw: JSON.stringify(it) ?? '', unrecognised: true }));
        return;
      }
      const isDice = bool(it, 'isDice');
      const e = blankEvent('sealdice_json', file, line);
      e.speaker_name = nick || '(unnamed)';
      e.speaker_key = speakers.add(e.speaker_name, str(it, 'IMUserId', 'unknown'), isDice);
      if (isDice) speakers.setRole(e.speaker_key, 'dice');
      if (typeof it.time === 'number' && Number.isFinite(it.time)) e.time = Math.trunc(it.time);
      else if (typeof it.time === 'string') { const p = parseTime(it.time); if (p !== null) e.time = p; else e.time_text = it.time; }
      e.content = message;
      e.raw = JSON.stringify(it);
      e.role = speakers.get(e.speaker_key)?.role ?? 'pc';
      finishEvent(e);
      // commandInfo (when present) carries structured roll data; it fills in what the text did not say.
      const ci = it.commandInfo;
      if (isObject(ci)) {
        const d: DiceInfo = e.dice ? { ...e.dice } : { expression: '', rolls: [], total: null, check_name: '', outcome: '', raw: '' };
        const first = Array.isArray(ci.items) && ci.items.length ? ci.items[0] : null;
        if (isObject(first)) {
          if ('expr' in first) d.expression = str(first, 'expr');
          if ('expr1' in first) d.expression = str(first, 'expr1');
          if (num(first.dicePoints) !== null) d.total = Math.trunc(first.dicePoints as number);
          if (num(first.checkVal) !== null) d.total = Math.trunc(first.checkVal as number);
          if ('attr' in first) d.check_name = str(first, 'attr');
          if ('rank' in first && !d.outcome) d.outcome = typeof first.rank === 'string' ? first.rank : JSON.stringify(first.rank);
        }
        if (!emptyDice(d)) { d.raw = e.content; e.dice = d; if (e.type !== 'ooc') e.type = 'dice_roll'; }
      }
      events.push(e);
    });
    events.forEach((e, i) => { e.seq = i + 1; });
    return { adapter: 'sealdice_json', format_version: version, events, speakers: speakers.list(), issues };
  },
};
