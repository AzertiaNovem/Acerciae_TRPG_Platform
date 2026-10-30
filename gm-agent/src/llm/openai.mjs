// Any OpenAI-compatible chat-completions endpoint (a hosted service or a self-hosted model).
// The token limit has two names: OpenAI's newer and reasoning models accept only `max_completion_tokens`, many other
// servers only `max_tokens`. The client starts with LLM_TOKEN_PARAM (default `max_tokens`) and, when the server refuses
// that name and names the other one, switches for the rest of the process and retries the request once.
const TOKEN_PARAMS = ["max_tokens", "max_completion_tokens"];

export class OpenAiCompatLlm {
  constructor({ apiKey, apiBase, model, maxTokens, timeoutMs, tokenParam }) {
    if (!apiBase) throw new Error("LLM_API_BASE is required for openai_compatible (for example https://api.example.com/v1)");
    if (!model) throw new Error("LLM_MODEL is required for openai_compatible");
    if (tokenParam && !TOKEN_PARAMS.includes(tokenParam)) throw new Error(`LLM_TOKEN_PARAM must be ${TOKEN_PARAMS.join(" or ")}`);
    this.base = apiBase.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens || 16000;
    this.timeoutMs = timeoutMs;
    this.tokenParam = tokenParam || "max_tokens";
  }

  async request(system, messages) {
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, [this.tokenParam]: this.maxTokens, messages: [{ role: "system", content: system }, ...messages] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return { res, data: await res.json().catch(() => null) };
  }

  // The other token-limit name when a 400 says this one is unsupported and asks for the other, else null.
  otherTokenParam(status, data) {
    if (status !== 400) return null;
    const message = String(data?.error?.message ?? JSON.stringify(data ?? ""));
    const other = TOKEN_PARAMS.find((p) => p !== this.tokenParam);
    return message.includes(this.tokenParam) && message.includes(other) ? other : null;
  }

  async complete({ system, messages }) {
    let { res, data } = await this.request(system, messages);
    const other = this.otherTokenParam(res.status, data);
    if (other) {
      this.tokenParam = other;
      ({ res, data } = await this.request(system, messages));
    }
    if (!res.ok) throw new Error(`LLM ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
    return data?.choices?.[0]?.message?.content ?? "";
  }
}
