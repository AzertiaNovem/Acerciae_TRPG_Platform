// Any endpoint implementing the OpenAI Responses API (POST {LLM_API_BASE}/responses), streamed by default.
// Nothing is stored on the provider (store: false): each request carries its whole conversation.
export class OpenAiCompatLlm {
  constructor({ apiKey, apiBase, model, maxTokens, timeoutMs, stream = true }) {
    if (!apiBase) throw new Error("LLM_API_BASE is required for openai_compatible (for example https://api.openai.com/v1)");
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
    const res = await fetch(`${this.base}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        instructions: system,
        input: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
        max_output_tokens: this.maxTokens,
        stream: this.stream,
        store: false,
      }),
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
    // Some compatible gateways ignore stream=true and still return the whole response as JSON.
    return checkedText(await res.json());
  }
}

// The reply text of a finished response object; truncation, refusals and failures are errors.
function checkedText(response, streamedText = "") {
  if (response?.error) throw new Error(`LLM: ${response.error.message ?? response.error}`);
  if (response?.status === "failed") throw new Error("LLM: the provider reported a failed response.");
  if (response?.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") throw new Error("LLM output was truncated by the token limit; increase LLM_MAX_TOKENS or request a shorter response.");
    throw new Error(`LLM response was incomplete${reason ? ` (${reason})` : ""}.`);
  }
  let text = "";
  for (const item of response?.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "refusal") throw new Error("LLM: the model declined this request.");
      if (part.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  if (!text) text = streamedText;   // a gateway that trims the final response object
  if (typeof text !== "string" || !text.trim()) throw new Error("LLM returned no text; check the model response and token budget.");
  return text;
}

// Decode the Responses SSE stream across arbitrary network chunks, including split UTF-8 characters. Only a terminal
// event (response.completed / .incomplete / .failed) ends it: a dropped connection is never accepted as a reply.
async function readStream(body) {
  if (!body) throw new Error("LLM returned an empty stream");
  const decoder = new TextDecoder();
  let buffer = "", text = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue; // Includes gateway keepalive comments and bare `event:` lines.
      const event = JSON.parse(data);
      if (event.type === "error") throw new Error(`LLM stream: ${event.message ?? event.error?.message ?? "provider error"}`);
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
      if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") return checkedText(event.response, text);
    }
  }
  throw new Error("LLM stream ended before completion; retry the request.");
}
