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
      // The session ended (expired, logout elsewhere, secret rotated): sign in again once.
      await this.relogin();
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
  // A new session with the same credentials. Concurrent callers (REST calls, both sockets) share one sign-in.
  relogin() {
    if (!this.credentials) return Promise.reject(new Error("not signed in"));
    this.signingIn ??= this.login(this.credentials.username, this.credentials.password).finally(() => { this.signingIn = null; });
    return this.signingIn;
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
  channelMembers(ch) { return this.get(`/api/channels/${ch}/members`); }
  playerGroups(ch) { return this.get(`/api/channels/${ch}/player-groups`); }

  // ---- characters
  characters(ch) { return this.get(`/api/channels/${ch}/characters`); }
  createCharacter(ch, body) { return this.post(`/api/channels/${ch}/characters`, body); }
  setCharacterPresence(ch, cid, passive) { return this.put(`/api/channels/${ch}/characters/${cid}/presence`, { passive }); }
  characterSpace(ch, cid) { return this.get(`/api/channels/${ch}/characters/${cid}/space`); }
  pbtaRules(ch) { return this.get(`/api/channels/${ch}/pbta`); }
  pbtaDraft(ch) { return this.get(`/api/channels/${ch}/pbta/draft`); }
  reviewPbta(ch, body) { return this.post(`/api/channels/${ch}/pbta/draft`, body); }
  previewPbta(ch, pack) { return this.post(`/api/channels/${ch}/pbta/preview`, pack); }
  pbtaRulings(ch, w, before = 0) { return this.get(`/api/channels/${ch}/windows/${w}/pbta-rulings?before_seq=${before}`); }
  pbtaRuling(ch, w, body) { return this.post(`/api/channels/${ch}/windows/${w}/pbta-rulings`, body); }
  putCard(ch, cid, body) { return this.put(`/api/channels/${ch}/characters/${cid}/card`, body); }
  putAppearance(ch, cid, body) { return this.put(`/api/channels/${ch}/characters/${cid}/appearance`, body); }
  coc7Rules() { return this.get("/api/coc7/rules"); }
  dndRules() { return this.get("/api/dnd/rules"); }

  // ---- chat
  windows(ch) { return this.get(`/api/channels/${ch}/windows`); }
  createWindow(ch, body) { return this.post(`/api/channels/${ch}/windows`, body); }
  forkWindow(ch, parent, body) { return this.post(`/api/channels/${ch}/windows/${parent}/fork`, body); }
  setWindowVisibility(ch, w, user, paused) { return this.put(`/api/channels/${ch}/windows/${w}/members/${user}/visibility`, { paused }); }
  updateWindow(ch, w, body) { return this.put(`/api/channels/${ch}/windows/${w}`, body); }
  // Adds a channel member to a window (the platform seats their first player character when none is given).
  addWindowMember(ch, w, body) { return this.post(`/api/channels/${ch}/windows/${w}/members`, body); }
  messages(ch, w, limit = 60, beforeSeq = 0) { return this.get(`/api/channels/${ch}/windows/${w}/messages?limit=${limit}&include_history=false${beforeSeq > 0 ? `&before_seq=${beforeSeq}` : ""}`); }
  postMessage(ch, w, body) { return this.post(`/api/channels/${ch}/windows/${w}/messages`, body); }
  // The author takes a line back (two minutes; not rolls): {message: the tombstone, content: the text it had}.
  recallMessage(ch, id) { return this.post(`/api/channels/${ch}/messages/${id}/recall`, {}); }
  // Illustrations: drawn by the server's image provider, posted in the window as this account's ooc line when ready.
  illustrate(ch, w, body) { return this.post(`/api/channels/${ch}/windows/${w}/illustrations`, body); }
  illustrations(ch) { return this.get(`/api/channels/${ch}/illustrations`); }
  cancelIllustration(ch, id) { return this.post(`/api/channels/${ch}/illustrations/${id}/cancel`, {}); }
  // Interactive messages (docs/HYPERTEXT.md), GM only: a card posted in a window (`body`: {content?, visibility?,
  // whisper_to?, closes_in?, hypertext, replies?}; returns the message row, kind "hypertext"), and closing one (any
  // channel GM; idempotent). A platform without them answers 404/405, one that turned them off 403 feature_disabled;
  // a refused card 400 invalid_hypertext with `errors: [{path, message}]` (kept on the ApiError's `data`).
  postHypertext(ch, w, body) { return this.post(`/api/channels/${ch}/windows/${w}/hypertext`, body); }
  closeHypertext(ch, id) { return this.post(`/api/channels/${ch}/messages/${id}/hypertext/close`, {}); }
  // A window's Initiative order (D&D channels): {round, turn, entries[{id, name, total, character_id, created_by}]}.
  initiative(ch, w) { return this.get(`/api/channels/${ch}/windows/${w}/initiative`); }
  initiativeAction(ch, w, body) { return this.post(`/api/channels/${ch}/windows/${w}/initiative`, body); }

  // ---- the GM's context and the platform's AI tips (GM only)
  scenes(ch) { return this.get(`/api/channels/${ch}/scenes`); }
  advanceScenario(ch, body) { return this.post(`/api/channels/${ch}/scenarios/advance`, body); }
  enterScenario(ch, sceneId) { return this.post(`/api/channels/${ch}/scenarios/enter`, { scene_id: sceneId }); }
  kpBoard(ch) { return this.get(`/api/channels/${ch}/kp/board`); }
  reminders(ch) { return this.get(`/api/channels/${ch}/reminders`); }
  scriptKnowledge(ch) { return this.get(`/api/channels/${ch}/script-knowledge`); }
  documents(ch) { return this.get(`/api/channels/${ch}/documents`); }
  document(ch, did) { return this.get(`/api/channels/${ch}/documents/${did}`); }
  highlights(ch) { return this.get(`/api/channels/${ch}/highlights`); }
  moduleHints(ch) { return this.get(`/api/channels/${ch}/modules/hints?status=potential`); }
  proposals(ch) { return this.get(`/api/channels/${ch}/proposals?status=needs_gm_review`); }
  // The platform's living world record (the GM's partition): entities' current status, state and whereabouts.
  world(ch) { return this.get(`/api/channels/${ch}/world`); }
  // A GM declaration about the world (often off-screen): recorded by the platform's observer, never shown to
  // players; `secret` keeps the facts it yields GM-only.
  declareWorld(ch, body) { return this.post(`/api/channels/${ch}/world/declare`, body); }
}
