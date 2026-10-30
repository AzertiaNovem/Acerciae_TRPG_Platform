// Any OpenAI-compatible chat-completions endpoint (a hosted service or a self-hosted model).
// The token limit has two names: OpenAI's newer and reasoning models accept only `max_completion_tokens`, many other
// servers only `max_tokens`. The client starts with LLM_TOKEN_PARAM (default `max_tokens`) and, when the server refuses
// that name and names the other one, switches for the rest of the process and retries the request once.
const TOKEN_PARAMS = ["max_tokens", "max_completion_tokens"];

export class OpenAiCompatLlm {
  constructor({ apiKey, apiBase, model, maxTokens, timeoutMs, stream = true, tokenParam }) {
    if (!apiBase) throw new Error("LLM_API_BASE is required for openai_compatible (for example https://api.example.com/v1)");
    if (!model) throw new Error("LLM_MODEL is required for openai_compatible");
    if (tokenParam && !TOKEN_PARAMS.includes(tokenParam)) throw new Error(`LLM_TOKEN_PARAM must be ${TOKEN_PARAMS.join(" or ")}`);
    this.base = apiBase.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens || 16000;
    this.timeoutMs = timeoutMs ?? 600000;
    this.stream = stream;
    this.tokenParam = tokenParam || "max_tokens";
  }

  async complete({ system, messages }) {
    try {
      return await this.request(system, messages);
    } catch (e) {
      if (e.name === "TimeoutError") throw new Error(`LLM request exceeded the client timeout (${this.timeoutMs / 1000}s). Check the provider or LLM_TIMEOUT_MS.`, { cause: e });
      throw e;
    }
  }

  // The other token-limit name when a 400 says this one is unsupported and asks for the other, else null.
  otherTokenParam(status, data) {
    if (status !== 400) return null;
    const message = String(data?.error?.message ?? JSON.stringify(data ?? ""));
    const other = TOKEN_PARAMS.find((p) => p !== this.tokenParam);
    return message.includes(this.tokenParam) && message.includes(other) ? other : null;
  }

  async request(system, messages, retried = false) {
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, [this.tokenParam]: this.maxTokens, stream: this.stream, messages: [{ role: "system", content: system }, ...messages] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const other = retried ? null : this.otherTokenParam(res.status, data);
      if (other) { this.tokenParam = other; return this.request(system, messages, true); }
      const detail = data?.error?.message ?? (typeof data?.error === "string" ? data.error : null);
      const explanation = res.status === 504
        ? "gateway timed out waiting for the model; increasing the client timeout cannot extend the gateway limit. Retry later or check the model gateway."
        : detail || res.statusText || "empty or non-JSON error response";
      const error = new Error(`LLM ${res.status}: ${explanation}`);
      error.status = res.status;
      throw error;
    }
    if (res.headers.get("content-type")?.includes("text/event-stream")) return readStream(res.body);
    // Some compatible gateways ignore stream=true and still return a JSON completion.
    const data = await res.json();
    if (data.error) throw new Error(`LLM: ${data.error.message ?? data.error}`);
    return checkedText(data?.choices?.[0]?.message?.content, data?.choices?.[0]?.finish_reason);
  }
}

function checkedText(text, finishReason) {
  if (finishReason === "length") throw new Error("LLM output was truncated by the token limit; increase LLM_MAX_TOKENS or request a shorter response.");
  if (typeof text !== "string" || !text.trim()) throw new Error("LLM returned no text; check the model response and token budget.");
  return text;
}

// Decode SSE across arbitrary network chunks, including split UTF-8 characters.
// Do not accept a dropped connection as a complete role card.
async function readStream(body) {
  if (!body) throw new Error("LLM returned an empty stream");
  const decoder = new TextDecoder();
  let buffer = "", text = "", finishReason = null;
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue; // Includes gateway keepalive comments.
      if (data.trim() === "[DONE]") return checkedText(text, finishReason);
      const event = JSON.parse(data);
      if (event.error) throw new Error(`LLM stream: ${event.error.message ?? event.error}`);
      const choice = event.choices?.[0];
      if (typeof choice?.delta?.content === "string") text += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }
  // A final finish_reason is also an explicit completion signal on compatible servers.
  if (buffer.trim() || !finishReason) throw new Error("LLM stream ended before completion; retry the request.");
  return checkedText(text, finishReason);
}
