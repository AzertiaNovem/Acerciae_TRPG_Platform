#include "Config.h"
#include <cstdlib>
#include <string>

namespace acerciae {

static std::string envStr(const char* k, const std::string& def) {
    const char* v = std::getenv(k);
    return (v && *v) ? std::string(v) : def;
}
static int envInt(const char* k, int def) {
    const char* v = std::getenv(k);
    if (!v || !*v) return def;
    try { return std::stoi(v); } catch (...) { return def; }
}
static double envDouble(const char* k, double def) {
    const char* v = std::getenv(k);
    if (!v || !*v) return def;
    try { return std::stod(v); } catch (...) { return def; }
}
static bool envBool(const char* k, bool def) {
    const char* v = std::getenv(k);
    if (!v || !*v) return def;
    std::string s(v);
    return s == "1" || s == "true" || s == "TRUE" || s == "yes" || s == "on";
}

Config Config::fromEnv() {
    Config c;
    c.databaseUrl = envStr("DATABASE_URL", c.databaseUrl);
    c.httpPort = envInt("HTTP_PORT", c.httpPort);
    c.httpThreads = envInt("HTTP_THREADS", c.httpThreads);
    c.authSecret = envStr("AUTH_SECRET", c.authSecret);
    c.authTokenTtlHours = envInt("AUTH_TOKEN_TTL_HOURS", c.authTokenTtlHours);
    c.uploadDir = envStr("UPLOAD_DIR", c.uploadDir);
    c.maxUploadMb = (std::size_t)envInt("MAX_UPLOAD_MB", (int)c.maxUploadMb);
    c.llmProvider = envStr("LLM_PROVIDER", c.llmProvider);
    c.llmApiBase = envStr("LLM_API_BASE", c.llmApiBase);
    c.llmApiKey = envStr("LLM_API_KEY", "");
    c.llmModel = envStr("LLM_MODEL", c.llmModel);
    c.llmTimeoutMs = envInt("LLM_TIMEOUT_MS", c.llmTimeoutMs);
    c.llmMaxTokens = envInt("LLM_MAX_TOKENS", c.llmMaxTokens);
    c.llmTemperature = envDouble("LLM_TEMPERATURE", c.llmTemperature);
    c.llmEmbeddingModel = envStr("LLM_EMBEDDING_MODEL", "");
    c.observerEnabled = envBool("AI_OBSERVER_ENABLED", c.observerEnabled);
    c.observerIntervalMs = envInt("AI_OBSERVER_INTERVAL_MS", c.observerIntervalMs);
    c.consolidatorIntervalMs = envInt("AI_CONSOLIDATOR_INTERVAL_MS", c.consolidatorIntervalMs);
    c.observerMaxBatch = envInt("AI_OBSERVER_MAX_BATCH", c.observerMaxBatch);
    c.highlightTtlSeconds = envInt("HIGHLIGHT_TTL_SECONDS", c.highlightTtlSeconds);
    c.highlightCleanupIntervalMs = envInt("HIGHLIGHT_CLEANUP_INTERVAL_MS", c.highlightCleanupIntervalMs);
    c.seedDemo = envBool("SEED_DEMO", c.seedDemo);
    c.migrationsDir = envStr("MIGRATIONS_DIR", c.migrationsDir);
    return c;
}

} // namespace acerciae
