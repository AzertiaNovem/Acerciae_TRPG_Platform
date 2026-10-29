// The language model the GM client thinks with. This is the client's own model, separate from the platform's
// background AI (which never speaks in chat). Every provider exposes complete({system, messages, purpose}) → text.
import { AnthropicLlm } from "./anthropic.mjs";
import { OpenAiCompatLlm } from "./openai.mjs";
import { MockLlm } from "./mock.mjs";
import fs from "node:fs";

export function createLlm(cfg) {
  let llm;
  switch (cfg.provider) {
    case "anthropic": llm = new AnthropicLlm(cfg); break;
    case "openai_compatible": case "openai": llm = new OpenAiCompatLlm(cfg); break;
    case "mock": llm = new MockLlm(); break;
    default: throw new Error(`unknown LLM_PROVIDER "${cfg.provider}" (anthropic, openai_compatible or mock)`);
  }
  return cfg.trace ? traced(llm, cfg.trace) : llm;
}

// LLM_TRACE=<file>: append every request and reply as one JSON line, to audit what each role was shown.
function traced(llm, file) {
  return {
    async complete(req) {
      const reply = await llm.complete(req);
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), purpose: req.purpose, system: req.system, messages: req.messages, reply })}\n`);
      return reply;
    },
  };
}

// Pulls the first JSON object out of a model reply (tolerating code fences or a sentence around it).
export function extractJson(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply");
  return JSON.parse(s.slice(start, end + 1));
}

// Asks for a JSON object; one repair round when the reply does not parse or fails validation.
export async function completeJson(llm, { system, user, purpose }, validate = (x) => x) {
  const messages = [{ role: "user", content: user }];
  let reply = await llm.complete({ system, messages, purpose });
  try {
    return validate(extractJson(reply));
  } catch (e) {
    messages.push({ role: "assistant", content: reply });
    messages.push({ role: "user", content: `That reply could not be used (${e.message}). Answer again with only the JSON object described above.` });
    reply = await llm.complete({ system, messages, purpose });
    return validate(extractJson(reply));
  }
}
