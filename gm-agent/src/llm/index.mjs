// The language model the GM client thinks with. This is the client's own model, separate from the platform's
// background AI (which never speaks in chat). Every provider exposes complete({system, messages, purpose}) → text.
import { AnthropicLlm } from "./anthropic.mjs";
import { OpenAiCompatLlm } from "./openai.mjs";
import { MockLlm } from "./mock.mjs";
import fs from "node:fs";
import crypto from "node:crypto";
import { textOf } from "./parts.mjs";
import { completionAttempts } from './retry.mjs';
import { JsonFieldError, applyFieldRepairs, repairInstruction } from './json-repair.mjs';

export function createLlm(cfg) {
  let llm;
  switch (cfg.provider) {
    case "anthropic": llm = new AnthropicLlm(cfg); break;
    case "openai_compatible": case "openai": llm = new OpenAiCompatLlm(cfg); break;
    case "mock": llm = new MockLlm(); break;
    default: throw new Error(`unknown LLM_PROVIDER "${cfg.provider}" (anthropic, openai_compatible or mock)`);
  }
  llm.provider = cfg.provider;
  return cfg.trace ? traced(llm, cfg.trace) : llm;
}

// LLM_TRACE=<file>: append every request and reply as one JSON line, to audit what each role was shown.
function traced(llm, file) {
  return Object.assign(Object.create(llm), {
    async complete(req) {
      const reply = await llm.complete(req);
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), purpose: req.purpose, system: req.system, messages: req.messages.map((m) => ({ role: m.role, content: textOf(m.content) })), reply })}\n`);
      return reply;
    },
  });
}

// Pulls the first JSON object out of a model reply (tolerating code fences or a sentence around it).
export function extractJson(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply");
  return JSON.parse(s.slice(start, end + 1));
}

// Asks for a JSON object; bounded transport retries and validation repairs. `user` is a string or a
// list of parts (parts.mjs), or `messages` a prepared conversation (the story planner's draft → critique → revise);
// the repair round appends to it, so the original prompt stays a cached prefix.
export async function completeJson(llm, { system, user, messages: given, purpose, phase = "", maxRepairs = 1, signal, retryDelay }, validate = (x) => x) {
  const messages = given ? given.map((m) => ({ ...m })) : [{ role: "user", content: user }];
  const requestId = crypto.randomUUID();
  signal ??= llm.signalOf?.();
  const complete = completionAttempts(llm, requestId, { signal, retryDelay });
  let value, fieldError = null, patchError = '', retryReason;
  for (let round = 0; ; round++) {
    const reply = await complete({ system, messages, purpose, phase, retryReason,
      ...(fieldError ? { repairPaths: fieldError.paths } : {}) });
    try {
      value = fieldError ? applyFieldRepairs(value, extractJson(reply), fieldError.paths) : extractJson(reply);
      fieldError = null; patchError = '';
      const validated = await validate(value);
      signal?.throwIfAborted();
      return validated;
    } catch (error) {
      // Access changes, stale drafts and service errors cannot be fixed by asking the model to change the data.
      signal?.throwIfAborted();
      if (error?.status || error?.validationService) throw error;
      if (round >= maxRepairs) throw error;
      if (error instanceof JsonFieldError) fieldError = error;
      else if (fieldError) patchError = `The last repair was rejected: ${error.message}. `;
      messages.push({ role: 'assistant', content: reply });
      messages.push({ role: 'user', content: fieldError ? patchError + repairInstruction(fieldError)
        : `That reply could not be used (${error.message}). Answer again with only the JSON object described above.` });
      retryReason = error.message;
    }
  }
}
