// Bound the wait for the first byte and for subsequent bytes, including SSE keepalives.
export async function withResponseTimeout(ms, parent, streaming, run) {
  const idle = new AbortController();
  const signal = parent ? AbortSignal.any([parent, idle.signal]) : idle.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => idle.abort(Object.assign(new Error(streaming
    ? `LLM sent no data for ${ms / 1000}s. Check the provider or llm.timeout_ms in gm-agent.yml.`
    : `LLM request exceeded the client timeout (${ms / 1000}s). Check the provider or llm.timeout_ms in gm-agent.yml.`), { code: streaming ? 'LLM_IDLE_TIMEOUT' : 'LLM_TIMEOUT' })), ms);
  timer.unref();
  try {
    const result = await run(signal, () => { if (streaming) timer.refresh(); });
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function* textChunks(body, activity) {
  if (!body) throw new Error("LLM returned an empty response");
  const decoder = new TextDecoder();
  for await (const bytes of body) {
    activity();
    yield decoder.decode(bytes, { stream: true });
  }
  yield decoder.decode();
}

// Some compatible gateways send chunked JSON even when asked for SSE.
export async function readJson(body, activity) {
  let text = "";
  for await (const part of textChunks(body, activity)) text += part;
  return JSON.parse(text);
}

export async function* streamEvents(body, activity) {
  let buffer = "";
  for await (const part of textChunks(body, activity)) {
    buffer += part;
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      if (event.type === "error") throw Object.assign(new Error(`LLM stream: ${event.message ?? event.error?.message ?? "provider error"}`), {
        code: event.error?.code ?? event.error?.type ?? event.code,
      });
      yield event;
    }
  }
  throw Object.assign(new Error("LLM stream ended before completion; retry the request."), { code: 'LLM_STREAM_INTERRUPTED' });
}
