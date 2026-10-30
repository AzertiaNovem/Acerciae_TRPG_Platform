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

// A finished OpenAI Responses object holding one text reply.
const responseObject = (text, extra = {}) => ({ status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1, output_tokens: 1 }, ...extra });
const request = { system: "sys", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "not JSON" }, { role: "user", content: "again" }] };

test("OpenAI-compatible: the Responses API with instructions, input items and no stored state", async () => {
  const s = await stub(responseObject("{}"));
  try {
    const llm = createLlm({ provider: "openai_compatible", apiKey: "k", apiBase: `${s.base}/v1`, model: "gpt-x", maxTokens: 1234, timeoutMs: 5000 });
    assert.equal(await llm.complete(request), "{}");
    const [r] = s.seen;
    assert.equal(r.url, "/v1/responses");
    assert.equal(r.headers.authorization, "Bearer k");
    assert.equal(r.body.model, "gpt-x");
    assert.equal(r.body.instructions, "sys");
    assert.deepEqual(r.body.input, [{ role: "user", content: "hi" }, { role: "assistant", content: "not JSON" }, { role: "user", content: "again" }]);
    assert.equal(r.body.max_output_tokens, 1234);
    assert.equal(r.body.store, false);
    assert.equal(r.body.stream, true);
    for (const old of ["messages", "max_tokens", "max_completion_tokens"]) assert.equal(r.body[old], undefined, `no Chat Completions field ${old}`);
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

const sse = (event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
const delta = (text) => sse({ type: "response.output_text.delta", output_index: 1, delta: text });
const finished = (text, extra) => sse({ type: "response.completed", response: responseObject(text, extra) });

test("OpenAI stream: split Chinese UTF-8 and keepalives end in one full reply at response.completed", async (t) => {
  const llm = streamingLlm(t, ': keepalive\r\n\r\n' + sse({ type: "response.created", response: { status: "in_progress" } }) + delta('{"name":"') + delta('调查员"}') + finished('{"name":"调查员"}'));
  assert.equal(await llm.complete(request), '{"name":"调查员"}');
});

test("OpenAI stream: a gateway that trims the final response still yields the streamed text", async (t) => {
  const llm = streamingLlm(t, delta('{"ok":') + delta("true}") + sse({ type: "response.completed", response: { status: "completed" } }));
  assert.equal(await llm.complete(request), '{"ok":true}');
});

test("OpenAI stream: an interrupted response is never accepted as a role card", async (t) => {
  const llm = streamingLlm(t, delta('{"name":"partial"}'));
  await assert.rejects(llm.complete(request), /ended before completion/);
});

test("OpenAI stream: token exhaustion is actionable, even when the text is valid JSON", async (t) => {
  const llm = streamingLlm(t, delta("{}") + sse({ type: "response.incomplete", response: responseObject("{}", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) }));
  await assert.rejects(llm.complete(request), /truncated.*LLM_MAX_TOKENS/);
});

test("OpenAI stream: provider errors and refusals inside a 200 response are surfaced", async (t) => {
  await assert.rejects(streamingLlm(t, sse({ type: "error", code: "server_error", message: "upstream unavailable" })).complete(request), /upstream unavailable/);
  t.mock.restoreAll();
  await assert.rejects(streamingLlm(t, sse({ type: "response.failed", response: { status: "failed", error: { message: "model overloaded" } } })).complete(request), /model overloaded/);
  t.mock.restoreAll();
  const refusal = { type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] } };
  await assert.rejects(streamingLlm(t, sse(refusal)).complete(request), /declined/);
});

test("OpenAI-compatible: HTML 504 explains the gateway timeout instead of null", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response('<html>Gateway timeout</html>', { status: 504 }));
  const llm = createLlm({ provider: "openai_compatible", apiBase: "https://fixture.invalid/v1", model: "test" });
  await assert.rejects(llm.complete(request), (error) => error.status === 504 && /gateway timed out/.test(error.message) && !/null/.test(error.message));
});

test("OpenAI-compatible: streaming can be disabled; the JSON response object is read from its output", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    body = JSON.parse(options.body);
    return Response.json(responseObject("{}"));
  });
  const llm = createLlm({ provider: "openai_compatible", apiBase: "https://fixture.invalid/v1", model: "test", stream: false });
  assert.equal(await llm.complete(request), "{}");
  assert.equal(body.stream, false);
});

test("OpenAI-compatible: a 400 is an error after one request", async () => {
  const s = await stub(() => ({ status: 400, body: { error: { message: "The model 'gpt-x' does not exist" } } }));
  try {
    const llm = createLlm({ provider: "openai_compatible", apiKey: "k", apiBase: `${s.base}/v1`, model: "gpt-x", timeoutMs: 5000 });
    await assert.rejects(llm.complete(request), /LLM 400: The model 'gpt-x' does not exist/);
    assert.equal(s.seen.length, 1);
  } finally { s.close(); }
});
