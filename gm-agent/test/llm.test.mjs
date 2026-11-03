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
    assert.deepEqual(r.body.system, [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }], "the system prompt is cached for an hour");
    assert.equal(r.body.betas, undefined, "betas travel as a header");
  } finally { s.close(); }
});

test("Claude: cache markers go on the marked parts (newest first, at most 4 with the system prompt), and usage is reported whole", async () => {
  const s = await stub({ id: "msg_3", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 7 } });
  try {
    const llm = createLlm({ provider: "anthropic", apiKey: "k", apiBase: s.base, fallbacks: false, timeoutMs: 5000, cacheTtl: "5m" });
    const usage = [];
    const parts = [{ text: "A", cache: true }, { text: "B", cache: true }, { text: "C", cache: true }, { text: "D", cache: true }, { text: "tail" }];
    await llm.complete({ system: "sys", messages: [{ role: "user", content: parts }], onUsage: (u) => usage.push(u) });
    const [r] = s.seen;
    assert.deepEqual(r.body.system[0].cache_control, { type: "ephemeral" }, "5-minute TTL when configured");
    const marked = r.body.messages[0].content.map((b) => Boolean(b.cache_control));
    assert.deepEqual(marked, [false, true, true, true, false], "three markers left after the system prompt, on the newest marked parts");
    assert.ok(r.body.messages[0].content.every((b) => b.type === "text" && !("mark" in b)));
    assert.deepEqual(usage, [{ model: "claude-opus-5-5", input: 1000, cacheRead: 900, cacheWrite: 90, output: 7 }]);
  } finally { s.close(); }
});

test("Claude: LLM_CACHE_TTL=off sends no markers", async () => {
  const s = await stub({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } });
  try {
    const llm = createLlm({ provider: "anthropic", apiKey: "k", apiBase: s.base, fallbacks: false, timeoutMs: 5000, cacheTtl: "off" });
    await llm.complete({ system: "sys", messages: [{ role: "user", content: [{ text: "A", cache: true }, { text: "B" }] }] });
    assert.equal(s.seen[0].body.system, "sys");
    assert.ok(!JSON.stringify(s.seen[0].body).includes("cache_control"));
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

test("OpenAI-compatible: parts are sent as one text, usage with cached tokens is reported, and prompt_cache_key goes only to api.openai.com", async () => {
  const s = await stub(responseObject("{}", { usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 400 }, output_tokens: 9 } }));
  try {
    const llm = createLlm({ provider: "openai_compatible", apiKey: "k", apiBase: `${s.base}/v1`, model: "gpt-x", timeoutMs: 5000, stream: false });
    const usage = [];
    await llm.complete({ system: "sys", messages: [{ role: "user", content: [{ text: "A\n", cache: true }, { text: "B" }] }], cacheKey: "key-1", onUsage: (u) => usage.push(u) });
    assert.equal(s.seen[0].body.input[0].content, "A\nB");
    assert.equal(s.seen[0].body.prompt_cache_key, undefined, "a local gateway gets no cache key");
    assert.deepEqual(usage, [{ model: "gpt-x", input: 500, cacheRead: 400, cacheWrite: 0, output: 9 }]);
  } finally { s.close(); }
});

test("Claude: volatile context uses 5m after the stable 1h prefix, including later repair messages", async () => {
  const s = await stub({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: {} });
  try {
    const llm = createLlm({ provider: "anthropic", apiKey: "k", apiBase: s.base, fallbacks: false, timeoutMs: 5000, cacheTtl: "1h" });
    await llm.complete({ system: "rules", messages: [
      { role: "user", content: [{ text: "stable world", cache: true }, { text: "changing platform notes", cache: true, cacheTtl: "5m" }, { text: "this turn" }] },
      { role: "assistant", content: "draft" },
      { role: "user", content: [{ text: "critique", cache: true }] },
    ] });
    const b = s.seen[0].body;
    assert.deepEqual(b.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.deepEqual(b.messages[0].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.deepEqual(b.messages[0].content[1].cache_control, { type: "ephemeral" });
    assert.deepEqual(b.messages[2].content[0].cache_control, { type: "ephemeral" });
    assert.equal(b.messages[0].content[2].cache_control, undefined);
    assert.ok(!JSON.stringify(b).includes("shortCache"));
  } finally { s.close(); }
});

test("OpenAI records tokens from a truncated response before reporting the failure", async (t) => {
  const llm = streamingLlm(t, sse({ type: "response.incomplete", response: responseObject("{}", {
    model: "served-model", status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 400 }, output_tokens: 80 },
  }) }));
  const usage = [];
  await assert.rejects(llm.complete({ ...request, onUsage: (u) => usage.push(u) }), /truncated/);
  assert.deepEqual(usage, [{ model: "served-model", input: 500, cacheRead: 400, cacheWrite: 0, output: 80 }]);
});

test("OpenAI JSON refusal with usage is counted; missing usage isn't reported as zero", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "completed", usage: { input_tokens: 25, output_tokens: 7 }, output: [{ type: "message", content: [{ type: "refusal" }] }] }));
  const llm = createLlm({ provider: "openai_compatible", apiBase: "https://fixture.invalid/v1", model: "test", stream: false });
  const usage = [];
  await assert.rejects(llm.complete({ ...request, onUsage: (u) => usage.push(u) }), /declined/);
  assert.equal(usage[0].output, 7);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => Response.json(responseObject("{}", { usage: undefined })));
  await llm.complete({ ...request, onUsage: (u) => usage.push(u) });
  assert.equal(usage.length, 1);
});
