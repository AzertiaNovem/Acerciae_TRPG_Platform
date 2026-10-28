#pragma once
#include "../core/Db.h"
#include "../llm/Llm.h"
#include <json/json.h>
#include <condition_variable>
#include <map>
#include <mutex>
#include <string>

namespace acerciae {

// A server's AI policy, set by its maintainers: a token budget for the whole server (per calendar month, or in
// total since the last reset), an image budget for the same period, and how many AI calls (model requests, image
// generations, speech syntheses) the server may run at the same time. Mock providers cost nothing and are not
// metered. Usage is recorded per call in ai_usage_records.
class AiPolicyService : public AiMeter {
public:
    explicit AiPolicyService(Db& db) : db_(db) {}

    std::string serverOf(const std::string& channelId);   // "" when the channel does not exist

    // AiMeter (LLM gateway)
    void checkTokens(const std::string& channelId) override;
    std::shared_ptr<void> acquire(const std::string& channelId) override;
    void recordTokens(const std::string& channelId, const std::string& task, int promptTokens, int completionTokens) override;

    // Images: 429 ai_budget_exhausted when the server's image budget for the period is spent.
    void checkImages(const std::string& channelId);
    void recordImage(const std::string& channelId, const std::string& task);

    // {token_budget, image_budget, period, max_concurrent, period_start, tokens_used, images_used, running}
    Json::Value usage(const std::string& serverId);
    void resetUsage(const std::string& serverId);

    void setSlotWaitSeconds(int s) { slotWaitSeconds_ = s; }   // tests
private:
    int slotWaitSeconds_ = 120;
    struct Totals { long long tokens = 0; long long images = 0; long long tokenBudget = 0; long long imageBudget = 0; };
    Totals totals(const std::string& serverId);
    int maxConcurrent(const std::string& serverId);
    Db& db_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::map<std::string, int> running_;              // server id -> AI calls in flight
    std::map<std::string, std::string> serverCache_;  // channel id -> server id (a channel never moves)
};

} // namespace acerciae
