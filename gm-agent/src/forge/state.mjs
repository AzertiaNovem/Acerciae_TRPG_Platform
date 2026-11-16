import crypto from 'node:crypto';
export const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const SESSION_KEY = 'forge.session';
export function newSession({ world = '', secrets = '', rule, source = null }) {
  return { id: crypto.randomUUID().slice(0, 8), phase: 'interview', revision: 1, rule, source,
    sourceWorld: world, sourceSecrets: secrets, participants: {}, approvals: {}, history: [], facts: [], questions: [], drafts: [],
    counters: {}, cards: [], journal: {}, cursor: 0, window: null, createdAt: new Date().toISOString() };
}
export function fact(s, prefix, text, status = 'proposed', by = null) {
  const id = `${prefix}${s.counters[prefix] = (s.counters[prefix] ?? 0) + 1}`;
  const entry = { id, text, status, by, revision: s.revision }; s.facts.push(entry); return entry;
}
export function revise(s) {
  if (['applying', 'ready', 'playing'].includes(s.phase)) throw Error('设定已在启用，不能再修改草案。');
  if(s.candidate) (s.drafts??=[]).push({revision:s.revision,candidate:s.candidate,approvals:s.approvals});
  s.revision++; s.approvals = {}; s.phase = 'interview'; s.candidate = null; s.privateWorld = null; s.worldStateSeed = null; s.questions = [];
}
export function join(s, member) {
  if (s.participants[member.user_id]) return false;
  revise(s); s.participants[member.user_id] = { user_id: member.user_id, name: member.display_name || member.username || member.user_id };
  return true;
}
export function acceptAnswer(s, user, text) {
  if (!s.participants[user]) throw Error('请先加入共创。');
  if(s.phase === 'review') revise(s);
  else if(s.phase !== 'interview') throw Error('当前阶段不能修改草案。');
  s.history.push({ user, text, revision: s.revision }); fact(s, 'F', text, 'accepted', user);
}
export function approve(s, user, revision) {
  if (s.phase !== 'review' || revision !== s.revision || !s.participants[user]) throw Error('请查看当前草案后确认。');
  s.approvals[user] = { revision, hash: hash(s.candidate), at: new Date().toISOString() };
}
export function allApproved(s) {
  const users = Object.keys(s.participants);
  return users.length > 0 && users.every(u => s.approvals[u]?.revision === s.revision && s.approvals[u]?.hash === hash(s.candidate));
}
export function publicDossier(s) {
  return { source: s.sourceWorld, participants: Object.values(s.participants), facts: s.facts, history: s.history, priorCast: (s.candidate ?? s.drafts?.at(-1)?.candidate)?.characters ?? [], revision: s.revision };
}
export function status(s) {
  return { id: s.id, phase: s.phase, revision: s.revision, window: s.window, participants: Object.values(s.participants),
    confirmed: Object.keys(s.approvals).filter(u => s.approvals[u].revision === s.revision), error: s.error ?? null,
    review: s.review ?? null, playtests: s.playtests ?? [], characterIds: s.characterIds ?? {}, candidate: s.candidate ?? null };
}
