// A bounded client-tool conversation. All actual writes belong to the caller's staged transaction.
import crypto from 'node:crypto';
import { completionAttempts } from './retry.mjs';

export async function completeWithTools(llm, { system, user, messages: given, purpose, phase = '', signal = llm.signalOf?.(), toolkit, canContinue = () => true, maxRounds = 3, retryDelay }) {
  const messages = given ? given.map(m => ({ ...m })) : [{ role: 'user', content: user }];
  const complete = completionAttempts(llm, crypto.randomUUID(), { signal, retryDelay });
  const receipts = new Map();
  let calls = 0;
  const check = () => { signal?.throwIfAborted(); if (!canContinue()) throw Error('Turn no longer eligible for state tools'); };
  for (let round = 0; round <= maxRounds; round++) {
    check();
    const reply = await complete({ system, messages, purpose, phase: round ? `${phase}/tools-${round}` : phase, tools: toolkit.tools, toolChoice: round === maxRounds ? 'none' : 'auto' });
    check();
    // Existing mock providers and integrations returning text keep working.
    if (typeof reply === 'string') { if (!reply.trim()) throw Error('The turn draft was empty'); return reply.trim(); }
    if (!reply?.calls?.length) {
      if (!reply?.text?.trim()) throw Error('The turn draft was empty');
      return reply.text.trim();
    }
    if (round === maxRounds || (calls += reply.calls.length) > 12) throw Error('World state tool limit exceeded; no changes committed');
    if (!Array.isArray(reply.providerOutput) || !reply.providerOutput.length) throw Error('Provider did not preserve its tool continuation');
    messages.push({ role: 'assistant', providerOutput: reply.providerOutput });
    const results = [];
    for (const call of reply.calls) {
      check();
      if (typeof call.id !== 'string' || !call.id || call.id.length > 200) throw Error('Invalid provider tool call ID');
      const fingerprint = JSON.stringify([call.name, call.arguments]);
      let result;
      const prior = receipts.get(call.id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw Error('Provider reused a tool call ID with different arguments');
        result = prior.result;
      } else {
        try {
          if (!toolkit.tools.some(t => t.name === call.name)) throw Error('Tool is unavailable');
          const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Tool arguments must be an object');
          result = await toolkit.call(call.name, args, call.id);
        } catch (e) { signal?.throwIfAborted(); result = { error: e.message }; }
        receipts.set(call.id, { fingerprint, result });
      }
      results.push({ id: call.id, result });
    }
    messages.push({ role: 'user', toolResults: results });
  }
}
