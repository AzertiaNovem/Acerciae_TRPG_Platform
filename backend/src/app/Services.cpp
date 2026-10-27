#include "Services.h"
#include "../auth/AuthService.h"
#include "../events/EventStore.h"
#include "../chat/ChatService.h"
#include "../scenes/SceneManager.h"
#include "../scenes/ScenarioService.h"
#include "../reminders/ReminderService.h"
#include "../script/ScriptKnowledgeService.h"
#include "../knowledge/KnowledgeService.h"
#include "../documents/DocumentService.h"
#include "../highlights/HighlightService.h"
#include "../retrieval/ContextRetrievalService.h"
#include "../llm/LlmGateway.h"
#include "../observer/ObserverScheduler.h"
#include "../consistency/ConsistencyService.h"
#include "../inspiration/InspirationService.h"
#include "../modules/ModuleImporter.h"
#include "../ws/Notifier.h"
#include "../logstudio/LogStudioService.h"
#include "../logstudio/ObjectStore.h"
#include "../logstudio/MediaService.h"
#include "../logstudio/PresentationService.h"
#include "../logstudio/StyleService.h"
#include "../logstudio/TtsService.h"
#include "../logstudio/PublicationService.h"
#include "../logstudio/CreativeService.h"
#include "../logstudio/VnScriptService.h"
#include "../servers/ServerSettingsService.h"
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
    s.settings = std::make_unique<ServerSettingsService>(s.cfg, *s.db, *s.auth, *s.notifier);
    s.dice = std::make_unique<DiceService>(*s.db, *s.auth, *s.settings, *s.notifier);
    s.chat = std::make_unique<ChatService>(*s.db, *s.auth, *s.events, *s.scenes, *s.notifier, *s.documents, *s.dice);
    s.llm = std::make_unique<LlmGateway>(s.cfg);
    s.llm->setProfileResolver([&s](const std::string& channelId) { return s.settings->profileForChannel(channelId); });
    s.retrieval = std::make_unique<ContextRetrievalService>(*s.db, *s.knowledge, *s.events, *s.llm);
    s.consistency = std::make_unique<ConsistencyService>(s.cfg, *s.db, *s.retrieval, *s.llm, *s.highlights, *s.knowledge);
    s.inspiration = std::make_unique<InspirationService>(s.cfg, *s.db, *s.retrieval, *s.llm);
    s.modules = std::make_unique<ModuleImporter>(s.cfg, *s.db, *s.llm, *s.notifier);
    s.studio = std::make_unique<logstudio::LogStudioService>(s.cfg, *s.db, *s.notifier);
    s.objectStore = logstudio::makeObjectStore(s.cfg);
    s.media = std::make_unique<logstudio::MediaService>(s.cfg, *s.db, *s.objectStore);
    s.presentations = std::make_unique<logstudio::PresentationService>(s.cfg, *s.db, *s.notifier, *s.studio);
    s.styles = std::make_unique<logstudio::StyleService>(*s.db);
    s.tts = std::make_unique<logstudio::TtsService>(s.cfg, *s.db, *s.objectStore, *s.notifier, *s.presentations, *s.settings);
    s.publication = std::make_unique<logstudio::PublicationService>(*s.db,*s.objectStore,*s.notifier,*s.studio,*s.presentations,*s.media,*s.documents);
    s.creative = std::make_unique<logstudio::CreativeService>(*s.db,*s.media,*s.presentations,*s.studio,*s.llm,*s.notifier);
    s.vnScripts = std::make_unique<logstudio::VnScriptService>(*s.db,*s.auth,*s.studio,*s.presentations,*s.llm,*s.notifier);
    s.scenarios = std::make_unique<ScenarioService>(*s.db, *s.events, *s.scenes, *s.llm, *s.notifier);
    s.reminders = std::make_unique<ReminderService>(*s.db, *s.llm, *s.retrieval, *s.notifier);
    s.script = std::make_unique<ScriptKnowledgeService>(*s.db, *s.llm, *s.retrieval, *s.reminders, *s.notifier);
    s.modules->setPostProcess([&s](const std::string& channelId, const std::string& moduleId) { int calls = 0; s.script->buildFromModule(channelId, moduleId, calls); });
    s.observer = std::make_unique<ObserverScheduler>(s.cfg, *s.db, *s.events, *s.documents, *s.highlights, *s.retrieval, *s.llm, *s.notifier, *s.knowledge, *s.scenarios, *s.reminders, *s.script);
    return s;
}

void Services::shutdown() {
    if (!g_services) return;
    if (g_services->observer) g_services->observer->stop();
    if (g_services->creative) g_services->creative->stop();
    if (g_services->vnScripts) g_services->vnScripts->stop();
    if (g_services->tts) g_services->tts->stop();
    g_services.reset();
}

} // namespace acerciae
