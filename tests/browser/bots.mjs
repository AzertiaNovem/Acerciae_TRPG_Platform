// Bots in the web client (docs/BOTS.md): a maintainer creates one in Server settings → Bots; a player invites it from
// the channel sidebar; its line carries the "bot" tag; the GM turns invitations off and asks the bots for their turn.
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
const site = process.env.WEB_BASE || 'http://127.0.0.1:5196';
if (!['127.0.0.1', 'localhost'].includes(new URL(site).hostname)) throw Error('Use a local test server.');
const engine = process.argv[2] || 'chromium';
const shots = process.env.SHOTS_DIR || '';
const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: process.env.CHROME_CHANNEL });
try {
  const ctx = await browser.newContext({ baseURL: site, viewport: { width: 1280, height: 860 } });
  async function api(method, path, body, token) {
    const res = await ctx.request.fetch('/api' + path, { method, data: body, headers: token ? { Authorization: 'Bearer ' + token } : {} });
    assert.ok(res.ok(), `${path}: ${res.status()} ${await res.text()}`); return res.json();
  }
  const sfx = Date.now().toString(36);
  const gm = await api('POST', '/auth/register', { username: 'bots_gm_' + sfx, display_name: 'Keeper', password: 'password' });
  const p1 = await api('POST', '/auth/register', { username: 'bots_p1_' + sfx, display_name: 'Ada', password: 'password' });
  for (const u of [gm, p1]) await api('PUT', '/auth/me', { ui_language: 'en' }, u.token);
  const server = await api('POST', '/servers', { name: 'Bots browser verification' }, gm.token);
  const channel = await api('POST', `/servers/${server.id}/channels`, { name: 'Reading room' }, gm.token);
  await api('POST', `/channels/${channel.id}/members`, { username: 'bots_p1_' + sfx, role: 'player' }, gm.token);
  const page = await ctx.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const as = async (token) => { await page.evaluate((t) => localStorage.setItem('acerciae.token', t), token); await page.goto(`/servers/${server.id}/channels/${channel.id}`); };
  await page.goto('/');
  // The maintainer turns bots on and creates Mina.
  await as(gm.token);
  await page.getByTitle('Server settings (maintainers)').click();
  await page.getByRole('button', { name: 'Features', exact: true }).click();
  await page.locator('label.feature').filter({ hasText: 'Bots' }).locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Server settings saved').waitFor();
  await page.getByRole('button', { name: 'Bots', exact: true }).click();
  await page.getByRole('button', { name: 'New bot' }).click();
  await page.getByPlaceholder('The name everyone sees').fill('Mina');
  await page.locator('.bot-editor textarea').first().fill('A cheerful librarian who loves riddles.');
  if (shots) await page.screenshot({ path: `${shots}/bots-editor-${engine}.png` });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.pick-row').filter({ hasText: 'Mina' }).waitFor();
  if (shots) await page.screenshot({ path: `${shots}/bots-list-${engine}.png` });
  const [mina] = await api('GET', `/servers/${server.id}/bots`, undefined, gm.token);
  // A player invites her from the sidebar.
  await as(p1.token);
  await page.getByRole('button', { name: 'Invite a bot' }).click();
  await page.getByRole('dialog', { name: 'Bots at this table' }).locator('.pick-row').filter({ hasText: 'Mina' }).getByRole('button', { name: 'Invite' }).click();
  await page.getByRole('dialog', { name: 'Bots at this table' }).getByText('invited by Ada').waitFor();
  if (shots) await page.screenshot({ path: `${shots}/bots-invite-${engine}.png` });
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('.item.bot').filter({ hasText: 'Mina' }).locator('.bot-tag').waitFor();
  await page.getByText('Ada invited Mina (bot) to the table.').waitFor();
  assert.equal(await page.locator('.message').filter({ hasText: 'Ada invited Mina' }).locator('.author').innerText(), 'Keeper (GM)', 'the notice is the table\'s, filed under its GM');
  // The GM gives her a character: the sidebar's character list tags it.
  await api('POST', `/channels/${channel.id}/characters`, { name: "Mina's sleuth", user_id: mina.user_id }, gm.token);
  await page.reload();   // creating a character pushes no live update to players
  await page.locator('.item.character').filter({ hasText: "Mina's sleuth" }).waitFor();
  if (shots) await page.screenshot({ path: `${shots}/bots-character-${engine}.png` });
  await page.locator('.item.character').filter({ hasText: "Mina's sleuth" }).locator('.bot-tag').waitFor();
  // The GM turns invitations off; the player's dialog says so.
  await api('PUT', `/channels/${channel.id}`, { bot_invites_enabled: false }, gm.token);
  await page.reload();
  await page.getByRole('button', { name: 'Invite a bot' }).count().then((n) => assert.equal(n, 0, 'a player has nothing to open once invitations are off'));
  // The GM asks the bots for their turn: hers comes in character (the mock model answers).
  await as(gm.token);
  await page.getByRole('button', { name: "Bots' turn" }).click();
  await page.getByText('Called: Mina').waitFor();
  await page.locator('.message').filter({ hasText: "[mock] Mina's sleuth" }).first().waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.message').filter({ hasText: "[mock] Mina's sleuth" }).first().locator('.bot-tag').count(), 1);
  if (shots) await page.screenshot({ path: `${shots}/bots-turn-${engine}.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log(`${engine}: bots settings, invitation from the sidebar, tags and the GM's switch passed`);
} finally { await browser.close(); }
