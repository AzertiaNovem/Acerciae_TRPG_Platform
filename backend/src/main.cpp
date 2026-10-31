#include "modules/ModuleImporter.h"
#include "script/ScriptKnowledgeService.h"
#include "app/Services.h"
#include "logstudio/ObjectStore.h"
#include "logstudio/MediaMigrator.h"
#include "api/Api.h"
#include "ws/WsGateway.h"
#include "observer/ObserverScheduler.h"
#include "llm/LlmGateway.h"
#include "logstudio/TtsService.h"
#include "logstudio/CreativeService.h"
#include "logstudio/VnScriptService.h"
#include "seed/DemoSeed.h"
#include "app/Maintenance.h"
#include "logstudio/StorageCleanup.h"
#include "core/Log.h"
#include <drogon/drogon.h>
#include <curl/curl.h>
#include <csignal>
#include <iostream>
#include <cstdlib>

using namespace acerciae;

int main(int argc, char** argv) {
    bool seedOnly = false, migrateOnly = false, noSeed = false;
    std::string copyFrom, copyTo; bool copyAll = false, migrateMedia = false, cleanStorage = false, dryRun = false;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--seed-demo") seedOnly = true;
        else if (a == "--migrate-only") migrateOnly = true;
        else if (a == "--no-seed") noSeed = true;
        else if (a == "--copy-images" || a == "--copy-media") {
            if (i + 2 >= argc) { std::cerr << a << " needs FROM and TO (local, s3, r2 or r2public)\n"; return 2; }
            copyAll = a == "--copy-media"; copyFrom = argv[++i]; copyTo = argv[++i];
        }
        else if (a == "--migrate-media") migrateMedia = true;
        else if (a == "--clean-storage") cleanStorage = true;
        else if (a == "--dry-run") dryRun = true;
        else if (a == "--help") { std::cout << "acerciae-server [--migrate-only] [--seed-demo] [--no-seed] [--migrate-media] [--clean-storage [--dry-run]] [--copy-images FROM TO] [--copy-media FROM TO]\n"
                                               "  --migrate-media          run the media migration now (also runs in the background at every start)\n"
                                               "  --clean-storage          delete stored media nothing uses any more (also runs at every start and daily);\n"
                                               "                           with --dry-run, only count what would go\n"
                                               "  --copy-images local r2   copy stored images to Cloudflare R2 (or r2 local to bring them back; also s3)\n"
                                               "  --copy-media r2public local   copy every stored object, e.g. out of the public bucket before turning it off\n"; return 0; }
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
    Services* built = nullptr;
    // Construction validates configuration that needs no database (e.g. the object/image store settings).
    try { built = &Services::build(cfg); }
    catch (const std::exception& e) { std::cerr << "refusing to start: " << e.what() << "\n"; Services::shutdown(); curl_global_cleanup(); return 1; }
    auto& S = *built;
    try { S.db->runMigrations(cfg.migrationsDir); }
    catch (const std::exception& e) { std::cerr << "migration failed: " << e.what() << "\n"; Services::shutdown(); curl_global_cleanup(); return 1; }
    if (migrateOnly) { Services::shutdown(); curl_global_cleanup(); return 0; }
    if (!copyFrom.empty()) {
        // Copies every stored image (all versions of image assets and avatars) — or, with --copy-media, every stored
        // object — that the destination does not have yet. Keys are kept, so reads find the copies by fallback.
        int rc = 0;
        try {
            auto from = logstudio::makeBackend(copyFrom, cfg), to = logstudio::makeBackend(copyTo, cfg);
            std::vector<std::pair<std::string, std::string>> keys;
            for (auto& r : S.db->queryJson("SELECT object_key AS k, mime FROM asset_versions UNION SELECT object_key, mime FROM media_assets "
                                           "UNION SELECT avatar_key, coalesce(avatar_mime,'image/png') FROM users WHERE avatar_key IS NOT NULL "
                                           "UNION SELECT object_key, mime FROM tts_audio_assets UNION SELECT object_key, 'application/pdf' FROM pdf_render_jobs WHERE object_key IS NOT NULL "
                                           "UNION SELECT raw_object_key, 'application/octet-stream' FROM log_imports WHERE raw_object_key IS NOT NULL"))
                if (!r["k"].asString().empty() && (copyAll || logstudio::isImageObject(r["k"].asString(), r["mime"].asString()))) keys.emplace_back(r["k"].asString(), r["mime"].asString());
            auto rep = logstudio::copyObjects(*from, *to, keys);
            std::cout << (copyAll ? "objects: " : "images: ") << keys.size() << " known, " << rep.copied << " copied " << copyFrom << " -> " << copyTo << ", " << rep.alreadyPresent
                      << " already there, " << rep.missingAtSource << " missing at the source, " << rep.failed << " failed\n";
            rc = rep.failed ? 1 : 0;
        } catch (const std::exception& e) { std::cerr << "copy failed: " << e.what() << "\n"; rc = 1; }
        Services::shutdown(); curl_global_cleanup(); return rc;
    }
    if (migrateMedia) {
        auto rep = S.mediaMigrator->runOnce();
        std::cout << "media migration: " << logstudio::MediaMigrator::describe(rep) << "\n";
        Services::shutdown(); curl_global_cleanup(); return rep.failed ? 1 : 0;
    }
    if (cleanStorage) {
        auto rep = S.storageCleanup->runOnce(dryRun);
        std::cout << "storage cleanup: " << logstudio::StorageCleanup::describe(rep, dryRun) << "\n";
        Services::shutdown(); curl_global_cleanup(); return rep.failed ? 1 : 0;
    }
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
    drogon::app().registerBeginningAdvice([&] { S.observer->start(); S.tts->start(); S.creative->start(); S.vnScripts->start(); S.maintenance->start();
        // Sends local media to object storage (and non-secret media to the public bucket) whenever that is configured.
        if (const char* m = std::getenv("MEDIA_MIGRATION"); !m || (std::string(m) != "false" && std::string(m) != "0")) S.mediaMigrator->start();
        // Deletes stored media nothing uses any more, now and once a day.
        if (const char* c = std::getenv("STORAGE_CLEANUP"); !c || (std::string(c) != "false" && std::string(c) != "0")) S.storageCleanup->start(); });
    std::signal(SIGTERM, [](int) { drogon::app().quit(); });
    std::signal(SIGINT, [](int) { drogon::app().quit(); });
    ALOG_INFO << "Acerciae TRPG backend listening on :" << cfg.httpPort << " (AI providers: per server)";
    drogon::app().run();
    Services::shutdown();
    curl_global_cleanup();
    return 0;
}
