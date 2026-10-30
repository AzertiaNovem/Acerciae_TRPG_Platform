const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const copy = x => JSON.parse(JSON.stringify(x));
const initial = () => ({ character: { id: 'c', name: 'Ada', editable: true, kind: 'pc', speaking_style: '', bio: '', asset_mode: 'uploaded', appearance_prompt: '', role_card: { basic: {}, characteristics: { STR: 50 }, derived: { db: '' }, skills: {}, background: {}, items: [], wealth: {} } }, points: { enabled: false }, avatar: null, portrait: null, jobs: [], subtitles: [], generation_available: true });
function harness() {
  const slots = [], effects = [], requests = [], events = new Map(); let cursor = 0, server = initial(), deferSave, epoch = 0;
  const hook = {
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(value) { const index = cursor++; if (!(index in slots)) slots[index] = { current: value }; return slots[index]; },
    useEffect(effect, deps) { const index = cursor++; const old = slots[index]; if (!old || deps.some((d, i) => d !== old.deps[i])) { slots[index] = { deps }; effects.push(() => { old?.cleanup?.(); slots[index].cleanup = effect(); }); } },
  };
  const api = {
    characterSpace: async () => copy(server),
    updateCharacterAppearance: async (_ch, _id, look) => { server.character = { ...server.character, ...look }; return copy(server); },
    updateCharacterCard: async (_ch, _id, body) => { requests.push(copy(body)); if (deferSave) await deferSave; server.character = { ...server.character, ...copy(body) }; return copy(server); },
  };
  const mod = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/CharacterSpace.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const requireMock = name => ({ react: hook, '../api/client': { api }, '../store/nav': { useNav: () => ({ channelId: 'channel', characters: [], channel: { my_role: 'gm' }, openCharacter() {} }) }, '../store/ui': { useUi: select => select({ toast() {} }) }, '../i18n': { t: s => s }, '../store/session': { sessionEpoch: () => epoch }, './PointBuy': { default: () => null } }[name] || require(name));
  new Function('require', 'module', 'exports', source)(requireMock, mod, mod.exports);
  global.window = { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) };
  return { requests, api, events, render() { cursor = 0; const tree = mod.exports.default({ characterId: 'c' }); while (effects.length) effects.shift()(); return tree; }, async flush() { await new Promise(r => setImmediate(r)); }, holdSave(promise) { deferSave = promise; }, changeSession() { ++epoch; } };
}
function all(tree, predicate) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(t => all(t, predicate)); return [...(predicate(tree) ? [tree] : []), ...all(tree.props?.children, predicate)]; }
const button = (tree, label) => all(tree, n => n.type === 'button' && n.props.children === label)[0];
const strength = tree => all(tree, n => n.props?.className === 'cell' && all(n, x => x.type === 'b' && x.props.children === 'STR').length)[0].props.children[1];
const edit = (h, value) => strength(h.render()).props.onChange({ target: { value: String(value) } });

test('role-card save action is always present; changing image mode cannot discard attributes', async () => {
  const h = harness(); h.render(); await h.flush();
  let tree = h.render(); assert.equal(button(tree, 'Save').props.disabled, true);
  edit(h, 75); tree = h.render(); assert.equal(button(tree, 'Save').props.disabled, false);
  button(tree, 'Appearance & images').props.onClick(); tree = h.render();
  await button(tree, 'Generated assets').props.onClick(); await h.flush();
  button(h.render(), 'Role card').props.onClick(); tree = h.render();
  assert.equal(strength(tree).props.value, 75); assert.equal(button(tree, 'Save').props.disabled, false);
  await button(tree, 'Save').props.onClick(); tree = h.render();
  assert.equal(h.requests[0].role_card.characteristics.STR, 75);
  assert.equal(strength(tree).props.value, 75); assert.equal(button(tree, 'Save').props.disabled, true);
});

test('late save acknowledgements preserve newer edits; failed saves keep the draft and show the error', async () => {
  const h = harness(); h.render(); await h.flush(); edit(h, 70);
  let resolve; h.holdSave(new Promise(r => { resolve = r; }));
  const pending = button(h.render(), 'Save').props.onClick();
  edit(h, 85); resolve(); await pending;
  assert.equal(strength(h.render()).props.value, 85); assert.equal(button(h.render(), 'Save').props.disabled, false);
  let prevented = false; h.events.get('beforeunload')({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  h.api.updateCharacterCard = async () => { throw Error('points_rule: budget exceeded'); };
  await button(h.render(), 'Save').props.onClick();
  assert.equal(strength(h.render()).props.value, 85);
  assert.match(all(h.render(), n => n.props?.role === 'alert')[0].props.children, /budget exceeded/);
});
