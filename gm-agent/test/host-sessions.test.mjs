import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostSessions, SESSION_DAYS } from '../src/host-sessions.mjs';

const DAY = 86400_000;
const request = (cookie, headers = {}) => ({ headers: { cookie, ...headers }, socket: {} });
function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; } }; }
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-web-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1000;
  return { dir, clock: () => now, advance: days => { now += days * DAY; } };
}
test('saved logins survive host restart, renew while used, expire while idle and are revoked on logout', t => {
  const f = fixture(t), fresh = () => new HostSessions(f.dir, 'admin-access-token', { now: f.clock });
  let sessions = fresh(), res = response(); sessions.issue(request(), res);
  const cookie = res.headers['Set-Cookie'].split(';')[0], credential = cookie.split('=')[1];
  assert.match(res.headers['Set-Cookie'], /HttpOnly; SameSite=Strict; Max-Age=7776000/);
  const disk = fs.readFileSync(sessions.file, 'utf8');
  assert.ok(!disk.includes(credential) && !disk.includes('admin-access-token'));
  assert.equal(fs.statSync(sessions.file).mode & 0o777, 0o600);
  sessions = fresh(); assert.equal(sessions.authenticate(request(cookie), response()), true);
  f.advance(1); res = response(); assert.equal(sessions.authenticate(request(cookie), res), true);
  assert.match(res.headers['Set-Cookie'], /Max-Age=7776000/);
  assert.equal(sessions.authenticate(request('acerciae_gm_session=bad'), response()), false);
  assert.equal(sessions.authenticate(request(cookie.replace(/.$/, c => c === '0' ? '1' : '0')), response()), false);
  sessions.revoke(request(cookie), res); assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
  assert.equal(fresh().authenticate(request(cookie), response()), false, 'logout revokes the server record');
  res = response(); sessions.issue(request(), res);
  const idle = res.headers['Set-Cookie'].split(';')[0];
  f.advance(SESSION_DAYS); assert.equal(fresh().authenticate(request(idle), response()), false);
});
test('access token rotation invalidates old logins, separate browsers stay independent and HTTPS stays secure on renewal', t => {
  const f = fixture(t), sessions = new HostSessions(f.dir, 'old-access-token', { now: f.clock });
  const a = response(), b = response();
  sessions.issue(request(undefined, { origin: 'https://gm.example' }), a);
  sessions.issue(request(), b);
  const cookie = a.headers['Set-Cookie'].split(';')[0], other = b.headers['Set-Cookie'].split(';')[0];
  assert.match(a.headers['Set-Cookie'], /; Secure$/);
  sessions.revoke(request(other), response());
  assert.equal(sessions.authenticate(request(cookie), response()), true, 'another browser logging out does not log this one out');
  f.advance(2); const renewed = response(); sessions.authenticate(request(cookie), renewed);
  assert.match(renewed.headers['Set-Cookie'], /; Secure$/, 'a proxy omitting forwarded proto on a later request cannot weaken its cookie');
  assert.equal(new HostSessions(f.dir, 'new-access-token', { now: f.clock }).authenticate(request(cookie), response()), false);
  assert.equal(new HostSessions(f.dir, 'old-access-token', { now: f.clock }).authenticate(request(cookie), response()), false, 'rolling back the token does not restore revoked sessions');
});
