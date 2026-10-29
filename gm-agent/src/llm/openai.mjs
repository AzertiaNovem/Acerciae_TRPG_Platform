// Any OpenAI-compatible chat-completions endpoint (a hosted service or a self-hosted model).
export class OpenAiCompatLlm {
  constructor({ apiKey, apiBase, model, maxTokens, timeoutMs }) {
    if (!apiBase) throw new Error("LLM_API_BASE is required for openai_compatible (for example https://api.example.com/v1)");
    if (!model) throw new Error("LLM_MODEL is required for openai_compatible");
    this.base = apiBase.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens || 16000;
    this.timeoutMs = timeoutMs;
  }

  async complete({ system, messages }) {
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, max_tokens: this.maxTokens, messages: [{ role: "system", content: system }, ...messages] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`LLM ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
    return data?.choices?.[0]?.message?.content ?? "";
  }
}
