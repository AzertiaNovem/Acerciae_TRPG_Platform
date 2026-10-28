#pragma once
#include <string>
#include <cstdint>

namespace acerciae {

// All runtime configuration is read from environment variables (see .env.example).
struct Config {
    std::string databaseUrl = "postgresql://acerciae:acerciae@localhost:5432/acerciae";
    int httpPort = 8080;
    int httpThreads = 4;
    std::string authSecret = "dev-secret";
    int authTokenTtlHours = 168;
    std::string uploadDir = "./uploads";
    std::size_t maxUploadMb = 50;

    // AI providers, models and keys belong to each server's maintainers (server settings); the process only sets
    // operational guards for every outbound AI call.
    int llmTimeoutMs = 60000;
    int llmMaxTokens = 2048;
    double llmTemperature = 0.2;
    bool aiAllowPrivateEndpoints = false;   // allow http:// and private/loopback hosts (self-hosted models)
    int aiHttpWorkers = 8;                  // threads that run user-triggered AI requests off the HTTP threads

    bool observerEnabled = true;
    int observerIntervalMs = 5000;
    int consolidatorIntervalMs = 60000;
    int observerMaxBatch = 40;
    int highlightTtlSeconds = 900;
    int highlightCleanupIntervalMs = 30000;
    bool seedDemo = true;
    std::string migrationsDir = "./migrations";

    static Config fromEnv();
};

} // namespace acerciae
