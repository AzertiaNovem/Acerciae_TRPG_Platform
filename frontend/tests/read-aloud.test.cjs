const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
// What the chat's read-aloud (Kokoro, English voices) says for a message: src/lib/speech/text.ts.
const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '../src/lib/speech/text.ts')], bundle: true, format: 'cjs', platform: 'node', write: false });
const mod = { exports: {} };
new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
const { spokenLine, speakableText, KOKORO_VOICES, VOICES, MAX_SPOKEN, modelForLanguage } = mod.exports;

const msg = (o) => ({ id: 'm', channel_id: 'c', chat_window_id: 'w', scene_id: null, author_id: 'u', author_role: 'player', character_id: null, character_name: null, author_name: 'Ann', kind: 'ic', content: '', visibility: 'window', whisper_to: [], seq: 1, created_at: '', ...o });

test('speakableText drops links, CQ codes, markdown and non-Latin scripts', () => {
  assert.equal(speakableText('**Look** at https://x.example/a [CQ:image,file=a.png] _now_!'), 'Look at now !');
  assert.equal(speakableText('门开了 The door opens.'), 'The door opens.');
  assert.equal(speakableText('Café, 3 coins — 50%'), 'Café, 3 coins — 50%');
});

test('spokenLine names a new speaker once, reads narration bare, dice by result, and skips what Kokoro cannot say', () => {
  const ada = msg({ character_name: 'Ada', content: 'Who is there?' });
  assert.deepEqual(spokenLine(ada, null), { text: 'Ada: Who is there?', speaker: 'Ada' });
  assert.deepEqual(spokenLine(ada, 'Ada'), { text: 'Who is there?', speaker: 'Ada' });
  assert.equal(spokenLine(msg({ kind: 'narration', author_role: 'gm', author_name: 'Keeper', content: 'Rain falls.' }), 'Ada').text, 'Rain falls.');
  assert.equal(spokenLine(msg({ kind: 'ooc', character_name: 'Ada', content: 'brb' }), 'Ada').text, 'Ann: brb');   // out of character: the player
  assert.equal(spokenLine(msg({ kind: 'roll', content: '.r 1d100', dice: { type: 'roll', command: 'r', text: 'Ann rolls 1d100 = 42' } }), 'Ann').text, 'Ann rolls 1d100 = 42');
  assert.equal(spokenLine(msg({ kind: 'system', content: 'Ann joined' }), null), null);
  assert.equal(spokenLine(msg({ content: '你好，世界' }), null), null);
  assert.equal(spokenLine(msg({ character_name: '艾达', content: 'Hello.' }), null).text, 'Hello.');   // a name it cannot say is left out
  assert.equal(spokenLine(msg({ content: 'a '.repeat(900) }), 'Ann').text.length, MAX_SPOKEN);
});

test('the voice list is Kokoro English voices, Heart first', () => {
  assert.equal(KOKORO_VOICES[0].id, 'af_heart');
  assert.ok(KOKORO_VOICES.every((v) => /^[ab][fm]_[a-z]+$/.test(v.id)));
});

test('the server language chooses the model: Chinese servers read with the Mandarin model, which keeps Chinese and English', () => {
  assert.equal(modelForLanguage('zh-CN'), 'zh'); assert.equal(modelForLanguage('zh-TW'), 'zh');
  for (const l of ['en', 'ja', 'ko', 'fr', '', null, undefined]) assert.equal(modelForLanguage(l), 'en', String(l));
  assert.equal(speakableText('门开了，Ada 说：「快走！」 https://x.example 😀', 'zh'), '门开了，Ada 说：「快走！」');
  assert.equal(speakableText('門が開いた', 'zh'), '門 開');   // kana is not Chinese: only the Han characters stay
  const ada = msg({ character_name: '艾达', content: '谁在那里？' });
  assert.deepEqual(spokenLine(ada, null, 'zh'), { text: '艾达：谁在那里？', speaker: '艾达' });
  assert.deepEqual(spokenLine(ada, '艾达', 'zh'), { text: '谁在那里？', speaker: '艾达' });
  assert.equal(spokenLine(msg({ content: 'Hello there.' }), null, 'zh').text, 'Ann：Hello there.');
  assert.equal(spokenLine(msg({ content: '😀😀' }), null, 'zh'), null);
  assert.equal(spokenLine(ada, null, 'en'), null, 'the English model skips Chinese');
  assert.ok(VOICES.zh.length >= 20 && VOICES.zh.every((v) => /^z[fm]_\d{3}$/.test(v.id) && v.female === (v.id[1] === 'f')));
  assert.equal(VOICES.zh[0].id, 'zf_001');
});
