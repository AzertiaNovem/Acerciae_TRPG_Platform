#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include <memory>

namespace acerciae {

class AuthService; class EventStore; class ChatService; class SceneManager; class KnowledgeService;
class DocumentService; class HighlightService; class ContextRetrievalService; class LlmGateway;
class ScenarioService; class ReminderService; class ObserverScheduler; class ConsistencyService; class InspirationService; class ModuleImporter;
class Notifier;
namespace logstudio { class LogStudioService; class ObjectStore; class MediaService; class PresentationService; class StyleService; class TtsService; class PublicationService; class CreativeService; class VnScriptService; }
class ServerSettingsService; class DiceService;

// Composition root: every module gets its dependencies through here (constructed once in main).
struct Services {
    Config cfg;
    std::unique_ptr<Db> db;
    std::unique_ptr<AuthService> auth;
    std::unique_ptr<EventStore> events;
    std::unique_ptr<Notifier> notifier;
    std::unique_ptr<SceneManager> scenes;
    std::unique_ptr<ScenarioService> scenarios;
    std::unique_ptr<ReminderService> reminders;
    std::unique_ptr<KnowledgeService> knowledge;
    std::unique_ptr<DocumentService> documents;
    std::unique_ptr<HighlightService> highlights;
    std::unique_ptr<ServerSettingsService> settings;
    std::unique_ptr<DiceService> dice;
    std::unique_ptr<ChatService> chat;
    std::unique_ptr<ContextRetrievalService> retrieval;
    std::unique_ptr<LlmGateway> llm;
    std::unique_ptr<ConsistencyService> consistency;
    std::unique_ptr<InspirationService> inspiration;
    std::unique_ptr<ModuleImporter> modules;
    std::unique_ptr<ObserverScheduler> observer;
    std::unique_ptr<logstudio::LogStudioService> studio;
    std::unique_ptr<logstudio::ObjectStore> objectStore;
    std::unique_ptr<logstudio::MediaService> media;
    std::unique_ptr<logstudio::PresentationService> presentations;
    std::unique_ptr<logstudio::StyleService> styles;
    std::unique_ptr<logstudio::TtsService> tts;
    std::unique_ptr<logstudio::PublicationService> publication;
    std::unique_ptr<logstudio::CreativeService> creative;
    std::unique_ptr<logstudio::VnScriptService> vnScripts;

    static Services& build(const Config& cfg);   // constructs the singleton
    static void shutdown();
};

Services& services();

} // namespace acerciae
