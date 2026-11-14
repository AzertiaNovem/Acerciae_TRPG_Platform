// Interactive messages (kind hypertext, docs/HYPERTEXT.md) in the UI shared by web and desktop, over a real REST +
// WebSocket round trip on an isolated local backend. A GM account posts the cards through REST; players use them in the
// browser: a card renders with its controls and pill, a declarative roll posts a real roll as the player's character,
// a checkbox is saved and reaches the same player's other device live (hypertext.state), a whisper card's lines never
// reach a third player, a script's free-text line waits for the viewer's confirmation, two cards with the same choice
// id keep their own values, and an Enter inside an IME composition does not submit an input. Also: the newest card's
// confirmation opens in view and takes the focus, an out-of-character line names the account, a change undone while its
// save is in flight is kept, a line speaks as the composer's "Speak as" character, keys moving through a scripted choice
// do not run it (chromium), and long words wrap at phone width.
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const site = process.env.WEB_BASE || 'http://127.0.0.1:5196';
if (!['127.0.0.1', 'localhost'].includes(new URL(site).hostname)) throw Error('Use a local test server.');
const engine = process.argv[2] || 'chromium';
const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: process.env.CHROME_CHANNEL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 15000) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > timeout) throw Error('timeout waiting for ' + label); await sleep(100); }
}
try {
  const rest = await browser.newContext({ baseURL: site });
  async function api(method, path, body, token) {
    const res = await rest.request.fetch('/api' + path, { method, data: body, headers: token ? { Authorization: 'Bearer ' + token } : {} });
    assert.ok(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`); return res.json();
  }
  // The table: a GM, three players with a PC each (Ada, Bea, Cy) in the main window.
  const sfx = Date.now().toString(36);
  const u = {};
  for (const [n, display] of [['gm', 'Keeper'], ['ann', 'Ann'], ['bob', 'Bob'], ['cat', 'Cat']]) {
    u[n] = await api('POST', '/auth/register', { username: `browser_hx${n}_${sfx}`, display_name: display, password: 'password' });
    await api('PUT', '/auth/me', { ui_language: 'en' }, u[n].token);
  }
  const server = await api('POST', '/servers', { name: 'Interactive messages verification' }, u.gm.token);
  for (const n of ['ann', 'bob', 'cat']) await api('POST', `/servers/${server.id}/members`, { user_id: u[n].user.id, role: 'member' }, u.gm.token);
  const ch = (await api('POST', `/servers/${server.id}/channels`, { name: 'The manor', knowledge_mode: 'isolated' }, u.gm.token)).id;
  for (const n of ['ann', 'bob', 'cat']) await api('POST', `/channels/${ch}/members`, { user_id: u[n].user.id, role: 'player' }, u.gm.token);
  const pc = {};
  for (const [n, name] of [['ann', 'Ada'], ['bob', 'Bea'], ['cat', 'Cy']]) pc[n] = (await api('POST', `/channels/${ch}/characters`, { name }, u[n].token)).id;
  const ava = (await api('POST', `/channels/${ch}/characters`, { name: 'Ava' }, u.ann.token)).id;   // Ann's second PC
  const main = (await api('GET', `/channels/${ch}/windows`, undefined, u.gm.token)).find((w) => w.kind === 'main').id;
  const mainWindow = (await api('GET', `/channels/${ch}/windows`, undefined, u.ann.token)).find((w) => w.id === main);
  assert.equal(mainWindow.members.find((x) => x.user_id === u.ann.user.id).character_id, pc.ann, 'Ada is Ann\'s character in the window');
  const say = (content) => api('POST', `/channels/${ch}/windows/${main}/messages`, { content, kind: 'narration' }, u.gm.token);
  const post = (body) => api('POST', `/channels/${ch}/windows/${main}/hypertext`, body, u.gm.token);
  const lines = (who) => api('GET', `/channels/${ch}/windows/${main}/messages?limit=200`, undefined, u[who].token);
  const status = async (who, id) => (await api('GET', `/channels/${ch}/hypertext?ids=${id}`, undefined, u[who].token)).items[0];

  const intro = await say('The manor is quiet tonight.');
  // Card strings are plain text: markup in them is shown as typed, never interpreted.
  const roll = await post({ hypertext: { v: 1, title: 'Spot Hidden', state: { done: { type: 'bool' } }, actors: [pc.ann], body: [
    { type: 'text', text: 'Something glints under the desk. <b>Look</b> **closely**.' },
    { type: 'button', id: 'roll', label: 'Roll Spot Hidden', act: { set: { done: true }, say: '.ra Spot Hidden' }, enable_if: { key: 'done', eq: false } },
    { type: 'text', text: 'Rolled.', style: 'muted', tone: 'good', show_if: { key: 'done', eq: true } },
  ] } });
  const kit = await post({ hypertext: { v: 1, title: 'Before you go', state: { lantern: { type: 'bool' } }, body: [
    { type: 'checkbox', id: 'lantern', label: 'Pack the lantern', bind: 'lantern' },
    { type: 'text', text: 'The lantern is packed.', show_if: { key: 'lantern', eq: true } },
  ] } });
  // Two cards whose choice has the same id and key: radios in one must never move the other's.
  const door = (title) => post({ hypertext: { v: 1, title, state: { way: { type: 'enum', values: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }] } }, body: [
    { type: 'choice', id: 'way', label: 'Which way?', bind: 'way', display: 'list' },
    { type: 'text', text: `${title}: going {{way}}.`, show_if: { key: 'way', empty: false } },
  ] } });
  const north = await door('North door'), south = await door('South door');
  const sign = await post({ hypertext: { v: 1, title: 'The guest book', state: { name: { type: 'text', max: 40 } }, body: [
    { type: 'input', id: 'name', label: 'Your name', placeholder: 'Write your name', bind: 'name', submit_label: 'Sign' },
    { type: 'text', text: 'Signed: {{name}}', style: 'strong', show_if: { key: 'name', empty: false } },
  ] } });
  // A script's free-text line as the clicker needs their confirmation; its state shows meanwhile.
  const stairs = await post({ hypertext: { v: 1, title: 'The stairwell', runs_per_viewer: 3, state: { went: { type: 'bool' } }, body: [
    { type: 'text', text: 'The hall splits in two.' },
    { type: 'button', id: 'go', label: 'Take the stairs', on: 'go' },
    { type: 'text', text: 'You set off.', show_if: { key: 'went', eq: true } },
  ], script: "on('go', () => { state.went = true; say('I take the right stairs.'); });" } });
  const note = await post({ visibility: 'whisper', whisper_to: [pc.ann, pc.bob], hypertext: { v: 1, title: 'A note for two', body: [
    { type: 'text', text: 'Only Ada and Bea read this.' },
    { type: 'button', id: 'answer', label: 'Whisper back', act: { say: 'We should leave before dawn.' } },
  ] } });

  // A browser context is one device of one user. Its chat socket's frames are kept to tell a push from a refetch.
  const errors = [];
  async function device(who) {
    const ctx = await browser.newContext({ baseURL: site, viewport: { width: 1280, height: 1000 } });
    await ctx.addInitScript((token) => {
      localStorage.setItem('acerciae.token', token);
      const Original = window.WebSocket; window.chatFrames = [];
      window.WebSocket = class extends Original {
        constructor(...args) {
          super(...args);
          if (String(args[0]).includes('/ws/chat')) this.addEventListener('message', (e) => { try { window.chatFrames.push(JSON.parse(e.data)); } catch { /* not JSON */ } });
        }
      };
    }, u[who].token);
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    await page.goto(site);
    await subscribed(page);
    return page;
  }
  const subscribed = (page) => page.waitForFunction(() => window.chatFrames.some((f) => f.type === 'subscribed'));
  const pushed = (page, type, id) => page.evaluate(([type, id]) => window.chatFrames.some((f) => f.type === type && f.message_id === id), [type, id]);
  const row = (page, m) => page.locator('#msg-' + m.id);
  const enabled = (loc, label) => until(() => loc.isEnabled(), label);
  const checked = (loc, want, label) => until(async () => (await loc.isChecked()) === want, label);
  const via = async (who, card) => until(async () => (await lines(who)).find((x) => x.via_hypertext_id === card.id), `the line of ${card.hypertext.title}`);

  const annA = await device('ann'), annB = await device('ann'), bob = await device('bob'), cat = await device('cat');

  // A card renders: the sender's frame with the "Interactive message" pill, its title, text and controls; no Pin.
  const rollRow = row(annA, roll);
  await rollRow.getByText('Spot Hidden', { exact: true }).waitFor();
  await rollRow.getByText('Interactive message', { exact: true }).waitFor();
  await rollRow.getByText('Something glints under the desk. <b>Look</b> **closely**.', { exact: true }).waitFor();
  assert.equal(await rollRow.locator('b').count(), 0, 'card text is never markup');
  const rollButton = rollRow.getByRole('button', { name: 'Roll Spot Hidden', exact: true });
  await enabled(rollButton, 'the roll button once the status is loaded');
  await rollRow.getByText('.ra Spot Hidden', { exact: true }).waitFor();   // the "Posts:" caption of its literal line
  assert.equal(await rollRow.getByRole('button', { name: 'Pin', exact: true }).count(), 0, 'a card cannot be pinned');
  assert.equal(await row(annA, intro).getByRole('button', { name: 'Pin', exact: true }).count(), 1, 'a plain line can');
  await row(annA, kit).getByRole('checkbox', { name: 'Pack the lantern', exact: true }).waitFor();
  await row(annA, north).getByRole('radio', { name: 'Left', exact: true }).waitFor();
  await row(annA, sign).getByRole('textbox', { name: 'Your name', exact: true }).waitFor();
  await row(annA, sign).getByText('Anything you type here may be shared in the chat.').waitFor();
  // Bea is not one of the roll's actors: the same card is drawn for her with its controls off and the reason.
  await row(bob, roll).getByText('This message is for other characters.').waitFor();
  assert.ok(await row(bob, roll).getByRole('button', { name: 'Roll Spot Hidden', exact: true }).isDisabled());

  // The roll: a real roll posted as Ada through the normal path, with the via pill; then the button is done.
  await rollButton.click();
  const rolled = await via('ann', roll);
  assert.equal(rolled.author_id, u.ann.user.id); assert.equal(rolled.character_name, 'Ada');
  assert.ok(rolled.dice, 'the line is a roll'); assert.match(rolled.content, /^\.ra Spot Hidden/);
  const rolledRow = row(annA, rolled);
  await rolledRow.getByText('via interactive message').waitFor();
  assert.equal((await rolledRow.locator('.author').textContent()).trim(), 'Ada');
  await rollRow.getByText('Rolled.', { exact: true }).waitFor();
  assert.ok(await rollButton.isDisabled(), 'the roll button is off once rolled');
  await row(bob, rolled).getByText('via interactive message').waitFor();   // the whole window reads the roll, live

  // A checkbox: Ann's other device follows through the hypertext.state push; it survives a reload; Bob's is his own.
  const lantern = (page) => row(page, kit).getByRole('checkbox', { name: 'Pack the lantern', exact: true });
  await enabled(lantern(annB), 'the checkbox on the second device');
  assert.equal(await lantern(annB).isChecked(), false);
  await lantern(annA).check();
  await checked(lantern(annB), true, 'the second device to follow');
  await row(annB, kit).getByText('The lantern is packed.', { exact: true }).waitFor();
  assert.ok(await pushed(annB, 'hypertext.state', kit.id), 'the second device heard it as a push');
  await until(async () => (await status('ann', kit.id)).state?.lantern === true, 'the saved checkbox');
  await annA.reload();
  await enabled(lantern(annA), 'the checkbox after reload');
  assert.ok(await lantern(annA).isChecked(), 'the checkbox survives reload');
  await enabled(lantern(bob), 'Bob\'s checkbox');
  assert.equal(await lantern(bob).isChecked(), false, 'state is per viewer');
  assert.equal(await pushed(bob, 'hypertext.state', kit.id), false, 'no other user hears of it');

  // Two cards with the same choice id: each keeps its own radio, on screen and after a reload.
  const way = (m, label) => row(annA, m).getByRole('radio', { name: label, exact: true });
  await way(north, 'Left').check();
  await way(south, 'Right').check();
  const doors = async () => {
    assert.ok(await way(north, 'Left').isChecked()); assert.equal(await way(north, 'Right').isChecked(), false);
    assert.ok(await way(south, 'Right').isChecked()); assert.equal(await way(south, 'Left').isChecked(), false);
    await row(annA, north).getByText('North door: going Left.', { exact: true }).waitFor();
    await row(annA, south).getByText('South door: going Right.', { exact: true }).waitFor();
  };
  await doors();
  await until(async () => (await status('ann', north.id)).state?.way === 'left' && (await status('ann', south.id)).state?.way === 'right', 'both doors saved');
  await annA.reload();
  for (const m of [north, south]) await enabled(way(m, 'Left'), 'the doors after reload');
  await doors();

  // IME: an Enter that ends a composition is not a submit (isComposing, or Safari's keyCode 229); a plain Enter is.
  const nameBox = row(annA, sign).getByRole('textbox', { name: 'Your name', exact: true });
  await enabled(nameBox, 'the guest book input');
  await nameBox.fill('Ada Lovelace');
  for (const variant of ['isComposing', 'keyCode']) {
    const sent = await nameBox.evaluate((el, variant) => {
      const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: variant === 'isComposing' });
      if (variant === 'keyCode') Object.defineProperty(e, 'keyCode', { get: () => 229 });
      el.dispatchEvent(e);
      return variant === 'isComposing' ? e.isComposing : e.keyCode === 229;
    }, variant);
    assert.ok(sent, `the composing Enter (${variant}) was dispatched as such`);
  }
  await sleep(1200);   // longer than the save delay
  assert.equal(await row(annA, sign).getByText('Signed: Ada Lovelace').count(), 0, 'an IME Enter does not submit');
  assert.ok(!(await status('ann', sign.id)).state?.name, 'nor saves');
  assert.equal(await nameBox.inputValue(), 'Ada Lovelace', 'the draft stays in the field');
  await nameBox.press('Enter');
  await row(annA, sign).getByText('Signed: Ada Lovelace', { exact: true }).waitFor();
  await until(async () => (await status('ann', sign.id)).state?.name === 'Ada Lovelace', 'the submitted name');

  // A script's free-text line: "Post as Ada: …" waits for the viewer. Cancel reverts and sends nothing; Post sends it.
  const stairsRow = row(annA, stairs);
  const go = stairsRow.getByRole('button', { name: 'Take the stairs', exact: true });
  const confirm = stairsRow.getByRole('group', { name: 'Confirm', exact: true });
  await go.click();
  await confirm.getByText('Post as Ada: I take the right stairs.', { exact: true }).waitFor();
  await stairsRow.getByText('You set off.', { exact: true }).waitFor();   // the script's state, shown meanwhile
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await confirm.waitFor({ state: 'detached' });
  await stairsRow.getByText('You set off.', { exact: true }).waitFor({ state: 'detached' });
  await sleep(1200);
  assert.ok(!(await lines('ann')).some((x) => x.via_hypertext_id === stairs.id), 'Cancel posted nothing');
  const untouched = await status('ann', stairs.id);
  assert.ok(!untouched.state?.went, 'nor saved the script\'s state'); assert.equal(untouched.runs_left, 3, 'nor used a run');
  await go.click();
  await confirm.getByRole('button', { name: 'Post', exact: true }).click();
  const went = await via('ann', stairs);
  assert.equal(went.content, 'I take the right stairs.'); assert.equal(went.character_name, 'Ada'); assert.equal(went.kind, 'ic');
  await row(annA, went).getByText('via interactive message').waitFor();
  await confirm.waitFor({ state: 'detached' });
  await stairsRow.getByText('You set off.', { exact: true }).waitFor();
  const used = await status('ann', stairs.id);
  assert.equal(used.state?.went, true); assert.equal(used.runs_left, 2);

  // A whisper card: Ada and Bea read it and its answer, live; Cy never does, on screen, on the wire or after a reload.
  const noteText = ['A note for two', 'Only Ada and Bea read this.', 'We should leave before dawn.'];
  await row(bob, note).getByText('A note for two', { exact: true }).waitFor();
  await row(annA, note).getByRole('button', { name: 'Whisper back', exact: true }).click();
  const answer = await via('ann', note);
  assert.equal(answer.visibility, 'whisper'); assert.deepEqual([...answer.whisper_to].sort(), [pc.ann, pc.bob].sort());
  await row(annA, answer).getByText('via interactive message').waitFor();
  await row(bob, answer).getByText('We should leave before dawn.', { exact: true }).waitFor();
  // A window line after it: once Cy has that one, she would have had the whisper too.
  const after = await say('The clock strikes midnight.');
  await row(cat, after).getByText('The clock strikes midnight.', { exact: true }).waitFor();
  const unseen = async () => {
    for (const m of [note, answer]) assert.equal(await row(cat, m).count(), 0, 'Cy never sees the whisper card or its lines');
    for (const text of noteText) assert.equal(await cat.getByText(text).count(), 0, `Cy never reads "${text}"`);
    const wire = await cat.evaluate(() => JSON.stringify(window.chatFrames));
    for (const id of [note.id, answer.id]) assert.ok(!wire.includes(id), 'Cy\'s socket never hears of it');
  };
  await unseen();
  await cat.reload();
  await subscribed(cat);
  await row(cat, after).waitFor();
  await unseen();

  // The newest card: the confirmation the server asks for (a sheet change) opens inside the visible chat, not below it.
  const list = annA.locator('.message-list');
  const inView = async (loc) => { const l = await list.boundingBox(), b = await loc.boundingBox(); return !!(l && b && b.y >= l.y - 1 && b.y + b.height <= l.y + l.height + 1); };
  const sanity = await post({ hypertext: { v: 1, title: 'The thing in the cellar', state: { done: { type: 'bool' } }, actors: [pc.ann], body: [
    { type: 'text', text: 'It looks at you.' },
    { type: 'button', id: 'sc', label: 'Sanity check 1/1d6', act: { say: '.sc 1/1d6', set: { done: true } }, enable_if: { key: 'done', eq: false } },
  ] } });
  await row(annA, sanity).getByText('It looks at you.', { exact: true }).waitFor();
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const scButton = row(annA, sanity).getByRole('button', { name: 'Sanity check 1/1d6', exact: true });
  await enabled(scButton, 'the sanity button');
  await scButton.click();
  const scConfirm = row(annA, sanity).getByRole('group', { name: 'Confirm', exact: true });
  await scConfirm.getByText('Post as Ada: .sc 1/1d6', { exact: true }).waitFor();
  await scConfirm.getByText('This changes your character sheet.', { exact: true }).waitFor();
  await until(() => inView(scConfirm.getByRole('button', { name: 'Post', exact: true })), 'the confirmation inside the visible chat');
  await scConfirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await scConfirm.waitFor({ state: 'detached' });

  // From the keyboard: the confirmation takes the focus and gives it back. An out-of-character line goes out under the
  // account's name, and the confirmation says so.
  const brb = await post({ hypertext: { v: 1, title: 'A short break', body: [{ type: 'button', id: 'brb', label: 'Step away', on: 'brb' }],
    script: "on('brb', () => { say('brb, need a sec', 'ooc'); });" } });
  const brbRow = row(annA, brb), brbButton = brbRow.getByRole('button', { name: 'Step away', exact: true });
  const focused = (loc) => loc.evaluate((el) => el === document.activeElement);
  await enabled(brbButton, 'the break button');
  await brbButton.focus();
  await annA.keyboard.press('Enter');
  const brbConfirm = brbRow.getByRole('group', { name: 'Confirm', exact: true });
  await brbConfirm.getByText('Post as Ann (out of character): brb, need a sec', { exact: true }).waitFor();
  const brbPost = brbConfirm.getByRole('button', { name: 'Post', exact: true });
  await until(() => focused(brbPost), 'the Post button to take the focus');
  await until(() => inView(brbPost), 'the keyboard confirmation inside the visible chat');
  await annA.keyboard.press('Enter');
  const away = await via('ann', brb);
  assert.deepEqual([away.kind, away.content, away.author_id], ['ooc', 'brb, need a sec', u.ann.user.id]);
  await brbConfirm.waitFor({ state: 'detached' });
  await until(() => focused(brbButton), 'the focus back on the button');

  // A change undone while its save is still on its way is saved too (the PUTs are held back here).
  const torch = await post({ hypertext: { v: 1, title: 'The torch', state: { lit: { type: 'bool' } }, body: [{ type: 'checkbox', id: 'lit', label: 'Light the torch', bind: 'lit' }] } });
  const lit = (page) => row(page, torch).getByRole('checkbox', { name: 'Light the torch', exact: true });
  await enabled(lit(annA), 'the torch');
  let held = 0;
  await annA.route('**/hypertext/state', async (route) => { held++; await sleep(1500); await route.continue(); });
  await lit(annA).check();
  await until(() => held > 0, 'the first save on its way');
  await lit(annA).uncheck();
  await until(async () => held >= 2 && (await status('ann', torch.id)).state?.lit === false, 'the untick saved after the tick', 20000);
  await annA.unroute('**/hypertext/state');
  await annA.reload();
  await subscribed(annA);
  await enabled(lit(annA), 'the torch after reload');
  assert.equal(await lit(annA).isChecked(), false, 'the last change is the one kept');

  // "Speak as" in the composer: a card's line goes out as the character picked there, and the caption of an
  // out-of-character line says so.
  const wave = await post({ hypertext: { v: 1, title: 'At the window', runs_per_viewer: 2, body: [
    { type: 'button', id: 'wave', label: 'Wave', act: { say: 'I wave.' } },
    { type: 'button', id: 'leave', label: 'Step out', act: { say: 'Back soon.', say_kind: 'ooc' } },
  ] } });
  const waveRow = row(annA, wave), waveButton = waveRow.getByRole('button', { name: 'Wave', exact: true });
  await waveRow.getByText('Posts (out of character):').waitFor();
  await enabled(waveButton, 'the wave button');
  await annA.getByTitle('Speak as', { exact: true }).selectOption({ label: 'Ava' });
  await waveButton.click();
  const waved = await via('ann', wave);
  assert.deepEqual([waved.character_id, waved.character_name, waved.content], [ava, 'Ava', 'I wave.']);
  await annA.getByTitle('Speak as', { exact: true }).selectOption({ label: 'Ada' });

  if (engine === 'chromium') {
    // Keys moving through a choice that runs the script do not run it: arrows move the focus among radios, Space picks
    // one; a menu picks what the keys reached on Enter. The focus stays on the control while the script runs.
    const paint = await post({ hypertext: { v: 1, title: 'Paint', state: {
      c: { type: 'enum', values: [{ value: 'red', label: 'Red' }, { value: 'green', label: 'Green' }, { value: 'blue', label: 'Blue' }] },
      s: { type: 'enum', values: [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'deep', label: 'Deep' }] },
      n: { type: 'int', min: 0, max: 100 }, k: { type: 'int', min: 0, max: 100 } }, body: [
      { type: 'choice', id: 'c', label: 'Colour', bind: 'c', display: 'list', on: 'pick' },
      { type: 'text', text: 'Colour runs: {{n}}' },
      { type: 'choice', id: 'shade', label: 'Shade', bind: 's', display: 'menu', on: 'shade' },
      { type: 'text', text: 'Shade runs: {{k}}' },
    ], script: "on('pick', () => { state.n = state.n + 1; }); on('shade', () => { state.k = state.k + 1; });" } });
    const paintRow = row(annA, paint), colour = (label) => paintRow.getByRole('radio', { name: label, exact: true });
    await enabled(colour('Red'), 'the colours');
    await colour('Red').focus();
    await annA.keyboard.press('Space');
    await paintRow.getByText('Colour runs: 1', { exact: true }).waitFor();
    assert.ok(await focused(colour('Red')), 'the focus stays on the radio');
    await annA.keyboard.press('ArrowDown');
    await annA.keyboard.press('ArrowDown');
    await sleep(700);
    assert.ok(await focused(colour('Blue')), 'the arrows moved the focus');
    assert.ok(await colour('Red').isChecked(), 'without picking');
    await paintRow.getByText('Colour runs: 1', { exact: true }).waitFor();
    await annA.keyboard.press('Space');
    await paintRow.getByText('Colour runs: 2', { exact: true }).waitFor();
    assert.ok(await colour('Blue').isChecked());
    const shade = paintRow.getByRole('combobox', { name: 'Shade', exact: true });
    await shade.focus();
    await annA.keyboard.press('ArrowDown');
    await annA.keyboard.press('ArrowDown');
    await sleep(700);
    await paintRow.getByText('Shade runs: 0', { exact: true }).waitFor();
    assert.equal(await shade.inputValue(), 'dark', 'the menu shows what the keys reached');
    await annA.keyboard.press('Enter');
    await paintRow.getByText('Shade runs: 1', { exact: true }).waitFor();
    assert.ok(await focused(shade), 'the focus stays on the menu');
    await until(async () => (await status('ann', paint.id)).state?.s === 'dark' && (await status('ann', paint.id)).state?.c === 'blue', 'the picks saved');
  }

  // A long unbroken option or group title wraps inside the card: nothing scrolls sideways on a phone.
  const word = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
  const wide = await post({ hypertext: { v: 1, title: 'Words', state: { w: { type: 'enum', values: [{ value: 'long', label: word + word }, { value: 'short', label: 'Short' }] } }, body: [
    { type: 'group', title: 'G'.repeat(80), children: [{ type: 'choice', id: 'w', label: 'Word', bind: 'w', display: 'buttons' }] },
  ] } });
  await annA.setViewportSize({ width: 390, height: 844 });
  await row(annA, wide).getByRole('button', { name: 'Short', exact: true }).waitFor();
  // (Measured on the card's own row: a plain line's header of buttons is another matter.)
  const overflowing = await row(annA, wide).evaluate((rowEl) => {
    const edge = rowEl.closest('.message-list').getBoundingClientRect().right;
    return [...rowEl.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > edge + 1).map((e) => e.tagName + '.' + e.className);
  });
  assert.deepEqual(overflowing, [], 'nothing of the card reaches past the chat at 390px');
  const [card, option] = [await row(annA, wide).locator('.hx-card').boundingBox(), await row(annA, wide).getByRole('button', { name: word + word, exact: true }).boundingBox()];
  assert.ok(option.x + option.width <= card.x + card.width + 1, 'the long option stays inside the card');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(engine + ': interactive messages (render, roll as the character, saved and live state, per-card choices, IME, script confirm, whisper privacy, confirmation in view and focus, out-of-character lines, saves in flight, speak as, keyboard choices, narrow screens) passed');
} finally { await browser.close(); }
