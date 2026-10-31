#include "Config.h"
#include <cstdlib>
#include <string>
#include <stdexcept>
#include <cstdio>

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
    c.apiWorkers = envInt("API_WORKERS", c.apiWorkers);
    c.apiQueueLimit = envInt("API_QUEUE_LIMIT", c.apiQueueLimit);
    c.authSecret = envStr("AUTH_SECRET", c.authSecret);
    c.authTokenTtlHours = envInt("AUTH_TOKEN_TTL_HOURS", c.authTokenTtlHours);
    c.uploadDir = envStr("UPLOAD_DIR", c.uploadDir);
    c.maxUploadMb = (std::size_t)envInt("MAX_UPLOAD_MB", (int)c.maxUploadMb);
    for (auto* gone : {"LLM_PROVIDER", "LLM_API_BASE", "LLM_API_KEY", "LLM_MODEL", "LLM_EMBEDDING_MODEL", "IMAGE_PROVIDER", "IMAGE_API_KEY", "IMAGE_API_BASE", "IMAGE_API_URL", "IMAGE_MODEL", "QWEN_API_KEY", "QWEN_API_BASE", "TTS_PROVIDER"})
        if (const char* v = std::getenv(gone); v && *v) std::fprintf(stderr, "warning: %s is ignored; AI providers and keys are configured per server by its maintainers\n", gone);
    c.llmTimeoutMs = envInt("LLM_TIMEOUT_MS", c.llmTimeoutMs);
    c.llmMaxTokens = envInt("LLM_MAX_TOKENS", c.llmMaxTokens);
    c.llmModuleMaxTokens = envInt("LLM_MODULE_MAX_TOKENS", c.llmModuleMaxTokens);
    c.llmModuleTimeoutMs = envInt("LLM_MODULE_TIMEOUT_MS", c.llmModuleTimeoutMs);
    c.llmVnMaxTokens = envInt("LLM_VN_MAX_TOKENS", c.llmVnMaxTokens);
    c.llmVnTimeoutMs = envInt("LLM_VN_TIMEOUT_MS", c.llmVnTimeoutMs);
    c.vnScriptRetryFailedChunks = envBool("VN_SCRIPT_RETRY_FAILED_CHUNKS", c.vnScriptRetryFailedChunks);
    if (c.llmVnMaxTokens < 1 || c.llmVnTimeoutMs < 1000)
        throw std::runtime_error("LLM_VN_MAX_TOKENS must be positive and LLM_VN_TIMEOUT_MS at least 1000 ms");
    if(c.llmMaxTokens<1 || c.llmModuleMaxTokens<1 || c.llmModuleTimeoutMs<1000)
        throw std::runtime_error("LLM output limits must be positive and module timeout at least 1000 ms");
    c.llmTemperature = envDouble("LLM_TEMPERATURE", c.llmTemperature);
    c.aiAllowPrivateEndpoints = envBool("AI_ALLOW_PRIVATE_ENDPOINTS", c.aiAllowPrivateEndpoints);
    c.aiHttpWorkers = envInt("AI_HTTP_WORKERS", c.aiHttpWorkers);
    c.llmMaxConnections = envInt("LLM_MAX_CONNECTIONS", c.llmMaxConnections);
    c.llmQueueLimit = envInt("LLM_QUEUE_LIMIT", c.llmQueueLimit);
    if (c.httpThreads < 1 || c.httpThreads > 64 || c.apiWorkers < 1 || c.apiWorkers > 128 ||
        c.aiHttpWorkers < 1 || c.aiHttpWorkers > 128 || c.apiQueueLimit < 1 || c.apiQueueLimit > 4096 ||
        c.llmMaxConnections < 1 || c.llmMaxConnections > 256 || c.llmQueueLimit < 0 || c.llmQueueLimit > 4096)
        throw std::runtime_error("HTTP/API/AI worker and queue limits are outside the supported range");
    c.observerEnabled = envBool("AI_OBSERVER_ENABLED", c.observerEnabled);
    c.observerIntervalMs = envInt("AI_OBSERVER_INTERVAL_MS", c.observerIntervalMs);
    c.consolidatorIntervalMs = envInt("AI_CONSOLIDATOR_INTERVAL_MS", c.consolidatorIntervalMs);
    c.observerMaxBatch = envInt("AI_OBSERVER_MAX_BATCH", c.observerMaxBatch);
    c.highlightTtlSeconds = envInt("HIGHLIGHT_TTL_SECONDS", c.highlightTtlSeconds);
    c.highlightCleanupIntervalMs = envInt("HIGHLIGHT_CLEANUP_INTERVAL_MS", c.highlightCleanupIntervalMs);
    c.seedDemo = envBool("SEED_DEMO", c.seedDemo);
    c.allowInsecureDev = envBool("ALLOW_INSECURE_DEV", c.allowInsecureDev);
    c.corsOrigins = envStr("CORS_ORIGINS", c.corsOrigins);
    c.trustProxy = envBool("TRUST_PROXY", c.trustProxy);
    c.registerPerHour = envInt("AUTH_REGISTER_PER_HOUR", c.registerPerHour);
    c.retentionAuditDays = envInt("RETENTION_AUDIT_DAYS", c.retentionAuditDays);
    c.retentionAiJobDays = envInt("RETENTION_AI_JOB_DAYS", c.retentionAiJobDays);
    c.migrationsDir = envStr("MIGRATIONS_DIR", c.migrationsDir);
    return c;
}

std::string Config::weakSecretReason(const std::string& s) {
    if (s.empty()) return "AUTH_SECRET is not set";
    for (auto* known : {"dev-secret", "change-me-in-production", "changeme", "change-me", "secret", "password"})
        if (s == known) return "AUTH_SECRET is a published default";
    if (s.size() < 32) return "AUTH_SECRET is shorter than 32 characters";
    return "";
}

} // namespace acerciae
