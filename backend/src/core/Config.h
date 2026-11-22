#pragma once
#include <string>
#include <vector>
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
    int llmVnMaxTokens = 32768;
    int llmVnTimeoutMs = 300000;
    bool vnScriptRetryFailedChunks = true;
    double llmTemperature = 0.2;
    bool aiAllowPrivateEndpoints = false;   // allow http:// and private/loopback hosts (self-hosted models)
    int llmMaxConnections = 32;
    int llmQueueLimit = 128;
    int aiHttpWorkers = 8;                  // threads that run user-triggered AI requests off the HTTP threads

    bool observerEnabled = true;
    int observerIntervalMs = 5000;
    // Bots (bots/BotRuntime): how often the runtime looks at the tables, how long a window must be quiet before a bot
    // speaks, and how long it waits for the GM to answer a player first. BOTS_ENABLED=false keeps every bot silent.
    bool botsEnabled = true;
    int botTickMs = 2000, botSettleMs = 6000, botGmWaitMs = 90000;
    // How long a window must be quiet before a bot writes down a long stretch of play (bots/BotMemory); outside the
    // table, how long a bot waits between asking itself whether to join in on its own, and the quiet it waits for.
    int botMemoryQuietMs = 600000, botChatterGapMs = 300000, botChatterQuietMs = 20000;
    int consolidatorIntervalMs = 60000;
    int observerMaxBatch = 40;
    int highlightTtlSeconds = 900;
    int highlightCleanupIntervalMs = 30000;
    bool seedDemo = false;                  // demo accounts with a published password: local development only
    bool allowInsecureDev = false;          // ALLOW_INSECURE_DEV: accept a weak AUTH_SECRET and demo seeding (never in production)
    std::string publicUrl;                  // PUBLIC_URL: the site's address (https://trpg.example.com) for absolute links in exports; "" = the request's host
    std::string corsOrigins;                // CORS_ORIGINS: comma-separated origins allowed cross-origin ("" = same origin only)
    bool trustProxy = false;                // TRUST_PROXY: take the client address from X-Forwarded-For (behind a reverse proxy)
    int registerPerHour = 20;               // AUTH_REGISTER_PER_HOUR: new accounts per client address per hour
    bool hypertextEnabled = true;           // HYPERTEXT_ENABLED: interactive messages (kind hypertext); false = 403 feature_disabled
    std::vector<std::string> platformAdmins; // PLATFORM_ADMINS: usernames that administer the deployment (the admin panel, suspensions)
    int retentionAuditDays = 365;           // studio audit rows
    int retentionAiJobDays = 30;            // finished background AI job rows
    std::string migrationsDir = "./migrations";

    static Config fromEnv();
    // Why the secret is unacceptable, or "" when it is fine.
    static std::string weakSecretReason(const std::string& secret);
};

} // namespace acerciae
