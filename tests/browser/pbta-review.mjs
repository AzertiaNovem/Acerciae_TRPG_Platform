import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { Api } from '../../gm-agent/src/api.mjs';

const base = process.env.API_BASE || 'http://127.0.0.1:18089';
const site = process.env.WEB_BASE || 'http://127.0.0.1:5196';
for (const url of [base, site])
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname));
const cli = fileURLToPath(new URL('../../gm-agent/src/cli.mjs', import.meta.url));
const engine = process.argv[2] || 'chromium';
const browser =
  engine === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({ channel: process.env.CHROME_CHANNEL });
const dir = await mkdtemp(join(tmpdir(), 'pbta-world-review-'));
try {
  const world = join(dir, 'world.md');
  await writeFile(world, 'The last orbital kitchen feeds the ferry crews.');
  const secret = join(dir, 'secrets.md');
  const trace = join(dir, 'requests.jsonl');
  await writeFile(secret, 'PRIVATE_STATION_BLUEPRINT');
  const username = 'kitchen' + Date.now();
  const env = { ...process.env, STATE_DIR: dir, GM_PASSWORD: 'password', CHANNEL_ID: '' };
  const common = [
    '--api',
    base,
    '--username',
    username,
    '--llm-provider',
    'mock',
    '--llm-trace',
    trace,
    '--state-dir',
    dir,
  ];
  const run = (...args) =>
    promisify(execFile)(process.execPath, [cli, ...args, ...common], { cwd: dir, env, timeout: 15000 });
  const setup = () =>
    run(
      'setup',
      '--create',
      '--rules',
      'pbta',
      '--register',
      '--world',
      world,
      '--secrets',
      secret,
      '--coplayers',
      '1',
    );
  const { stdout } = await setup();
  const id = stdout.match(/CHANNEL_ID=([0-9a-f-]{36})/)[1];
  const api = new Api(base);
  await api.login(username, 'password');
  const draft = await api.pbtaDraft(id);
  assert.equal(draft.status, 'pending');
  assert.equal((await api.characters(id)).length, 0);
  await setup();
  assert.equal((await api.pbtaDraft(id)).version, draft.version);
  const page = await browser.newPage();
  await page.addInitScript((token) => localStorage.setItem('acerciae.token', token), api.token);
  await page.goto(site);
  await page.getByText('GM workspace', { exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Rule pack' }).click();
  await page.getByText('World rule draft', { exact: true }).waitFor();
  await page.getByText('Compare current rules', { exact: false }).click();
  const editor = page
    .locator('fieldset > details')
    .filter({ has: page.locator('summary', { hasText: /^Player moves/ }) });
  await editor.locator(':scope > summary').click();
  await editor.getByLabel('Name', { exact: true }).first().fill('Serve under pressure');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByText('Saved', { exact: true }).waitFor();
  assert.equal((await api.pbtaDraft(id)).pack.moves[0].name, 'Serve under pressure');
  assert.notEqual((await api.pbtaRules(id)).pack.moves[0].name, 'Serve under pressure');
  await page.getByRole('button', { name: 'Activate draft' }).click();
  await page.getByText('World rule draft', { exact: true }).waitFor({ state: 'hidden' });
  await setup();
  assert.equal((await api.pbtaRules(id)).pack.moves[0].name, 'Serve under pressure');
  assert.ok((await api.characters(id))[0].role_card.pbta.book);
  const calls = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((c) => c.purpose),
    ['pbta_design', 'pbta_card'],
  );
  assert.ok(calls.every((c) => !JSON.stringify(c.messages).includes('PRIVATE_STATION_BLUEPRINT')));
  assert.equal(JSON.parse(calls[0].messages[0].content).public_world, await readFile(world, 'utf8'));
  console.log(
    engine + ' reviewed, edited and activated the world draft; repeated CLI setup completed the same table.',
  );
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
