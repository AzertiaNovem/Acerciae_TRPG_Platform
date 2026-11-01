#include "../atmosphere/AtmosphereService.h"
#include "Services.h"
#include <cstdlib>
#include "Maintenance.h"
#include "../auth/AuthService.h"
#include "../events/EventStore.h"
#include "../chat/ChatService.h"
#include "../scenes/SceneManager.h"
#include "../scenes/ScenarioService.h"
#include "../reminders/ReminderService.h"
#include "../script/ScriptKnowledgeService.h"
#include "../characters/CharacterSpaceService.h"
#include "../knowledge/KnowledgeService.h"
#include "../documents/DocumentService.h"
#include "../highlights/HighlightService.h"
#include "../retrieval/ContextRetrievalService.h"
#include "../llm/LlmGateway.h"
#include "../llm/HttpTransport.h"
#include "../observer/ObserverScheduler.h"
#include "../consistency/ConsistencyService.h"
#include "../inspiration/InspirationService.h"
#include "../modules/ModuleImporter.h"
#include "../ws/Notifier.h"
#include "../logstudio/LogStudioService.h"
#include "../logstudio/ObjectStore.h"
#include "../logstudio/MediaMigrator.h"
#include "../logstudio/StorageCleanup.h"
#include "../logstudio/MediaService.h"
#include "../logstudio/PresentationService.h"
#include "../logstudio/StyleService.h"
#include "../logstudio/TtsService.h"
#include "../logstudio/PublicationService.h"
#include "../logstudio/CreativeService.h"
#include "../logstudio/VnScriptService.h"
#include "../servers/ServerSettingsService.h"
#include "../servers/DeletionService.h"
#include "../characters/GrowthService.h"
#include "../servers/AiPolicyService.h"
#include "../core/WorkPool.h"
#include "../core/NetGuard.h"
#include "../dice/DiceService.h"

namespace acerciae {

static std::unique_ptr<Services> g_services;

Services& services() { return *g_services; }

Services& Services::build(const Config& cfg) {
    g_services = std::make_unique<Services>();
    auto& s = *g_services;
    s.cfg = cfg;
    s.db = std::make_unique<Db>(cfg.databaseUrl, (std::size_t)std::max(4, cfg.httpThreads * 2 + 4));
    s.auth = std::make_unique<AuthService>(*s.db, s.cfg);
    s.events = std::make_unique<EventStore>(*s.db);
    s.notifier = std::make_unique<Notifier>(*s.db);
    s.scenes = std::make_unique<SceneManager>(*s.db, *s.events, *s.notifier);
    s.knowledge = std::make_unique<KnowledgeService>(*s.db);
    s.documents = std::make_unique<DocumentService>(*s.db, *s.knowledge, *s.notifier);
    s.highlights = std::make_unique<HighlightService>(*s.db, *s.notifier, cfg.highlightTtlSeconds);
    net::setAllowPrivate(cfg.aiAllowPrivateEndpoints);
    s.aiPolicy = std::make_unique<AiPolicyService>(*s.db);
    s.settings = std::make_unique<ServerSettingsService>(s.cfg, *s.db, *s.auth, *s.aiPolicy, *s.notifier);
    s.dice = std::make_unique<DiceService>(*s.db, *s.auth, *s.settings, *s.notifier);
    s.chat = std::make_unique<ChatService>(*s.db, *s.auth, *s.events, *s.scenes, *s.notifier, *s.documents, *s.dice);
    s.llm = std::make_unique<LlmGateway>(s.cfg);
    s.llm->setProfileResolver([&s](const std::string& channelId) { return s.settings->profileForChannel(channelId); });
    s.llm->setMeter(s.aiPolicy.get());
    llm::configureTransport(cfg.llmMaxConnections, cfg.llmQueueLimit);
    s.apiRequests = std::make_unique<WorkPool>("api-requests", cfg.apiWorkers, cfg.apiQueueLimit);
    s.aiRequests = std::make_unique<WorkPool>("ai-requests", std::max(1, cfg.aiHttpWorkers), (std::size_t)std::max(8, cfg.aiHttpWorkers * 8));
    s.retrieval = std::make_unique<ContextRetrievalService>(*s.db, *s.knowledge, *s.events, *s.llm);
    s.consistency = std::make_unique<ConsistencyService>(s.cfg, *s.db, *s.retrieval, *s.llm, *s.highlights, *s.knowledge);
    s.inspiration = std::make_unique<InspirationService>(s.cfg, *s.db, *s.retrieval, *s.llm);
    s.modules = std::make_unique<ModuleImporter>(s.cfg, *s.db, *s.llm, *s.notifier);
    s.studio = std::make_unique<logstudio::LogStudioService>(s.cfg, *s.db, *s.notifier);
    s.objectStore = logstudio::makeObjectStore(s.cfg);
    s.auth->setObjectStore(s.objectStore.get());   // avatars are media objects
    { const char* d = std::getenv("MEDIA_MIGRATION_DELETE_LOCAL"); bool del = d && (std::string(d) == "true" || std::string(d) == "1");
      s.mediaMigrator = std::make_unique<logstudio::MediaMigrator>(*s.db, static_cast<logstudio::RoutingObjectStore&>(*s.objectStore), del); }
    s.media = std::make_unique<logstudio::MediaService>(s.cfg, *s.db, *s.objectStore);
    s.studio->setObjectStore(s.objectStore.get());   // public links in the native log export
    s.storageCleanup = std::make_unique<logstudio::StorageCleanup>(*s.db, static_cast<logstudio::RoutingObjectStore&>(*s.objectStore), *s.media);
    s.deletion = std::make_unique<DeletionService>(*s.db, *s.objectStore, *s.notifier);
    s.presentations = std::make_unique<logstudio::PresentationService>(s.cfg, *s.db, *s.notifier, *s.studio);
    s.styles = std::make_unique<logstudio::StyleService>(*s.db);
    s.tts = std::make_unique<logstudio::TtsService>(s.cfg, *s.db, *s.objectStore, *s.notifier, *s.presentations, *s.settings, *s.aiPolicy);
    s.publication = std::make_unique<logstudio::PublicationService>(*s.db,*s.objectStore,*s.notifier,*s.studio,*s.presentations,*s.media,*s.documents);
    s.creative = std::make_unique<logstudio::CreativeService>(*s.db,*s.media,*s.presentations,*s.studio,*s.llm,*s.notifier,*s.settings,*s.auth,*s.aiPolicy);
    s.vnScripts = std::make_unique<logstudio::VnScriptService>(*s.db,*s.auth,*s.studio,*s.presentations,*s.creative,*s.llm,*s.notifier);
    s.characterSpace = std::make_unique<CharacterSpaceService>(*s.db, *s.media, *s.creative, *s.settings, *s.notifier);
    s.scenarios = std::make_unique<ScenarioService>(*s.db, *s.events, *s.scenes, *s.llm, *s.notifier);
    s.growth = std::make_unique<GrowthService>(*s.db, *s.chat, *s.dice, *s.notifier);
    s.scenes->setClosedHook([&s](const std::string& ch, const std::string& scene, const std::string& actor) { s.growth->runForClosedScene(ch, scene, actor); });
    s.reminders = std::make_unique<ReminderService>(*s.db, *s.llm, *s.retrieval, *s.notifier);
    s.script = std::make_unique<ScriptKnowledgeService>(*s.db, *s.llm, *s.retrieval, *s.reminders, *s.notifier);
    s.modules->setPostProcess([&s](const std::string& channelId, const std::string& moduleId) { int calls = 0; s.script->buildFromModule(channelId, moduleId, calls); });
    s.atmosphere = std::make_unique<AtmosphereService>(*s.db,*s.llm,*s.settings,*s.media);
    s.observer = std::make_unique<ObserverScheduler>(s.cfg, *s.db, *s.events, *s.documents, *s.highlights, *s.retrieval, *s.llm, *s.notifier, *s.knowledge, *s.scenarios, *s.reminders, *s.script);
    s.observer->setAtmosphereHook([&s](const std::string& ch,const Json::Value& batch){s.atmosphere->afterBatch(ch,batch);});
    s.maintenance = std::make_unique<Maintenance>(s);
    // Background work that used to run on detached threads: bounded, and drained at shutdown.
    s.background = std::make_unique<WorkPool>("background", 2, 256);
    auto submit = [&s](std::function<void()> f) { return s.background->submit(std::move(f)); };
    s.modules->setExecutor(submit);
    s.script->setExecutor(submit);
    s.scenarios->setExecutor(submit);
    s.publication->setExecutor(submit);
    s.publication->setAccessResolver([&s](const std::string& user, const std::string& channel) { return s.auth->channelAccess(user, channel); });
    return s;
}

void Services::shutdown() {
    if (!g_services) return;
    if (g_services->mediaMigrator) g_services->mediaMigrator->stop();
    if (g_services->storageCleanup) g_services->storageCleanup->stop();
    if (g_services->maintenance) g_services->maintenance->stop();
    if (g_services->apiRequests) g_services->apiRequests->stop();
    if (g_services->aiRequests) g_services->aiRequests->stop();
    if (g_services->background) g_services->background->stop();
    if (g_services->observer) g_services->observer->stop();
    if (g_services->creative) g_services->creative->stop();
    if (g_services->vnScripts) g_services->vnScripts->stop();
    if (g_services->tts) g_services->tts->stop();
    llm::stopTransport();
    g_services.reset();
}

} // namespace acerciae
