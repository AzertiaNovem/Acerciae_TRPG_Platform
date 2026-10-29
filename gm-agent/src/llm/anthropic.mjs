// Claude through the official Anthropic SDK.
import Anthropic from "@anthropic-ai/sdk";

export class AnthropicLlm {
  constructor({ apiKey, apiBase, model, effort, maxTokens, fallbacks, timeoutMs }) {
    this.client = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(apiBase ? { baseURL: apiBase } : {}), timeout: timeoutMs });
    this.model = model || "claude-opus-5-5";
    this.effort = effort || "medium";
    this.maxTokens = maxTokens || 16000;
    this.fallbacks = fallbacks;
  }

  async complete({ system, messages }) {
    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages,
      output_config: { effort: this.effort },
    };
    // On a policy decline the API re-runs the request on Anthropic's recommended fallback model.
    const response = this.fallbacks
      ? await this.client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : await this.client.messages.create(params);
    if (response.stop_reason === "refusal") throw new Error(`the model declined (${response.stop_details?.category ?? "refusal"})`);
    return response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
}
