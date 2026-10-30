import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createLlm } from "../src/llm/index.mjs";

// A local stand-in for the provider endpoint that records the request. `reply` is a body, or a function of the
// request body returning {status, body}.
async function stub(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      seen.push({ url: req.url, headers: req.headers, body: parsed });
      const out = typeof reply === "function" ? reply(parsed) : { status: 200, body: reply };
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

test("Claude: Messages API with adaptive effort and server-side refusal fallbacks", async () => {
  const s = await stub({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "{\"ok\":true}" }], usage: { input_tokens: 1, output_tokens: 1 } });
  try {
    const llm = createLlm({ provider: "anthropic", apiKey: "test-key", apiBase: s.base, model: "claude-opus-5-5", effort: "medium", maxTokens: 16000, fallbacks: true, timeoutMs: 5000 });
    assert.equal(await llm.complete({ system: "sys", messages: [{ role: "user", content: "hi" }] }), "{\"ok\":true}");
    const [r] = s.seen;
    assert.match(r.url, /^\/v1\/messages/);
    assert.equal(r.headers["x-api-key"], "test-key");
    assert.match(r.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
    assert.equal(r.body.model, "claude-opus-5-5");
    assert.equal(r.body.fallbacks, "default");
    assert.deepEqual(r.body.output_config, { effort: "medium" });
    assert.equal(r.body.system, "sys");
    assert.equal(r.body.betas, undefined, "betas travel as a header");
  } finally { s.close(); }
});

test("Claude: a refusal is an error, not an empty reply", async () => {
  const s = await stub({ id: "msg_2", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, content: [], usage: { input_tokens: 1, output_tokens: 0 } });
  try {
    const llm = createLlm({ provider: "anthropic", apiKey: "k", apiBase: s.base, fallbacks: false, timeoutMs: 5000 });
    await assert.rejects(llm.complete({ system: "s", messages: [{ role: "user", content: "x" }] }), /declined \(cyber\)/);
    assert.equal(s.seen[0].body.fallbacks, undefined);
  } finally { s.close(); }
});

test("OpenAI-compatible: chat completions with the system prompt first", async () => {
  const s = await stub({ choices: [{ message: { content: "{}" } }] });
  try {
    const llm = createLlm({ provider: "openai_compatible", apiKey: "k", apiBase: `${s.base}/v1`, model: "local-model", timeoutMs: 5000 });
    assert.equal(await llm.complete({ system: "sys", messages: [{ role: "user", content: "hi" }] }), "{}");
    assert.equal(s.seen[0].url, "/v1/chat/completions");
    assert.deepEqual(s.seen[0].body.messages[0], { role: "system", content: "sys" });
  } finally { s.close(); }
});

// What OpenAI answers a newer or reasoning model sent `max_tokens`.
const reasoningModel = (body) => body.max_tokens !== undefined
  ? { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } } }
  : { status: 200, body: { choices: [{ message: { content: "{\"ok\":true}" } }] } };
const openai = (base, extra = {}) => createLlm({ provider: "openai_compatible", apiKey: "k", apiBase: `${base}/v1`, model: "gpt-x", maxTokens: 16000, timeoutMs: 5000, ...extra });

test("OpenAI-compatible: a model that refuses max_tokens gets max_completion_tokens, from then on directly", async () => {
  const s = await stub(reasoningModel);
  try {
    const llm = openai(s.base);
    assert.equal(await llm.complete({ system: "s", messages: [{ role: "user", content: "a" }] }), "{\"ok\":true}");
    assert.deepEqual(s.seen.map((r) => [r.body.max_tokens, r.body.max_completion_tokens]), [[16000, undefined], [undefined, 16000]]);
    await llm.complete({ system: "s", messages: [{ role: "user", content: "b" }] });
    assert.equal(s.seen.length, 3, "no refused request the second time");
    assert.equal(s.seen[2].body.max_completion_tokens, 16000);
  } finally { s.close(); }
});

test("OpenAI-compatible: LLM_TOKEN_PARAM picks the name from the first request", async () => {
  const s = await stub(reasoningModel);
  try {
    await openai(s.base, { tokenParam: "max_completion_tokens" }).complete({ system: "s", messages: [{ role: "user", content: "a" }] });
    assert.equal(s.seen.length, 1);
    assert.equal(s.seen[0].body.max_completion_tokens, 16000);
    assert.throws(() => openai(s.base, { tokenParam: "max_output" }), /LLM_TOKEN_PARAM/);
  } finally { s.close(); }
});

test("OpenAI-compatible: any other 400 is an error after one request", async () => {
  const s = await stub(() => ({ status: 400, body: { error: { message: "The model 'gpt-x' does not exist" } } }));
  try {
    await assert.rejects(openai(s.base).complete({ system: "s", messages: [{ role: "user", content: "a" }] }), /LLM 400: The model 'gpt-x' does not exist/);
    assert.equal(s.seen.length, 1);
  } finally { s.close(); }
});
