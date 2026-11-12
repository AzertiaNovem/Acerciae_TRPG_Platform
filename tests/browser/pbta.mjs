import { chromium, webkit } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const site = process.env.WEB_BASE || 'http://127.0.0.1:5196';
const apiOrigin = process.env.API_BASE || 'http://127.0.0.1:18089';
for (const address of [site, apiOrigin]) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(address).hostname))
    throw Error('These checks create fixtures. Use a local test server.');
}
const base = apiOrigin + '/api';
async function call(p, b, t) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (t ?? '') },
    body: JSON.stringify(b),
  });
  const d = await r.json();
  if (!r.ok) throw Error(JSON.stringify(d));
  return d;
}
const engine = process.argv[2] ?? 'chromium';
const { token } = await call('/auth/register', {
  username: 'ui' + Date.now(),
  password: 'password',
  display_name: 'UI GM',
});
const srv = await call('/servers', { name: 'UI table' }, token);
const ch = await call(
  '/servers/' + srv.id + '/channels',
  { name: 'Field station', rule_system: 'pbta' },
  token,
);
await call('/channels/' + ch.id + '/characters', { name: 'UI Scout' }, token);
const browser =
  engine === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({ channel: process.env.CHROME_CHANNEL || undefined });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  page.on('pageerror', (err) => console.error(err.message));
  await page.addInitScript((token) => {
    localStorage.setItem('acerciae.token', token);
  }, token);
  await page.goto(site);
  await page.getByText('UI Scout', { exact: true }).first().click();
  await page.getByLabel('Playbook').selectOption('scout');
  await page
    .getByRole('button', { name: /^Save$/i })
    .first()
    .click();
  const move = page.locator('details').filter({ has: page.locator('summary', { hasText: '冒险搜查' }) });
  await move.locator('summary').click();
  const [reply] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/messages') && r.request().method() === 'POST'),
    move.getByRole('button').click(),
  ]);
  const msg = await reply.json();
  assert.equal(msg.dice.type, 'pbta_move');
  await page.getByRole('button', { name: /back to chat/i }).click();
  // The dice persona renders each result line separately, with numbers in nested spans.
  const result = page.locator(`#msg-${msg.id} + .dice-bot .dice-lines`);
  await result.waitFor();
  assert.deepEqual(await result.locator('.dice-line').allTextContents(), msg.dice.text.split('\n'));
  await page.getByText('GM workspace', { exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Rule pack' }).click();
  await page.getByLabel('Rule pack', { exact: true }).fill('Field manual');
  await page.getByRole('button', { name: 'Save rule pack' }).click();
  await page.getByText('Rule pack saved', { exact: true }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'JSON ↓' }).click(),
  ]);
  const content = await fs.readFile(await download.path(), 'utf8');
  const exported = JSON.parse(content);
  assert.equal(exported.name, 'Field manual');
  await page
    .getByLabel('Preview JSON import')
    .setInputFiles({
      name: 'rules.json',
      mimeType: 'application/json',
      buffer: Buffer.from(content.replace('Field manual', 'Revised manual')),
    });
  await page.getByText('Review the imported rules before saving.').waitFor();
  await page.getByRole('button', { name: 'Save rule pack' }).click();
  await page.getByText('Rule pack saved', { exact: true }).waitFor();
  console.log(engine + ' played a persisted move through the sheet and saw its result in chat');
} finally {
  await browser.close();
}
