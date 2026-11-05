// Run against the local Vite proxy. Both engines exercise the same React view used by desktop.
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const site = process.env.WEB_BASE || 'http://127.0.0.1:5196';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(site).hostname)) throw Error('Use a local test server.');
const engine = process.argv[2] ?? 'chromium';
const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: process.env.CHROME_CHANNEL });
try {
  const api = await browser.newContext({ baseURL: site });
  async function request(endpoint, data, token) {
    const reply = await api.request.fetch('/api' + endpoint, {
      method: data ? 'POST' : 'GET', data, headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
    assert.ok(reply.ok(), `${endpoint}: ${reply.status()}`);
    return reply.json();
  }
  const { token } = await request('/auth/register', { username: 'theme' + Date.now(), display_name: 'The Keeper', password: 'password' });
  const server = await request('/servers', { name: 'Arkham Table' }, token);
  const channel = await request('/servers/' + server.id + '/channels', { name: 'The Lantern of Blackwater Cove' }, token);
  const [window] = await request('/channels/' + channel.id + '/windows', null, token);
  await request(`/channels/${channel.id}/windows/${window.id}/messages`, { kind: 'narration', content: 'The harbour bell rings twice.' }, token);
  const page = await api.newPage();
  page.setDefaultTimeout(7000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(site);
  await page.evaluate(token => localStorage.setItem('acerciae.token', token), token);
  await page.reload();
  const settings = page.getByRole('button', { name: 'User settings', exact: true });
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  const choose = name => dialog.getByRole('radio', { name }).check();
  const active = theme => page.waitForFunction(t => document.documentElement.dataset.theme === t, theme);
  await page.getByText('The harbour bell rings twice.').waitFor();
  await active('classic');
  await settings.click();
  await choose('Frosted glass');
  await active('glass');
  assert.equal((await request('/auth/me', null, token)).ui_theme, 'classic');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await active('classic');
  await settings.click();
  await choose('Frosted glass');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.reload();
  await active('glass');
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(mode => getComputedStyle(document.documentElement).colorScheme === mode, colorScheme);
    await page.getByText('The harbour bell rings twice.').waitFor();
  }
  await settings.click();
  await choose('Parchment');
  await active('parchment');
  assert.equal((await request('/auth/me', null, token)).ui_theme, 'glass');
  await page.keyboard.press('Escape');
  await active('glass');
  await settings.click();
  await choose('Parchment');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.reload();
  await active('parchment');
  assert.equal((await request('/auth/me', null, token)).ui_theme, 'parchment');
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'light');
    await page.getByText('The harbour bell rings twice.').waitFor();
  }
  await page.setViewportSize({ width: 480, height: 720 });
  await page.locator('.server-icon.active').click();
  await settings.click();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 480 && bounds.height <= 720);
  const saveBounds = await dialog.getByRole('button', { name: 'Save', exact: true }).boundingBox();
  assert.ok(saveBounds.y >= bounds.y && saveBounds.y + saveBounds.height <= bounds.y + bounds.height);
  assert.equal(await dialog.locator('.profile-scroll').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'theme cards fit without horizontal scrolling');
  await choose('Classic dark');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await request('/auth/me', null, token)).ui_theme, 'classic');
  console.log(`${engine}: all three themes, preview, cancel, save, reload, light/dark and narrow layout passed`);
} finally { await browser.close(); }
