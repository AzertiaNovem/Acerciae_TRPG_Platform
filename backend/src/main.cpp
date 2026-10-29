#include "modules/ModuleImporter.h"
#include "script/ScriptKnowledgeService.h"
#include "app/Services.h"
#include "api/Api.h"
#include "ws/WsGateway.h"
#include "observer/ObserverScheduler.h"
#include "llm/LlmGateway.h"
#include "logstudio/TtsService.h"
#include "logstudio/CreativeService.h"
#include "logstudio/VnScriptService.h"
#include "seed/DemoSeed.h"
#include "app/Maintenance.h"
#include "core/Log.h"
#include <drogon/drogon.h>
#include <curl/curl.h>
#include <csignal>
#include <iostream>
#include <cstdlib>

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
    // AUTH_SECRET signs every session and seals every server's API keys: never run on a guessable one.
    if (auto why = Config::weakSecretReason(cfg.authSecret); !why.empty()) {
        if (!cfg.allowInsecureDev) {
            std::cerr << "refusing to start: " << why << ". Generate one with `openssl rand -hex 32` (keep it: changing it "
                         "signs everyone out and makes stored server API keys unreadable). For local development only, set ALLOW_INSECURE_DEV=true.\n";
            return 1;
        }
        std::cerr << "WARNING: " << why << "; continuing because ALLOW_INSECURE_DEV=true. Never do this in production.\n";
        if (cfg.authSecret.empty()) cfg.authSecret = "insecure-local-development-secret-do-not-use";
    }
    if (cfg.seedDemo && !cfg.allowInsecureDev) {
        std::cerr << "SEED_DEMO is ignored: the demo accounts share a published password. Set ALLOW_INSECURE_DEV=true for a local demo.\n";
        cfg.seedDemo = false;
    }
    if (const char* w = std::getenv("PDF_WORKER_TOKEN"); !w || std::string(w).size() < 32)
        std::cerr << "warning: PDF_WORKER_TOKEN is unset or shorter than 32 characters; the PDF worker cannot connect and PDF jobs will stay pending.\n";
    auto& S = Services::build(cfg);
    try { S.db->runMigrations(cfg.migrationsDir); }
    catch (const std::exception& e) { std::cerr << "migration failed: " << e.what() << "\n"; Services::shutdown(); curl_global_cleanup(); return 1; }
    if (migrateOnly) { Services::shutdown(); curl_global_cleanup(); return 0; }
    if (seedOnly) { std::cerr << "Seeding demo accounts with the published password \"password\": local development only.\n"; DemoSeed::run(S, true); Services::shutdown(); curl_global_cleanup(); return 0; }
    if (cfg.seedDemo && !noSeed) { try { DemoSeed::run(S, false); } catch (const std::exception& e) { ALOG_ERROR << "demo seed failed: " << e.what(); } }

    S.modules->recoverInterrupted();
    S.script->recoverInterrupted();
    registerRoutes();
    drogon::app().addListener("0.0.0.0", cfg.httpPort)
        .setThreadNum(cfg.httpThreads)
        .setClientMaxBodySize(cfg.maxUploadMb * 1024 * 1024 + 1024 * 1024)
        .setClientMaxWebSocketMessageSize(1024 * 1024)
        .setLogLevel(trantor::Logger::kInfo)
        .setIdleConnectionTimeout(300)
        .enableGzip(false);
    drogon::app().registerBeginningAdvice([&] { S.observer->start(); S.tts->start(); S.creative->start(); S.vnScripts->start(); S.maintenance->start(); });
    std::signal(SIGTERM, [](int) { drogon::app().quit(); });
    std::signal(SIGINT, [](int) { drogon::app().quit(); });
    ALOG_INFO << "Acerciae TRPG backend listening on :" << cfg.httpPort << " (AI providers: per server)";
    drogon::app().run();
    Services::shutdown();
    curl_global_cleanup();
    return 0;
}
