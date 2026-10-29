#pragma once
#include <string>
#include <cstdint>

namespace acerciae {

// All runtime configuration is read from environment variables (see .env.example).
struct Config {
    std::string databaseUrl = "postgresql://acerciae:acerciae@localhost:5432/acerciae";
    int httpPort = 8080;
    int httpThreads = 4;                 // Drogon socket event loops
    int apiWorkers = 8;                  // normal JSON API / database work
    int apiQueueLimit = 256;
    std::string authSecret;                 // required: at least 32 characters, not a published default
    int authTokenTtlHours = 168;
    std::string uploadDir = "./uploads";
    std::size_t maxUploadMb = 50;

    // AI providers, models and keys belong to each server's maintainers (server settings); the process only sets
    // operational guards for every outbound AI call.
    int llmTimeoutMs = 60000;
    int llmMaxTokens = 8192;
    int llmModuleMaxTokens = 32768;
    int llmModuleTimeoutMs = 300000;
    double llmTemperature = 0.2;
    bool aiAllowPrivateEndpoints = false;   // allow http:// and private/loopback hosts (self-hosted models)
    int llmMaxConnections = 32;
    int llmQueueLimit = 128;
    int aiHttpWorkers = 8;                  // threads that run user-triggered AI requests off the HTTP threads

    bool observerEnabled = true;
    int observerIntervalMs = 5000;
    int consolidatorIntervalMs = 60000;
    int observerMaxBatch = 40;
    int highlightTtlSeconds = 900;
    int highlightCleanupIntervalMs = 30000;
    bool seedDemo = false;                  // demo accounts with a published password: local development only
    bool allowInsecureDev = false;          // ALLOW_INSECURE_DEV: accept a weak AUTH_SECRET and demo seeding (never in production)
    std::string corsOrigins;                // CORS_ORIGINS: comma-separated origins allowed cross-origin ("" = same origin only)
    bool trustProxy = false;
    int registerPerHour = 20;               // AUTH_REGISTER_PER_HOUR: new accounts per client address per hour                // TRUST_PROXY: take the client address from X-Forwarded-For (behind a reverse proxy)
    int retentionAuditDays = 365;           // studio audit rows
    int retentionAiJobDays = 30;            // finished background AI job rows
    std::string migrationsDir = "./migrations";

    static Config fromEnv();
    // Why the secret is unacceptable, or "" when it is fine.
    static std::string weakSecretReason(const std::string& secret);
};

} // namespace acerciae
