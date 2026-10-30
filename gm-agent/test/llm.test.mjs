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
    assert.equal(s.seen[0].body.stream, true);
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

function streamingLlm(t, wire) {
  const bytes = new TextEncoder().encode(wire);
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      // Deliberately split inside UTF-8 code points, JSON, and CRLF boundaries.
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } }));
  return createLlm({ provider: "openai_compatible", apiBase: "https://fixture.invalid/v1", model: "test", timeoutMs: 5000 });
}

const delta = (content, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\r\n\r\n`;
const request = { system: "test", messages: [{ role: "user", content: "test" }] };

test("OpenAI stream: split Chinese UTF-8, keepalives and DONE produce one full reply", async (t) => {
  const llm = streamingLlm(t, ': keepalive\r\n\r\n' + delta('{"name":"') + delta('调查员"}') + delta('', 'stop') + 'data: [DONE]\r\n\r\n');
  assert.equal(await llm.complete(request), '{"name":"调查员"}');
});

test("OpenAI stream: an interrupted response is never accepted as a role card", async (t) => {
  const llm = streamingLlm(t, delta('{"name":"partial"}'));
  await assert.rejects(llm.complete(request), /ended before completion/);
});

test("OpenAI stream: token exhaustion is actionable, even when the text is valid JSON", async (t) => {
  const llm = streamingLlm(t, delta('{}', 'length') + 'data: [DONE]\r\n\r\n');
  await assert.rejects(llm.complete(request), /truncated.*LLM_MAX_TOKENS/);
});

test("OpenAI stream: provider errors inside a 200 response are surfaced", async (t) => {
  const llm = streamingLlm(t, 'data: {"error":{"message":"upstream unavailable"}}\n\n');
  await assert.rejects(llm.complete(request), /upstream unavailable/);
});

test("OpenAI stream: compatible endpoints may end after an explicit finish_reason", async (t) => {
  const llm = streamingLlm(t, delta('{}', 'stop'));
  assert.equal(await llm.complete(request), '{}');
});

test("OpenAI-compatible: HTML 504 explains the gateway timeout instead of null", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response('<html>Gateway timeout</html>', { status: 504 }));
  const llm = createLlm({ provider: "openai_compatible", apiBase: "https://fixture.invalid/v1", model: "test" });
  await assert.rejects(llm.complete(request), (error) => error.status === 504 && /gateway timed out/.test(error.message) && !/null/.test(error.message));
});

test("OpenAI-compatible: streaming can be disabled for older gateways", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    body = JSON.parse(options.body);
    return Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
  });
  const llm = createLlm({ provider: "openai_compatible", apiBase: "https://fixture.invalid/v1", model: "test", stream: false });
  assert.equal(await llm.complete(request), '{}');
  assert.equal(body.stream, false);
});
