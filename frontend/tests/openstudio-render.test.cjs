const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
// Open Log Studio renderers: the styled HTML log and the print-ready book, bundled from TypeScript with esbuild.
function load() {
  const out = require('esbuild').buildSync({
    entryPoints: [path.join(__dirname, '../src/openstudio/render/index.ts')],
    bundle: true, format: 'cjs', platform: 'node', write: false,
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const { styledHtml, printHtml, defaultPdfConfig, normalizePdfConfig, safeUrl } = load();

const ev = (seq, type, speaker_key, speaker_name, role, content, extra = {}) => ({
  seq, type, content, speaker_key, speaker_name, role, time: 1700000000 + seq * 60, time_text: '', scene_title: '序章 · The Library',
  window: '', dice: null, media: null, raw: content, unrecognised: false, source: { file: 'log.txt', adapter: 'sealdice_text', line: seq }, ...extra,
});
const scene2 = { scene_title: '第二幕 · The Cellar' };
const project = {
  id: 'p1', title: 'Project title', created_at: '', updated_at: '',
  background: { title: '雾都疑案 Fog City', era: '1920s 上海', setting: '法租界的旧图书馆', summary: 'Investigators look for a missing ledger.' },
  sources: [], speakers: [], issues: [],
  characters: [
    { name: '林雪 Lin Xue', speakers: ['xue'], kind: 'pc', player: 'alice', appearance: '短发，风衣', role_card: { STR: 50, skills: { 侦查: 60 } }, avatar: 'assets/lin.png', portrait: null, poses: {}, voice: '' },
    { name: 'Keeper', speakers: ['kp'], kind: 'gm', player: 'bob', appearance: '', role_card: null, avatar: 'javascript:alert(1)', portrait: null, poses: {}, voice: '' },
    { name: 'Hidden Watcher', speakers: ['ob1'], kind: 'npc', player: '', appearance: '', role_card: null, avatar: null, portrait: null, poses: {}, voice: '' },
  ],
  events: [
    ev(1, 'narration', 'kp', 'KP', 'gm', '雨夜，图书馆的灯还亮着。'),
    ev(2, 'dialogue', 'xue', 'xue_player', 'pc', 'I check the top shelf for the ledger.'),
    ev(3, 'dice_roll', 'bot', '海豹', 'dice', '<xue>进行侦查检定: D100=45/60 成功', { dice: { expression: 'D100', rolls: [45], total: 45, check_name: '侦查', outcome: '成功', raw: 'D100=45/60' } }),
    ev(4, 'ooc', 'alice', 'alice', 'pc', '(brb, getting tea) OOC-MARKER'),
    ev(5, 'secret', 'kp', 'KP', 'gm', 'SECRET-MARKER the ledger is fake'),
    ev(6, 'dialogue', 'ob1', 'ob1', 'hidden', 'WATCHER-MARKER I see everything'),
    ev(7, 'scene_change', 'kp', 'KP', 'gm', '地下室 / Cellar', scene2),
    ev(8, 'dialogue', 'mallory', 'Mallory', 'npc', 'Look: <script>alert(1)</script> & "quotes"', scene2),
    ev(9, 'action', 'xue', 'xue_player', 'pc', '林雪推开了门，看见一行很长很长的中文没有空格也必须能换行显示出来。', scene2),
  ],
};
const assetUrl = (ref) => (ref.startsWith('assets/') ? `asset://localhost/project/${ref}` : null);
const base = { includeOoc: false, includeSecret: false, assetUrl };

test('styled HTML has the title, background and cast', () => {
  const html = styledHtml(project, base);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>雾都疑案 Fog City<\/title>/);
  for (const s of ['1920s 上海', '法租界的旧图书馆', 'Investigators look for a missing ledger.', '林雪 Lin Xue', 'alice', 'Keeper']) assert.ok(html.includes(s), s);
  assert.ok(html.includes('src="asset://localhost/project/assets/lin.png"'), 'avatar from assetUrl');
  assert.ok(!/javascript:/i.test(html), 'unsafe avatar URL dropped');
  // The watcher only ever speaks hidden lines: not in the cast unless secrets are shown.
  assert.ok(!html.includes('Hidden Watcher'));
  assert.ok(styledHtml(project, { ...base, includeSecret: true }).includes('Hidden Watcher'));
});

test('lines are grouped by scene, in order, with the scene change shown', () => {
  const html = styledHtml(project, base);
  const a = html.indexOf('序章 · The Library'), b = html.indexOf('第二幕 · The Cellar');
  assert.ok(a > 0 && b > a, 'both scenes, in order');
  assert.equal((html.match(/class="scene-title"/g) || []).length, 2);
  assert.ok(html.indexOf('雨夜') > a && html.indexOf('雨夜') < b);
  assert.ok(html.indexOf('Mallory') > b);
  assert.ok(html.includes('<div class="scene">地下室 / Cellar</div>'));
});

test('OOC and secret lines are left out by default and shown when asked', () => {
  const plain = styledHtml(project, base);
  for (const m of ['OOC-MARKER', 'SECRET-MARKER', 'WATCHER-MARKER']) assert.ok(!plain.includes(m), m);
  const ooc = styledHtml(project, { ...base, includeOoc: true });
  assert.ok(ooc.includes('OOC-MARKER') && !ooc.includes('SECRET-MARKER'));
  const all = styledHtml(project, { ...base, includeOoc: true, includeSecret: true });
  for (const m of ['OOC-MARKER', 'SECRET-MARKER', 'WATCHER-MARKER']) assert.ok(all.includes(m), m);
  assert.match(all, /class="msg secret"/);
});

test('dice results are shown, text is escaped, characters replace speaker names', () => {
  const html = styledHtml(project, base);
  assert.ok(html.includes('侦查 D100 = 45 · 成功'), 'dice summary');
  assert.match(html, /class="dice-chip ok"/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;'));
  assert.ok(!/<script/i.test(html), 'no script tag');
  assert.ok(html.includes('&lt;xue&gt;进行侦查检定'));
  assert.ok(!html.includes('xue_player'), 'raw speaker name replaced by the character');
  const lin = [...html.matchAll(/<span class="name" style="color:(#[0-9a-f]{6})">林雪 Lin Xue<\/span>/gi)].map((m) => m[1]);
  assert.equal(lin.length, 2);
  assert.equal(new Set(lin).size, 1, 'one colour per character');
  assert.ok(html.includes('style="color:#d7b26d">Keeper<'), 'GM colour');
  assert.ok(html.includes('Mallory'), 'unmapped speaker keeps its name');
});

test('print HTML follows the page setup', () => {
  const cfg = { ...defaultPdfConfig('classic'), page_size: 'A4', orientation: 'landscape', margin_mm: 22, font: 'sans', font_size: 12, line_height: 1.5, header: 'Head "X" </style><script>', footer: 'Foot', title: 'Book <Title>', subtitle: 'Sub' };
  const html = printHtml(project, cfg, base);
  assert.match(html, /@page\{size:297mm 210mm;margin:22mm;/);
  assert.ok(html.includes('@top-center{content:"Head \\22 X\\22  \\3c /style\\3e \\3c script\\3e "'), 'header is a safe CSS string');
  assert.ok(html.includes('@bottom-center{content:counter(page)'));
  assert.ok(html.includes('font-size:12pt;line-height:1.5'));
  assert.ok(html.includes('"Microsoft YaHei"') && html.includes('"Noto Sans CJK SC"'), 'CJK fallbacks');
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('<h1>Book &lt;Title&gt;</h1>') && html.includes('Sub'));
  assert.match(html, /break-inside:avoid/);
  const a5 = printHtml(project, defaultPdfConfig('novel'), base);
  assert.match(a5, /@page\{size:148mm 210mm;margin:18mm;/);
  assert.ok(!a5.includes('@top-center'), 'no header box without a header');
  assert.ok(a5.includes('text-indent:1em'), 'novel theme');
});

test('print HTML honours the template switches', () => {
  const on = { ...defaultPdfConfig(), include_ooc: true, timestamps: true, toc: true, page_numbers: true, chapter_breaks: true, dice_style: 'box' };
  const html = printHtml(project, on, { ...base, includeOoc: true });
  assert.ok(html.includes('OOC-MARKER'));
  assert.match(html, /<nav class="toc"/);
  assert.match(html, /<time title="2023-11-14 22:14:20">2023-11-14 22:14<\/time>/);
  assert.match(html, /<aside class="dice ok">侦查 D100 = 45 · 成功<\/aside>/);
  assert.match(html, /<section class="chapter" id="s1">/);
  assert.ok(html.includes('id="cast"') && html.includes('侦查') && html.includes('STR'));
  const off = printHtml(project, { ...on, include_ooc: false, timestamps: false, toc: false, page_numbers: false, chapter_breaks: false, dice_style: 'inline' }, { ...base, includeOoc: true });
  assert.ok(!off.includes('OOC-MARKER'), 'template include_ooc off');
  assert.ok(!off.includes('<nav') && !off.includes('<time') && !off.includes('counter(page)'));
  assert.match(off, /<section class="chapter flow" id="s1">/);
  assert.match(off, /<span class="dice-inline ok">/);
  const hidden = printHtml(project, { ...on, dice_style: 'hide' }, base);
  assert.ok(!hidden.includes('<aside') && !hidden.includes('class="dice-inline') && hidden.includes('D100=45/60'), 'hide drops the dice box, keeps the line');
  // The export options still gate the template: OOC needs both, secrets need includeSecret.
  assert.ok(!printHtml(project, on, base).includes('OOC-MARKER'));
  assert.ok(!printHtml(project, on, base).includes('SECRET-MARKER'));
  assert.ok(printHtml(project, on, { ...base, includeSecret: true }).includes('SECRET-MARKER'));
});

test('print HTML colours, images and config clean-up', () => {
  const cfg = { ...defaultPdfConfig('dossier'), character_colors: { xue: '#112233', kp: 'red;background:url(x)' }, cover_asset_id: 'assets/cover.png', scene_images: { '第二幕 · The Cellar': 'assets/cellar.png' } };
  const html = printHtml(project, cfg, base);
  assert.ok(html.includes('style="color:#112233">林雪 Lin Xue<'));
  assert.ok(!html.includes('url(x)'));
  assert.ok(html.includes('src="asset://localhost/project/assets/cover.png"') && html.includes('src="asset://localhost/project/assets/cellar.png"'));
  assert.ok(html.includes('#faf7ed'), 'dossier theme');
  const n = normalizePdfConfig({ page_size: 'Letter', margin_mm: 99, font_size: 'x', base: 'nope' });
  assert.equal(n.page_size, 'A5'); assert.equal(n.margin_mm, 40); assert.equal(n.font_size, 11); assert.equal(n.base, 'classic');
});

test('URLs are limited to safe schemes', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl(' JaVaScRiPt:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,<b>'), null);
  assert.equal(safeUrl('https://x.test/a.png'), 'https://x.test/a.png');
  assert.equal(safeUrl('assets/a.png'), 'assets/a.png');
  assert.ok(safeUrl('data:image/png;base64,AAAA'));
  const p = { ...project, events: [ev(1, 'media', 'xue', 'x', 'pc', '', { media: [{ kind: 'image', url: 'javascript:alert(1)' }, { kind: 'image', file: 'assets/pic.png' }, { kind: 'audio', url: 'https://x.test/a.mp3' }] })] };
  const html = styledHtml(p, base);
  assert.ok(!/javascript:/i.test(html));
  assert.ok(html.includes('src="asset://localhost/project/assets/pic.png"'));
  assert.ok(html.includes('href="https://x.test/a.mp3"'));
});
