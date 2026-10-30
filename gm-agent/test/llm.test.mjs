import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createLlm } from "../src/llm/index.mjs";

// A local stand-in for the provider endpoint that records the request.
async function stub(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
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
