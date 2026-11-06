// Show activity without printing prompts, generated text, or credentials.
export function withProgress(llm, log) {
  return Object.assign(Object.create(llm), {
    async complete(request) {
      const label = request.purpose || "completion";
      const start = Date.now();
      // A second attempt says why the first reply was not used (the validator's or the platform's reason).
      if (request.retryReason) log(`LLM ${label}: the reply could not be used (${String(request.retryReason).replace(/\s+/g, " ").slice(0, 300)}); asking again…`);
      else log(`LLM ${label}: generating…`);
      const timer = setInterval(() => log(`LLM ${label}: still waiting (${Math.round((Date.now() - start) / 1000)}s elapsed)`), 15000);
      timer.unref();
      try {
        const result = await llm.complete(request);
        log(`LLM ${label}: response received (${Math.round((Date.now() - start) / 1000)}s)`);
        return result;
      } finally {
        clearInterval(timer);
      }
    },
  });
}
