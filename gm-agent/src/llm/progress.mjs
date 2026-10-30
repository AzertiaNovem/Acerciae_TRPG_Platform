// Show activity without printing prompts, generated text, or credentials.
export function withProgress(llm, log) {
  return {
    async complete(request) {
      const label = request.purpose || "completion";
      const start = Date.now();
      log(`LLM ${label}: generating…`);
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
  };
}
