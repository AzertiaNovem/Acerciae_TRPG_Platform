// A thin client for the Acerciae HTTP API (docs/API.md), the same contract the web and mobile clients use.

export class ApiError extends Error {
  constructor(method, path, status, data) {
    super(`${method} ${path}: ${status} ${data?.error ?? ""} ${data?.message ?? (typeof data === "string" ? data : "")}`.trim());
    this.status = status;
    this.code = data?.error ?? "";
    this.data = data;
  }
}

export class Api {
  constructor(base, { token = "", fetchImpl = globalThis.fetch } = {}) {
    this.base = base.replace(/\/+$/, "");
    this.token = token;
    this.user = null;
    this.fetch = fetchImpl;
    this.credentials = null;
  }

  async call(method, path, body, { retryAuth = true } = {}) {
    const headers = { Accept: "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.status === 401 && retryAuth && this.credentials) {
      // The session ended (logout elsewhere, secret rotated): sign in again once.
      await this.login(this.credentials.username, this.credentials.password);
      return this.call(method, path, body, { retryAuth: false });
    }
    if (!res.ok) throw new ApiError(method, path, res.status, data);
    return data;
  }

  get(path) { return this.call("GET", path); }
  post(path, body = {}) { return this.call("POST", path, body); }
  put(path, body = {}) { return this.call("PUT", path, body); }

  // ---- auth
  async login(username, password) {
    const r = await this.call("POST", "/api/auth/login", { username, password }, { retryAuth: false });
    this.token = r.token; this.user = r.user; this.credentials = { username, password };
    return r.user;
  }
  async register(username, password, displayName) {
    const r = await this.call("POST", "/api/auth/register", { username, password, display_name: displayName }, { retryAuth: false });
    this.token = r.token; this.user = r.user; this.credentials = { username, password };
    return r.user;
  }
  me() { return this.get("/api/auth/me"); }

  // ---- servers and channels
  servers() { return this.get("/api/servers"); }
  createServer(name) { return this.post("/api/servers", { name }); }
  serverSettings(serverId) { return this.get(`/api/servers/${serverId}/settings`); }
  createInvite(serverId) { return this.post(`/api/servers/${serverId}/invites`, { max_uses: 0, expires_in_hours: 168 }); }
  channels(serverId) { return this.get(`/api/servers/${serverId}/channels`); }
  createChannel(serverId, body) { return this.post(`/api/servers/${serverId}/channels`, body); }
  channel(ch) { return this.get(`/api/channels/${ch}`); }
  updateChannel(ch, body) { return this.put(`/api/channels/${ch}`, body); }

  // ---- characters
  characters(ch) { return this.get(`/api/channels/${ch}/characters`); }
  createCharacter(ch, body) { return this.post(`/api/channels/${ch}/characters`, body); }
  characterSpace(ch, cid) { return this.get(`/api/channels/${ch}/characters/${cid}/space`); }
  putCard(ch, cid, body) { return this.put(`/api/channels/${ch}/characters/${cid}/card`, body); }
  coc7Rules() { return this.get("/api/coc7/rules"); }

  // ---- chat
  windows(ch) { return this.get(`/api/channels/${ch}/windows`); }
  messages(ch, w, limit = 60) { return this.get(`/api/channels/${ch}/windows/${w}/messages?limit=${limit}`); }
  postMessage(ch, w, body) { return this.post(`/api/channels/${ch}/windows/${w}/messages`, body); }

  // ---- the Keeper's context and the platform's AI tips (GM only)
  scenes(ch) { return this.get(`/api/channels/${ch}/scenes`); }
  kpBoard(ch) { return this.get(`/api/channels/${ch}/kp/board`); }
  reminders(ch) { return this.get(`/api/channels/${ch}/reminders`); }
  scriptKnowledge(ch) { return this.get(`/api/channels/${ch}/script-knowledge`); }
  documents(ch) { return this.get(`/api/channels/${ch}/documents`); }
  document(ch, did) { return this.get(`/api/channels/${ch}/documents/${did}`); }
  highlights(ch) { return this.get(`/api/channels/${ch}/highlights`); }
  moduleHints(ch) { return this.get(`/api/channels/${ch}/modules/hints?status=potential`); }
  proposals(ch) { return this.get(`/api/channels/${ch}/proposals?status=needs_gm_review`); }
}
