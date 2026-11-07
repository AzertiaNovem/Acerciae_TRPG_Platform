import { setTimeout as delay } from 'node:timers/promises';

// Only failures for which repeating an inference may help. Refusals, truncation, invalid requests and user
// cancellation are deliberately outside this list. No platform writes are retried here.
export function transientLlmError(error) {
  if ([408, 429, 500, 502, 503, 504, 520, 522, 523, 524].includes(error?.status)) return true;
  if (error?.status >= 400) return false;
  for (let e = error, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (['LLM_STREAM_INTERRUPTED', 'LLM_IDLE_TIMEOUT', 'LLM_TIMEOUT', 'stream_error', 'server_error', 'overloaded_error', 'rate_limit_error', 'rate_limit_exceeded', 'connection_error', 'timeout_error', 'ECONNRESET', 'ECONNREFUSED',
      'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(e.code)) return true;
    if (/stream disconnected before completion|stream closed before response\.completed|stream ended before completion|socket hang up|fetch failed|premature close/i.test(e.message ?? '')) return true;
  }
  return false;
}

// The budget belongs to the whole JSON operation, including its field repairs, rather than resetting per repair.
export function completionAttempts(llm, requestId, { signal, retryDelay = n => 2000 * 2 ** n } = {}) {
  signal ??= llm.signalOf?.();
  let attempt = 0, retries = 0;
  return async request => {
    let retryReason;
    for (;;) {
      signal?.throwIfAborted();
      try {
        return await llm.complete({ ...request, requestId, signal, attempt: ++attempt,
          ...(retryReason ? { retryKind: 'transport', retryReason } : {}) });
      } catch (error) {
        signal?.throwIfAborted();
        if (retries >= 2 || !transientLlmError(error)) throw error;
        retryReason = error.message;
        try { await delay(Math.max(0, retryDelay(retries++)), undefined, { signal }); }
        catch (waitError) { signal?.throwIfAborted(); throw waitError; }
      }
    }
  };
}
