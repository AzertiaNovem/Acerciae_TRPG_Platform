#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <string>
#include <vector>
#include <functional>

namespace acerciae {
class LlmGateway; class Notifier;

// PDF → page text (poppler) → LLM structuring (chunked) → conditional knowledge graph with citations.
class ModuleImporter {
public:
    ModuleImporter(const Config& cfg, Db& db, LlmGateway& llm, Notifier& n) : cfg_(cfg), db_(db), llm_(llm), notifier_(n) {}

    // Content-addressed within the channel. PDF is queued; text supports opt-in async for newer clients.
    Json::Value importPdf(const ChannelAccess& a, const std::string& fileName, const std::string& bytes, const std::string& title);
    Json::Value importText(const ChannelAccess& a, const std::string& title, const std::vector<std::string>& pages, bool async = false);
    Json::Value retry(const ChannelAccess& a, const std::string& moduleId);
    void recoverInterrupted();
    void process(const std::string& moduleId);          // extracting → structuring → ready
    // Runs after structuring succeeds (the script knowledge build); failures there never fail the import.
    void setPostProcess(std::function<void(const std::string& channelId, const std::string& moduleId)> f) { postProcess_ = std::move(f); }
    // Where imports run: a bounded pool that shutdown waits for (false = queue full).
    void setExecutor(std::function<bool(std::function<void()>)> f) { executor_ = std::move(f); }

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
    void enqueue(const std::string& id);
    void progress(const std::string& id, const std::string& stage, int completed = 0, int total = 0);
    void structurePages(const std::string& moduleId, const std::string& channelId, const Json::Value& pages);
    const Config& cfg_; Db& db_; LlmGateway& llm_; Notifier& notifier_;
    std::function<void(const std::string&, const std::string&)> postProcess_;
    std::function<bool(std::function<void()>)> executor_;
};
}
