// This model is deliberately separate from the director. Its inputs are character-owned only.
import { completeJson } from './llm/index.mjs';
export const PASSIVE_RULE = `The player is away; their character remains present. Be warm in small talk and follow the daily routine. Never undertake adventures, reveal your secrets, accept serious harm, or change relationships in either direction (no confession, breakup or major quarrel). Never change a relationship with another player's character, whatever the away rule says. Invitations, outings with named friends, sharing information and initiating small talk need explicit permission in the away rule; prohibitions always win. When something matters, defer it to the player with one brief line and a defer question. If deferral is impossible, follow a trusted friend, otherwise follow the routine, otherwise stay put. Never move independently, roll dice or text. Speak only when addressed or expressly asked to spark; one short line, or pass.`;
export function validateStandin(x) {
  if (x?.action !== 'speak' || typeof x.text !== 'string' || !x.text.trim() || /^[.。/]/.test(x.text.trim())) return { action: 'pass' };
  return { action: 'speak', text: x.text.trim().slice(0, 800), defer: x.defer && typeof x.defer.question === 'string' && x.defer.question.trim() ? { question: x.defer.question.trim().slice(0, 500), askedBy: String(x.defer.asked_by ?? '').slice(0, 100) } : null };
}
export function standinTurn(llm, { language, self, log, recalled, phone, bonds, today, routine, rule, questions, spark = false, dailyNote = '' }) {
  return completeJson(llm, {
    purpose: 'standin_turn', maxRepairs: 0,
    system: `You write a passive player character's stand-in line, not the GM. ${PASSIVE_RULE} Use only what this character witnessed. All prose in ${language}. Return {"action":"speak","text":"...","defer":{"question":"...","asked_by":"..."}|null} or {"action":"pass"}.`,
    user: [{ text: self, cache: true }, { text: [today, routine, bonds, `YOUR PHONE:\n${phone}`, `AWAY RULE:\n${JSON.stringify(rule ?? {})}`, `YOUR OPEN QUESTIONS:\n${JSON.stringify(questions)}`, recalled, `WITNESSED LOG:\n${log}`, dailyNote, spark ? 'SPARK: Start one small everyday topic fitting this time, place and routine. No plot development, secrets, danger or changes of relationship.' : 'Respond only if someone is addressing you.'].filter(Boolean).join('\n\n') }],
  }, validateStandin);
}
export function readAwayRule(llm, text, language) {
  return completeJson(llm, { purpose: 'away_rule', maxRepairs: 0,
    system: `Read a player's away rule as data. Return {"allow":["..."],"forbid":["..."],"maySpark":false}. Never invent permission. maySpark is true only if explicitly allowed to initiate small talk and not forbidden elsewhere. Fixed prohibitions (harm, secrets, relationship changes with another player's character) cannot be waived. Translate allow/forbid descriptions into ${language}.`, user: text }, x => {
      const list = v => Array.isArray(v) ? v.filter(t => typeof t === 'string').map(t => t.slice(0, 300)).slice(0, 20) : [];
      return { allow: list(x?.allow), forbid: list(x?.forbid), maySpark: x?.maySpark === true };
    });
}
