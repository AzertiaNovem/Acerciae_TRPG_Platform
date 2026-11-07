import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from './host-config.mjs';

const COOKIE = 'acerciae_gm_session';
const DAY = 86400_000;
export const SESSION_DAYS = 90;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// Only hashes of random session credentials reach disk. Binding the registry to the access token
// invalidates every saved login when that token changes; restarting the host keeps them intact.
export class HostSessions {
  constructor(stateDir, token, { now = () => Date.now() } = {}) {
    this.file = path.join(stateDir, '.web-sessions.json'); this.now = now;
    this.fingerprint = hash(token); this.sessions = {};
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.fingerprint === this.fingerprint && saved.sessions && typeof saved.sessions === 'object' && !Array.isArray(saved.sessions))
        this.sessions = saved.sessions;
      else this.save();
    } catch (error) { if (error.code !== 'ENOENT') throw Error('Cannot read the Web UI session registry'); }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    atomicWrite(this.file, JSON.stringify({ fingerprint: this.fingerprint, sessions: this.sessions }));
  }
  credential(req) {
    const value = String(req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(value ?? '') ? value : null;
  }
  secure(req) {
    return !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
      || String(req.headers.origin ?? '').startsWith('https://');
  }
  cookie(res, value, secure, seconds = SESSION_DAYS * 86400) {
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`);
  }
  issue(req, res) {
    const now = this.now(), value = crypto.randomBytes(32).toString('hex');
    const sessions = Object.entries(this.sessions).filter(([, s]) => s.expiresAt > now).sort((a, b) => b[1].renewedAt - a[1].renewedAt).slice(0, 99);
    // Logging in again in this browser replaces its previous credential.
    const previous = this.credential(req), next = Object.fromEntries(sessions);
    if (previous) delete next[hash(previous)];
    const secure = this.secure(req);
    next[hash(value)] = { renewedAt: now, expiresAt: now + SESSION_DAYS * DAY, secure };
    this.sessions = next; this.save(); this.cookie(res, value, secure);
  }
  authenticate(req, res) {
    const value = this.credential(req), session = value && this.sessions[hash(value)];
    if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= this.now()) return false;
    // Active browsers keep their login; status polling does not write the registry on every request.
    if (this.now() - session.renewedAt >= DAY) {
      session.renewedAt = this.now(); session.expiresAt = this.now() + SESSION_DAYS * DAY;
      session.secure ||= this.secure(req); this.save(); this.cookie(res, value, session.secure);
    }
    return true;
  }
  revoke(req, res) {
    const value = this.credential(req);
    if (value && this.sessions[hash(value)]) { delete this.sessions[hash(value)]; this.save(); }
    this.cookie(res, '', this.secure(req), 0);
  }
}
