const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

// Bundles src/openstudio/import (TypeScript) to CommonJS in memory and loads it.
function load() {
  const entry = path.join(__dirname, '../src/openstudio/import/index.ts');
  const out = esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', write: false });
  const m = new Module(entry);
  m.paths = module.paths;
  m._compile(out.outputFiles[0].text, entry);
  return m.exports;
}
const S = load();
const enc = (s) => new TextEncoder().encode(s);

const PLAIN = 'Sylvan(1234567) 2026/10/02 21:41:06\nSOMETHING\nKeeper(1234567) 2026/10/02 21:43:45\nSOMETHING';

test('the plain SealDice text example: two messages, roles, UTC times, no platform ids', () => {
  const log = S.importFile('session.txt', enc(PLAIN));
  assert.equal(log.adapter, 'sealdice_text');
  assert.equal(log.events.length, 2);
  const [a, b] = log.events;
  assert.deepEqual([a.speaker_key, a.speaker_name, a.role, a.type], ['Sylvan', 'Sylvan', 'pc', 'dialogue']);
  assert.deepEqual([b.speaker_key, b.speaker_name, b.role, b.type], ['Keeper', 'Keeper', 'gm', 'narration']);
  assert.equal(a.time, Date.UTC(2026, 9, 2, 21, 41, 6) / 1000);
  assert.equal(b.time, Date.UTC(2026, 9, 2, 21, 43, 45) / 1000);
  assert.equal(a.content, 'SOMETHING\n');
  assert.equal(b.content, 'SOMETHING');
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  assert.deepEqual([a.source, b.source], [{ file: 'session.txt', adapter: 'sealdice_text', line: 1 }, { file: 'session.txt', adapter: 'sealdice_text', line: 3 }]);
  assert.deepEqual(log.speakers, [{ key: 'Sylvan', name: 'Sylvan', role: 'pc', message_count: 1 }, { key: 'Keeper', name: 'Keeper', role: 'gm', message_count: 1 }]);
  const named = JSON.stringify([log.speakers, log.events.map((e) => [e.speaker_key, e.speaker_name, e.player])]);
  assert.ok(!named.includes('1234567'));
  assert.deepEqual(log.issues, []);
});

test('two IM ids sharing a nickname become Nick and Nick#2; one id under two nicknames stays two speakers', () => {
  const txt = 'Nick(111) 21:00:00\na\nNick(222) 21:00:05\nb\nNick(111) 21:00:09\nc\nOther(111) 21:00:10\nd\n';
  const log = S.importText('x.txt', txt);
  assert.deepEqual(log.events.map((e) => e.speaker_key), ['Nick', 'Nick#2', 'Nick', 'Other']);
  assert.deepEqual(log.events.map((e) => e.speaker_name), ['Nick', 'Nick', 'Nick', 'Other']);
  assert.equal(log.events[0].time, null);
  assert.equal(log.events[0].time_text, '21:00:00');
  assert.deepEqual(log.speakers.map((s) => [s.key, s.message_count]), [['Nick', 2], ['Nick#2', 1], ['Other', 1]]);
});

test('SealDice text (server fixture): leading note, narration, dialogue, dice, OOC, CQ image, renames, #n suffix', () => {
  const txt =
    '前言：这是一段未格式化的说明。\n' +
    '守秘人(10001) 2023/05/06 20:11:12\n夜色下的黑水湾，灯塔没有亮。\n第二行 narration continues.\n\n' +
    '哈维·沃尔特斯(20002) 2023/05/06 20:11:40\n“警长，我们想去灯塔看看。” I remove my hat.\n\n' +
    '海豹骰娘(30003) 2023/05/06 20:12:01\n哈维·沃尔特斯的侦查检定结果为: D100=37/55 成功\n\n' +
    '哈维·沃尔特斯(20002) 2023/05/06 20:12:30 #4\n（ooc：今晚几点结束？）\n\n' +
    'Harvey(20002) 2023/05/06 20:13:00\n我把帽子放在桌上。[CQ:image,file=abc.jpg,url=https://img.example/abc.jpg]\n';
  const log = S.importText('fixture.txt', txt);
  assert.equal(log.adapter, 'sealdice_text');
  assert.equal(log.events.length, 6);
  const [lead, gm, talk, dice, ooc, media] = log.events;
  assert.ok(lead.unrecognised && lead.type === 'system' && lead.role === 'system' && lead.content.startsWith('前言'));
  assert.equal(lead.speaker_key, '');
  assert.equal(log.issues.length, 1);
  assert.equal(log.issues[0].file, 'fixture.txt');
  assert.match(log.issues[0].reason, /before the first recognised message/);
  assert.deepEqual([gm.role, gm.type], ['gm', 'narration']);
  assert.equal(gm.content, '夜色下的黑水湾，灯塔没有亮。\n第二行 narration continues.\n\n');
  assert.equal(talk.type, 'dialogue');
  assert.ok(talk.content.startsWith('“'));
  assert.deepEqual([dice.role, dice.type], ['dice', 'dice_roll']);
  assert.deepEqual([dice.dice.total, dice.dice.outcome, dice.dice.check_name, dice.dice.expression], [37, '成功', '侦查', '1d100']);
  assert.equal(ooc.type, 'ooc');
  assert.equal(ooc.speaker_key, '哈维·沃尔特斯');
  assert.equal(media.type, 'media');
  assert.deepEqual(media.media, [{ kind: 'image', file: 'abc.jpg', url: 'https://img.example/abc.jpg' }]);
  assert.ok(media.content.includes('[CQ:image'));
  assert.deepEqual(log.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(log.speakers.map((s) => [s.key, s.role]), [['守秘人', 'gm'], ['哈维·沃尔特斯', 'pc'], ['海豹骰娘', 'dice'], ['Harvey', 'pc']]);
});

test('SealDice JSON: isDice speakers, commandInfo, CRLF content kept, version', () => {
  const sj = JSON.stringify({ version: 105, items: [
    { nickname: 'KP', IMUserId: 'QQ:1', time: 1683375072, message: '门开了。\r\n里面一片漆黑。', isDice: false, commandId: 0 },
    { nickname: '海豹', IMUserId: 'QQ:2', time: 1683375080, message: 'KP的侦查检定结果为: D100=90/50 失败', isDice: true, commandId: 1,
      commandInfo: { rule: 'coc7', items: [{ expr1: 'D100', checkVal: 90, attr: '侦查', rank: -1 }] } },
    { nickname: 'Ann', IMUserId: 'QQ:3', time: 1683375090, message: '.ra 聆听', isDice: false, commandId: 2,
      commandInfo: { items: [{ expr: 'd100', dicePoints: 12, attr: '聆听', rank: 2 }] } },
  ] });
  assert.equal(S.detectAdapter(sj).name, 'sealdice_json');
  const log = S.importText('a.json', sj);
  assert.equal(log.format_version, '105');
  assert.equal(log.events.length, 3);
  assert.equal(log.events[0].content, '门开了。\r\n里面一片漆黑。');
  assert.deepEqual([log.events[0].role, log.events[0].type, log.events[0].time], ['gm', 'narration', 1683375072]);
  const bot = log.events[1];
  assert.deepEqual([bot.role, bot.type, bot.dice.check_name, bot.dice.total, bot.dice.expression, bot.dice.outcome], ['dice', 'dice_roll', '侦查', 90, 'D100', '失败']);
  const ra = log.events[2];
  assert.deepEqual([ra.type, ra.dice.expression, ra.dice.total, ra.dice.check_name, ra.dice.outcome], ['dice_roll', 'd100', 12, '聆听', '2']);
  assert.deepEqual(log.speakers.map((s) => s.key), ['KP', '海豹', 'Ann']);
  assert.ok(!JSON.stringify(log.speakers).includes('QQ:'));
});

test('rendered and QQ export formats', () => {
  const rendered = '2022/08/18 19:43:21<Keeper(904002355)>:领航技能会判定自动失败\n2022/08/18 19:43:32<昆特·爱尔芙(562308967)>:唔……那我的信息有没有什么可以利用的）\n继续上一行\n';
  assert.equal(S.detectAdapter(rendered).name, 'rendered_log');
  const r = S.importText('r.txt', rendered);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].content, '领航技能会判定自动失败\n');
  assert.equal(r.events[1].content, '唔……那我的信息有没有什么可以利用的）\n继续上一行\n');
  assert.deepEqual(r.speakers.map((s) => [s.key, s.role]), [['Keeper', 'gm'], ['昆特·爱尔芙', 'pc']]);
  assert.equal(r.events[0].time, Date.UTC(2022, 7, 18, 19, 43, 21) / 1000);

  const qq = '2022-05-10 11:28:25 名字(12345)\n你好\n2022-05-10 11:28:30 别人<67890>\n再见\n';
  assert.equal(S.detectAdapter(qq).name, 'qq_export');
  const q = S.importText('q.txt', qq);
  assert.deepEqual(q.events.map((e) => e.content), ['你好\n', '再见\n']);
  assert.deepEqual(q.speakers.map((s) => s.key), ['名字', '别人']);
  assert.equal(q.events[1].time, Date.UTC(2022, 4, 10, 11, 28, 30) / 1000);

  assert.equal(S.detectAdapter('just some prose without any header'), null);
  assert.throws(() => S.importText('notes.txt', 'just some prose without any header'), (e) => /notes\.txt/.test(e.message) && /SealDice/.test(e.message) && /QQ/.test(e.message));
});

test('dice parsing, OOC detection, classification, CQ media', () => {
  const d = S.parseDice('哈维的侦查检定结果为: D100=37/55 困难成功');
  assert.deepEqual(d, { expression: '1d100', rolls: [37], total: 37, check_name: '侦查', outcome: '困难成功', raw: '哈维的侦查检定结果为: D100=37/55 困难成功' });
  assert.equal(S.parseDice('KP的角色名字很长的侦查检定结果为: D100=5/50 大成功').check_name, '侦查');   // 16-byte limit, as on the server
  assert.equal(S.parseDice('d100=96/40 大失败').outcome, '大失败');
  assert.deepEqual(S.parseDice('3d6=[2, 5, 1]=8'), { expression: '3d6', rolls: [2, 5, 1], total: 8, check_name: '', outcome: '', raw: '3d6=[2, 5, 1]=8' });
  assert.equal(S.parseDice('2d6+3=10').total, 10);
  const cmd = S.parseDice('.ra 侦查 60');
  assert.deepEqual([cmd.expression, cmd.total], ['侦查 60', null]);
  assert.equal(S.parseDice('hello there'), null);

  for (const t of ['(brb)', '（ooc：几点结束？）', '// later', '# note', 'OOC: hi', '[ooc] hi']) assert.ok(S.isOocText(t), t);
  for (const t of ['hello', '“(quoted)”', '']) assert.ok(!S.isOocText(t), t);

  assert.equal(S.classifyMessage('.ra 侦查', false, false), 'dice_roll');
  assert.equal(S.classifyMessage('。ra侦查', false, false), 'dice_roll');
  assert.equal(S.classifyMessage('D100=37/55 成功', false, true), 'dice_roll');
  assert.equal(S.classifyMessage('anything', true, false), 'system');
  assert.equal(S.classifyMessage('Rain falls.', false, true), 'narration');
  assert.equal(S.classifyMessage('*opens the door*', false, false), 'action');
  assert.equal(S.classifyMessage('看 [图片]', false, false), 'media');
  assert.equal(S.classifyMessage('"Hi"', false, false), 'dialogue');

  const cq = S.extractCqMedia('看[CQ:image,file=a.png,url=http://x/a.png]和[CQ:record,file=v.amr]');
  assert.deepEqual(cq.media, [{ kind: 'image', file: 'a.png', url: 'http://x/a.png' }, { kind: 'audio', file: 'v.amr' }]);
  assert.equal(cq.cleaned, '看[图片]和[record]');
  assert.deepEqual(S.extractCqMedia('plain'), { media: null, cleaned: 'plain' });

  assert.equal(S.guessRole('KP', false), 'gm');
  assert.equal(S.guessRole('守秘人小林', false), 'gm');
  assert.equal(S.guessRole('ob_alice', false), 'hidden');
  assert.equal(S.guessRole('骰娘', false), 'dice');
  assert.equal(S.guessRole('Alice', true), 'dice');
});

test('a speaker posting mostly dice results is a dice bot; observers write secrets', () => {
  const txt = 'Roller(9) 20:00:00\nD100=10/50 成功\nRoller(9) 20:00:01\n1d20=7\nOb_Watcher(8) 20:00:02\nwatching\nAnn(7) 20:00:03\n(ooc) hi\n';
  const log = S.importText('b.txt', txt);
  assert.deepEqual(log.events.map((e) => [e.speaker_key, e.role, e.type]), [
    ['Roller', 'dice', 'dice_roll'], ['Roller', 'dice', 'dice_roll'], ['Ob_Watcher', 'hidden', 'secret'], ['Ann', 'pc', 'ooc'],
  ]);
  assert.equal(log.speakers.find((s) => s.key === 'Roller').role, 'dice');
});

test('decodeBytes: UTF-8 with and without BOM, UTF-16 LE/BE, GBK, invalid', () => {
  assert.deepEqual(S.decodeBytes(enc('héllo')), { text: 'héllo', encoding: 'utf-8' });
  assert.deepEqual(S.decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('中文')])), { text: '中文', encoding: 'utf-8-bom' });
  assert.deepEqual(S.decodeBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])), { text: 'AB', encoding: 'utf-16le' });
  assert.deepEqual(S.decodeBytes(new Uint8Array([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87])), { text: '中文', encoding: 'utf-16be' });
  assert.deepEqual(S.decodeBytes(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])), { text: '中文', encoding: 'gb18030-inferred' });
  assert.throws(() => S.decodeBytes(new Uint8Array([0xff])), /encoding/);

  // A whole GBK file: "守秘人(10001) 2023/05/06 20:11:12\n你好" (守秘人 = CA D8 C3 D8 C8 CB, 你好 = C4 E3 BA C3).
  const gbk = new Uint8Array([0xca, 0xd8, 0xc3, 0xd8, 0xc8, 0xcb, ...enc('(10001) 2023/05/06 20:11:12\n'), 0xc4, 0xe3, 0xba, 0xc3]);
  const log = S.importFile('gbk.txt', gbk);
  assert.deepEqual([log.events.length, log.events[0].speaker_key, log.events[0].role, log.events[0].content], [1, '守秘人', 'gm', '你好']);
  assert.ok(log.issues.some((i) => /GB18030/.test(i.reason)));

  // A UTF-16 LE file with a BOM.
  const s = PLAIN, u16 = new Uint8Array(2 + s.length * 2);
  u16[0] = 0xff; u16[1] = 0xfe;
  for (let i = 0; i < s.length; i++) { u16[2 + 2 * i] = s.charCodeAt(i) & 0xff; u16[3 + 2 * i] = s.charCodeAt(i) >> 8; }
  assert.deepEqual(S.importFile('u16.txt', u16).events.map((e) => e.speaker_key), ['Sylvan', 'Keeper']);
});

test('native 1.0: events in the server shape import with name keys (old "<nick>-<im id>" keys dropped)', () => {
  const ev = (o) => ({ event_id: '', sequence_number: 0, event_type: 'dialogue', content: '', speaker_key: '', speaker_display_name: '', speaker_role: 'pc',
    timestamp: null, time_text: '', scene_key: '', scene_title: '', visibility_scope: 'public', source_reference: {}, dice: null, media: null, metadata: {}, raw_text: null, unrecognised: false, ...o });
  const j = { schemaVersion: '1.0', generator: 'acerciae-log-studio', meta: {}, events: [
    ev({ event_type: 'system', speaker_role: 'system', content: '前言', unrecognised: true }),
    ev({ event_type: 'narration', content: 'Rain.', speaker_key: 'KP-QQ:1', speaker_display_name: 'KP', speaker_role: 'gm', timestamp: 1683375072, scene_title: 'Pier', visibility_scope: 'gm' }),
    ev({ event_type: 'dice_roll', content: 'D100=37/55 成功', speaker_key: 'Ann-QQ:2', speaker_display_name: 'Ann', timestamp: 1683375080,
      dice: { expression: '1d100', rolls: [37], total: 37, check_name: '', outcome: '成功', raw: 'D100=37/55 成功' }, media: [{ kind: 'image', cq: '[CQ:image,file=a.png]', file: 'a.png' }] }),
    ev({ content: 'hi', speaker_key: 'Ann-QQ:9', speaker_display_name: 'Ann', timestamp: 1683375090 }),
    'not an object',
  ], extensions: {} };
  const text = JSON.stringify(j);
  assert.equal(S.detectAdapter(text).name, 'native_json');
  const log = S.importText('old.json', text);
  assert.equal(log.format_version, '1.0');
  assert.equal(log.events.length, 5);
  assert.deepEqual(log.events.map((e) => e.speaker_key), ['', 'KP', 'Ann', 'Ann#2', '']);
  assert.ok(log.events[0].unrecognised);
  assert.deepEqual([log.events[1].role, log.events[1].type, log.events[1].scene_title, log.events[1].visibility], ['gm', 'narration', 'Pier', 'gm']);
  assert.deepEqual(log.events[2].dice.rolls, [37]);
  assert.deepEqual(log.events[2].media, [{ kind: 'image', file: 'a.png' }]);
  assert.ok(log.events[4].unrecognised && log.events[4].content === '"not an object"');
  assert.equal(log.issues.length, 1);
  assert.ok(!JSON.stringify(log.speakers).includes('QQ'));
  assert.throws(() => S.importText('bad.json', JSON.stringify({ schemaVersion: '9.0', events: [] })), /schemaVersion/);
});

const V2 = {
  format: 'acerciae-log', schemaVersion: '2.0', generator: 'acerciae', exported_at: '2026-10-31T10:00:00Z',
  campaign: { name: 'Harbour', era: '1920s', description: 'A foggy port.', viewer: 'gm' },
  players: [{ username: 'kp', display_name: 'KP', role: 'gm', avatar_url: null }, { username: 'ann', display_name: 'Ann', role: 'player', avatar_url: 'https://x/a.png' }],
  characters: [
    { name: 'Ada', kind: 'pc', player: 'ann', bio: 'Librarian.', speaking_style: 'terse', appearance_prompt: 'tall, grey coat', role_card: { basic: { occupation: 'Librarian' } },
      avatar_url: 'https://media.example/ada.png', portrait_url: null, poses: { SAY: 'https://media.example/ada-say.png' } },
    { name: 'Officer Hale', kind: 'npc', player: null, bio: '', speaking_style: '', appearance_prompt: '', role_card: null, avatar_url: null, portrait_url: null, poses: {} },
  ],
  windows: [{ name: 'Main Chat', kind: 'main' }],
  scenarios: [{ sequence: 1, title: 'The pier', location: 'Docks', narrative_time: 'night', summary: '', status: 'closed' }],
  messages: [
    { time: '2026-10-02T21:41:06Z', time_text: '', window: 'Main Chat', scenario: 1, speaker: 'Keeper', character: null, player: 'kp', role: 'gm', type: 'narration', content: 'Rain.', dice: null, visibility: 'public' },
    { time: '2026-10-02T21:42:00Z', time_text: '', window: 'Main Chat', scenario: 1, speaker: 'Officer Hale', character: 'Officer Hale', player: 'kp', role: 'npc', type: 'dialogue', content: '"Move along."', dice: null, visibility: 'public' },
    { time: '2026-10-02T21:43:45Z', time_text: '', window: 'Main Chat', scenario: 1, speaker: 'Ada', character: 'Ada', player: 'ann', role: 'pc', type: 'dice_roll', content: '.ra spot 60',
      dice: { expression: '1d100', total: 37, outcome: 'hard success', check_name: 'spot', text: 'Ada: 37/60' }, visibility: 'private' },
  ],
};

test('native 2.0: campaign, characters, messages', () => {
  const log = S.importText('h.acerciae-log.json', JSON.stringify(V2));
  assert.equal(log.adapter, 'native_json');
  assert.equal(log.format_version, '2.0');
  assert.deepEqual(log.campaign, { name: 'Harbour', era: '1920s', description: 'A foggy port.' });
  const [rain, hale, ada] = log.events;
  assert.deepEqual([rain.speaker_key, rain.role, rain.type, rain.scene_title, rain.window, rain.player, rain.time], ['Keeper', 'gm', 'narration', 'The pier', 'Main Chat', 'kp', 1790977266]);
  assert.deepEqual([hale.speaker_key, hale.role], ['Officer Hale', 'npc']);
  assert.deepEqual([ada.dice.total, ada.dice.check_name, ada.dice.raw, ada.visibility, ada.player], [37, 'spot', 'Ada: 37/60', 'private', 'ann']);
  assert.equal(log.characters.length, 2);
  const c = log.characters[0];
  assert.deepEqual([c.name, c.kind, c.player, c.appearance, c.avatar, c.portrait, c.speakers, c.voice, c.bio], ['Ada', 'pc', 'ann', 'tall, grey coat', 'https://media.example/ada.png', null, ['Ada'], '', 'Librarian.']);
  assert.deepEqual(c.poses, { SAY: 'https://media.example/ada-say.png' });
  assert.deepEqual(c.role_card, { basic: { occupation: 'Librarian' } });
  assert.deepEqual(log.characters[1].speakers, ['Officer Hale']);

  const p = S.buildProject({ title: '', background: { title: '', era: '', setting: '', summary: 'notes' }, files: [{ file: 'h.json', log }] });
  assert.deepEqual(p.background, { title: 'Harbour', era: '1920s', setting: 'A foggy port.', summary: 'notes' });
  assert.equal(p.title, 'Harbour');
  // Native characters, plus a gm sheet for the Keeper who has none.
  assert.deepEqual(p.characters.map((x) => [x.name, x.kind]), [['Ada', 'pc'], ['Officer Hale', 'npc'], ['Keeper', 'gm']]);
});

function messagesOf(log) {
  return log.events.map((e) => [e.speaker_name, e.time, e.time_text, e.content, e.type, e.role, e.scene_title, e.window, e.player ?? null, e.dice && [e.dice.expression, e.dice.total, e.dice.outcome, e.dice.check_name, e.dice.raw]]);
}

test('native 2.0 round trip: toNativeV2 → import → the same messages', () => {
  // From a 2.0 file.
  const log = S.importText('h.json', JSON.stringify(V2));
  const project = S.buildProject({ title: 'Harbour', background: { title: '', era: '', setting: '', summary: '' }, files: [{ file: 'h.json', log }] });
  const out = S.toNativeV2(project, { exportedAt: '2026-10-31T00:00:00Z' });
  assert.equal(out.format, 'acerciae-log');
  assert.equal(out.schemaVersion, '2.0');
  assert.deepEqual(out.messages, V2.messages);
  assert.deepEqual(out.characters, V2.characters);
  assert.deepEqual(out.scenarios.map((s) => [s.sequence, s.title]), [[1, 'The pier']]);
  assert.deepEqual(out.windows, [{ name: 'Main Chat', kind: 'main' }]);
  assert.deepEqual(out.players, [{ username: 'kp', display_name: 'kp', role: 'gm' }, { username: 'ann', display_name: 'ann', role: 'player' }]);
  const back = S.importText('again.json', JSON.stringify(out));
  assert.deepEqual(messagesOf(back), messagesOf(log));

  // From a plain log: export, import, export again → identical messages.
  const plain = S.importText('s.txt', PLAIN);
  const p1 = S.buildProject({ title: 'S', background: { title: '', era: '', setting: '', summary: '' }, files: [{ file: 's.txt', log: plain }] });
  assert.deepEqual(p1.characters.map((c) => [c.name, c.kind, c.speakers]), [['Sylvan', 'pc', ['Sylvan']], ['Keeper', 'gm', ['Keeper']]]);
  const v2 = S.toNativeV2(p1);
  assert.equal(v2.messages[0].time, '2026-10-02T21:41:06Z');
  assert.equal(v2.messages[0].character, 'Sylvan');
  const again = S.importText('s.json', JSON.stringify(v2));
  assert.deepEqual(messagesOf(again), messagesOf(plain));
  const p2 = S.buildProject({ title: 'S', background: { title: '', era: '', setting: '', summary: '' }, files: [{ file: 's.json', log: again }] });
  assert.deepEqual(S.toNativeV2(p2).messages, v2.messages);
});

test('native 1.0 round trip of a SealDice text log keeps text verbatim', () => {
  // The server's toNativeJson shape, written by hand from an imported log.
  const log = S.importText('s.txt', PLAIN + '\n');
  const j = { schemaVersion: '1.0', meta: {}, events: log.events.map((e) => ({ sequence_number: e.seq, event_type: e.type, content: e.content, speaker_key: e.speaker_key + '-QQ:1234567',
    speaker_display_name: e.speaker_name, speaker_role: e.role, timestamp: e.time, time_text: e.time_text, scene_title: '', dice: null, media: null, raw_text: e.raw, unrecognised: false })) };
  const back = S.importText('s.json', JSON.stringify(j));
  assert.deepEqual(messagesOf(back), messagesOf(log));
  assert.deepEqual(back.speakers.map((s) => s.key), ['Sylvan', 'Keeper']);
});

test('mergeLogs: time order, overlap duplicates dropped, speakers merged, seq and source.file', () => {
  const a = S.importText('part1.txt',
    'Before the session.\n' +
    'Sylvan(1) 2026/10/02 21:41:06\nI look around.\n\n' +
    'Keeper(2) 2026/10/02 21:43:45\nThe room is dark.\n\n' +
    'Sylvan(1) 2026/10/02 21:44:00\nok\n\n' +
    'Sylvan(1) 2026/10/02 21:44:00\nok\n');
  const b = S.importText('part2.txt',
    'Keeper(2) 2026/10/02 21:43:45\nThe room is dark.\n\n' +       // overlap with part1
    'Sylvan(1) 2026/10/02 21:44:00\nok\n\n' +                       // overlap (part1 has it twice: both kept, this one dropped)
    'Mira(3) 2026/10/02 21:42:00\nI follow.\n\n' +                  // earlier than part1's second message
    'Keeper(2) 2026/10/02 21:50:00\nA noise.\n');
  // Pretend part2 knew Sylvan as an NPC: a role other than "pc" wins when speakers merge.
  b.speakers.find((s) => s.key === 'Sylvan').role = 'npc';
  const m = S.mergeLogs([{ file: 'part1.txt', log: a }, { file: 'part2.txt', log: b }]);
  assert.deepEqual(m.events.map((e) => [e.speaker_key, e.content.trim(), e.source.file]), [
    ['', 'Before the session.', 'part1.txt'],
    ['Sylvan', 'I look around.', 'part1.txt'],
    ['Mira', 'I follow.', 'part2.txt'],
    ['Keeper', 'The room is dark.', 'part1.txt'],
    ['Sylvan', 'ok', 'part1.txt'],
    ['Sylvan', 'ok', 'part1.txt'],
    ['Keeper', 'A noise.', 'part2.txt'],
  ]);
  assert.deepEqual(m.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(m.speakers.map((s) => [s.key, s.role, s.message_count]), [['Sylvan', 'npc', 3], ['Keeper', 'gm', 2], ['Mira', 'pc', 1]]);
  assert.equal(m.issues.length, 1);
  assert.equal(m.issues[0].file, 'part1.txt');
  // Inputs are not modified.
  assert.equal(a.events[1].seq, 2);

  // Without times everywhere: file after file.
  const c = S.importText('c.txt', 'Ann(1) 21:00:00\nfirst\n');
  const d = S.importText('d.txt', 'Bob(2) 2026/10/02 20:00:00\nsecond\n');
  assert.deepEqual(S.mergeLogs([{ file: 'c.txt', log: c }, { file: 'd.txt', log: d }]).events.map((e) => e.speaker_key), ['Ann', 'Bob']);
  // Same time: file order.
  const e1 = S.importText('e1.txt', 'Ann(1) 2026/10/02 20:00:00\nx\n'), e2 = S.importText('e2.txt', 'Bob(1) 2026/10/02 20:00:00\ny\n');
  assert.deepEqual(S.mergeLogs([{ file: 'e2.txt', log: e2 }, { file: 'e1.txt', log: e1 }]).events.map((e) => e.speaker_key), ['Bob', 'Ann']);
});

test('buildProject: one sheet per gm/pc/npc speaker, sources, ids; text exports', () => {
  const t0 = Date.UTC(2026, 9, 2, 21, 0, 0) / 1000;
  const log = S.importText('x.json', JSON.stringify({ version: 105, items: [
    { nickname: 'Keeper', IMUserId: 'QQ:1', time: t0, message: 'Dark.', isDice: false },
    { nickname: '海豹骰娘', IMUserId: 'QQ:2', time: t0 + 5, message: 'D100=3/50 大成功', isDice: true },
    { nickname: 'Ann (B)', IMUserId: 'QQ:3', time: t0 + 9, message: '"Hi"\nsecond line', isDice: false },
  ] }));
  const p = S.buildProject({ title: 'T', background: { title: 'T', era: '', setting: '', summary: '' }, files: [{ file: 'x.json', log }] });
  assert.match(p.id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(p.created_at)));
  assert.deepEqual(p.sources.map((s) => [s.file, s.adapter, s.events]), [['x.json', 'sealdice_json', 3]]);
  assert.deepEqual(p.characters.map((c) => [c.name, c.kind, c.speakers, c.avatar, c.appearance]), [['Keeper', 'gm', ['Keeper'], null, ''], ['Ann (B)', 'pc', ['Ann (B)'], null, '']]);

  const sd = S.toSealDiceText(p);
  assert.equal(sd.split('\n')[0], 'Keeper(1) 2026/10/02 21:00:00');
  assert.ok(sd.includes('Ann （B）(3) 2026/10/02 21:00:09\n"Hi"\nsecond line\n\n'));
  const re = S.importText('re.txt', sd);
  assert.equal(re.adapter, 'sealdice_text');
  assert.deepEqual(re.events.map((e) => [e.speaker_name, e.time, e.content.trim()]), p.events.map((e) => [e.speaker_name.replace('(', '（').replace(')', '）'), e.time, e.content.trim()]));

  const plain = S.toPlainText(p);
  assert.equal(plain.split('\n')[0], '2026/10/02 21:00:00 <Keeper>: Dark.');
});

test('platform ids are dropped from the kept source text too, the message text stays as written', () => {
  const lib = (() => { const out = require('esbuild').buildSync({ entryPoints: [require('path').join(__dirname, '../src/openstudio/import/index.ts')], bundle: true, format: 'cjs', platform: 'node', write: false }); const m = { exports: {} }; new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require); return m.exports; })();
  const text = 'Sylvan(1234567) 2026/10/02 21:41:06\nMy number is (1234567), call me.\nKeeper(7654321) 2026/10/02 21:43:45\nSOMETHING';
  const log = lib.importFile('a.txt', new TextEncoder().encode(text));
  assert.equal(log.events[0].content.trim(), 'My number is (1234567), call me.');
  assert.ok(!log.events[0].raw.split('\n')[0].includes('1234567'), log.events[0].raw);
  assert.ok(log.events[0].raw.includes('My number is (1234567), call me.'));
  assert.ok(!JSON.stringify(log.events[1]).includes('7654321'));
  const js = lib.importFile('b.json', new TextEncoder().encode(JSON.stringify({ version: 105, items: [{ nickname: 'Mira', IMUserId: 'QQ:2223334', time: 1790977502, message: 'hi', isDice: false, commandId: 0 }] })));
  assert.ok(!JSON.stringify(js).includes('2223334'));
});
