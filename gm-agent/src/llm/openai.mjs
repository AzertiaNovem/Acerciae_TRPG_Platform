// Any OpenAI-compatible chat-completions endpoint (a hosted service or a self-hosted model).
export class OpenAiCompatLlm {
  constructor({ apiKey, apiBase, model, maxTokens, timeoutMs, stream = true }) {
    if (!apiBase) throw new Error("LLM_API_BASE is required for openai_compatible (for example https://api.example.com/v1)");
    if (!model) throw new Error("LLM_MODEL is required for openai_compatible");
    this.base = apiBase.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens || 16000;
    this.timeoutMs = timeoutMs ?? 600000;
    this.stream = stream;
  }

  async complete({ system, messages }) {
    try {
      return await this.request(system, messages);
    } catch (e) {
      if (e.name === "TimeoutError") throw new Error(`LLM request exceeded the client timeout (${this.timeoutMs / 1000}s). Check the provider or LLM_TIMEOUT_MS.`, { cause: e });
      throw e;
    }
  }

  async request(system, messages) {
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, max_tokens: this.maxTokens, stream: this.stream, messages: [{ role: "system", content: system }, ...messages] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
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
