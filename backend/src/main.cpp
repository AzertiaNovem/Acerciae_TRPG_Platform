#include "app/Services.h"
#include "api/Api.h"
#include "ws/WsGateway.h"
#include "observer/ObserverScheduler.h"
#include "llm/LlmGateway.h"
#include "logstudio/TtsService.h"
#include "logstudio/CreativeService.h"
#include "logstudio/VnScriptService.h"
#include "seed/DemoSeed.h"
#include "core/Log.h"
#include <drogon/drogon.h>
#include <curl/curl.h>
#include <csignal>
#include <iostream>

using namespace acerciae;

int main(int argc, char** argv) {
    bool seedOnly = false, migrateOnly = false, noSeed = false;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--seed-demo") seedOnly = true;
        else if (a == "--migrate-only") migrateOnly = true;
        else if (a == "--no-seed") noSeed = true;
        else if (a == "--help") { std::cout << "acerciae-server [--migrate-only] [--seed-demo] [--no-seed]\n"; return 0; }
    }
    curl_global_init(CURL_GLOBAL_DEFAULT);
    auto cfg = Config::fromEnv();
    auto& S = Services::build(cfg);
    try { S.db->runMigrations(cfg.migrationsDir); }
    catch (const std::exception& e) { std::cerr << "migration failed: " << e.what() << "\n"; return 1; }
    if (migrateOnly) return 0;
    if (seedOnly) { DemoSeed::run(S, true); return 0; }
    if (cfg.seedDemo && !noSeed) { try { DemoSeed::run(S, false); } catch (const std::exception& e) { ALOG_ERROR << "demo seed failed: " << e.what(); } }

    registerRoutes();
    drogon::app().addListener("0.0.0.0", cfg.httpPort)
        .setThreadNum(cfg.httpThreads)
        .setClientMaxBodySize(cfg.maxUploadMb * 1024 * 1024 + 1024 * 1024)
        .setClientMaxWebSocketMessageSize(1024 * 1024)
        .setLogLevel(trantor::Logger::kInfo)
        .setIdleConnectionTimeout(300)
        .enableGzip(false);
    drogon::app().registerBeginningAdvice([&] { S.observer->start(); S.tts->start(); S.creative->start(); S.vnScripts->start(); });
    std::signal(SIGTERM, [](int) { drogon::app().quit(); });
    std::signal(SIGINT, [](int) { drogon::app().quit(); });
    ALOG_INFO << "Acerciae TRPG backend listening on :" << cfg.httpPort << " (AI providers: per server)";
    drogon::app().run();
    Services::shutdown();
    curl_global_cleanup();
    return 0;
}
