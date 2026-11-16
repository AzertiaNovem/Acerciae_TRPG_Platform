// Any endpoint implementing the OpenAI Responses API (POST {LLM_API_BASE}/responses), streamed by default.
// Nothing is stored on the provider (store: false): each request carries its whole conversation. Caching is by prefix,
// automatic: the parts (parts.mjs) keep their stable-first order, and OpenAI's own API also gets a prompt_cache_key per
// purpose (other gateways may reject unknown fields, so they do not).
import { readJson, streamEvents, withResponseTimeout } from "./stream.mjs";
import { textOf } from "./parts.mjs";

const officialOpenAi = (base) => /^https:\/\/api\.openai\.com(:443)?(\/.*)?$/.test(base);
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

  async complete({ system, messages, cacheKey, onUsage, signal, tools, toolChoice }) {
    const result = await withResponseTimeout(this.timeoutMs, signal, this.stream, (requestSignal, activity) =>
      this.request(system, messages, cacheKey, (response) => {
        const usage = response?.usage;
        if (usage) onUsage?.({ model: response.model ?? this.model, input: usage.input_tokens ?? null,
          cacheRead: usage.input_tokens_details?.cached_tokens ?? 0, cacheWrite: 0, output: usage.output_tokens ?? null });
      }, requestSignal, activity, tools, toolChoice));
    return tools ? result : result.text;
  }

  async request(system, messages, cacheKey, onResponse, signal, activity, tools, toolChoice) {
    const res = await fetch(`${this.base}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        instructions: system,
        input: messages.flatMap(m => m.providerOutput ?? (m.toolResults
          ? m.toolResults.map(r => ({ type: 'function_call_output', call_id: r.id, output: JSON.stringify(r.result) }))
          : [{ role: m.role === "assistant" ? "assistant" : "user", content: textOf(m.content) }])),
        max_output_tokens: this.maxTokens,
        stream: this.stream,
        store: false,
        ...(tools ? { tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema, strict: false })), tool_choice: toolChoice ?? 'auto', parallel_tool_calls: false, include: ['reasoning.encrypted_content'] } : {}),
        ...(cacheKey && officialOpenAi(this.base) ? { prompt_cache_key: cacheKey } : {}),
      }),
      signal,
    });
    activity();
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
    if (res.headers.get("content-type")?.includes("text/event-stream")) return readStream(res.body, onResponse, activity, Boolean(tools));
    // Some compatible gateways ignore stream=true and still return the whole response as JSON.
    return checkedText(await readJson(res.body, activity), "", onResponse, Boolean(tools));
  }
}

// The reply text and token usage of a finished response object; truncation, refusals and failures are errors.
function checkedText(response, streamedText = "", onResponse = () => {}, withTools = false) {
  // A truncated/refused response still consumed tokens: report usage before checking its text.
  onResponse(response);
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
  const calls = (response?.output ?? []).filter(x => x.type === 'function_call').map(x => ({ id: x.call_id, name: x.name, arguments: x.arguments }));
  if ((!withTools || !calls.length) && (typeof text !== "string" || !text.trim())) throw new Error("LLM returned no text; check the model response and token budget.");
  if (!withTools && calls.length) throw new Error('Unexpected tool call on a text-only request');
  return { text, calls, providerOutput: response?.output ?? [], usage: response?.usage ?? null };
}

// Decode the Responses SSE stream across arbitrary network chunks, including split UTF-8 characters. Only a terminal
// event (response.completed / .incomplete / .failed) ends it: a dropped connection is never accepted as a reply.
async function readStream(body, onResponse, activity, withTools = false) {
  let text = "";
  const items = new Map();
  for await (const event of streamEvents(body, activity)) {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') items.set(event.output_index, structuredClone(event.item));
    if (event.type === 'response.function_call_arguments.delta') {
      const item = items.get(event.output_index);
      if (item?.type !== 'function_call') throw Error('LLM stream is missing its function call');
      item.arguments = (item.arguments ?? '') + event.delta;
    }
    if (event.type === 'response.function_call_arguments.done') {
      const item = items.get(event.output_index);
      if (item) item.arguments = event.arguments;
    }
    if (event.type === "response.completed") return checkedText({ ...event.response,
      ...(withTools && !event.response?.output?.length && items.size ? { output: [...items.entries()].sort((a,b) => a[0]-b[0]).map(([,v]) => v) } : {}) }, text, onResponse, withTools);
    if (event.type === "response.incomplete" || event.type === "response.failed") {
      return checkedText({ ...event.response, status: event.type.slice("response.".length) }, text, onResponse, withTools);
    }
  }
}
