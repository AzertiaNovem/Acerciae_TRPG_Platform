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

    std::string llmProvider = "openai_compatible";
    std::string llmApiBase = "https://api.openai.com/v1";
    std::string llmApiKey;
    std::string llmModel = "gpt-4o-mini";
    int llmTimeoutMs = 60000;
    int llmMaxTokens = 2048;
    double llmTemperature = 0.2;
    std::string llmEmbeddingModel;

    bool observerEnabled = true;
    int observerIntervalMs = 5000;
    int consolidatorIntervalMs = 60000;
    int observerMaxBatch = 40;
    int highlightTtlSeconds = 900;
    int highlightCleanupIntervalMs = 30000;
    bool seedDemo = true;
    std::string migrationsDir = "./migrations";

    bool mockLlm() const { return llmApiKey.empty(); }
    static Config fromEnv();
};

} // namespace acerciae
