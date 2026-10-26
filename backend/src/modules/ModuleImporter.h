#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <string>
#include <vector>

namespace acerciae {
class LlmGateway; class Notifier;

// PDF → page text (poppler) → LLM structuring (chunked) → conditional knowledge graph with citations.
class ModuleImporter {
public:
    ModuleImporter(const Config& cfg, Db& db, LlmGateway& llm, Notifier& n) : cfg_(cfg), db_(db), llm_(llm), notifier_(n) {}

    // Creates the module row and runs extraction + structuring synchronously (caller may run on a thread).
    Json::Value importPdf(const ChannelAccess& a, const std::string& fileName, const std::string& bytes, const std::string& title);
    Json::Value importText(const ChannelAccess& a, const std::string& title, const std::vector<std::string>& pages);
    void process(const std::string& moduleId);          // extracting → structuring → ready

    Json::Value list(const ChannelAccess& a);
    Json::Value get(const ChannelAccess& a, const std::string& moduleId);
    Json::Value page(const ChannelAccess& a, const std::string& moduleId, int pageNumber);
    Json::Value updateNode(const ChannelAccess& a, const std::string& nodeId, const Json::Value& body);
    Json::Value listHints(const ChannelAccess& a, const std::string& status);
    Json::Value decideHint(const ChannelAccess& a, const std::string& hintId, const std::string& decision);
    Json::Value gmWorkspace(const ChannelAccess& a);

    static std::vector<std::string> extractPdfText(const std::string& bytes);   // one string per page
    static Json::Value structureSchema();
private:
    void structurePages(const std::string& moduleId, const std::string& channelId, const Json::Value& pages);
    const Config& cfg_; Db& db_; LlmGateway& llm_; Notifier& notifier_;
};
}
