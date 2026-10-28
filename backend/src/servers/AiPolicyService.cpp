#include "AiPolicyService.h"
#include "../core/Errors.h"
#include <chrono>

namespace acerciae {

namespace {
// Usage counts from the later of the period start (calendar month, UTC) and the maintainer's last reset.
const char* kSince =
    "GREATEST(CASE WHEN ss.ai_budget_period='month' THEN date_trunc('month', now()) ELSE '-infinity'::timestamptz END, "
    "COALESCE(ss.ai_usage_reset_at, '-infinity'::timestamptz))";
}

std::string AiPolicyService::serverOf(const std::string& channelId) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto it = serverCache_.find(channelId);
        if (it != serverCache_.end()) return it->second;
    }
    auto r = db_.queryOne("SELECT server_id FROM channels WHERE id=$1", {channelId});
    if (r.isNull()) return "";
    auto sid = r["server_id"].asString();
    std::lock_guard<std::mutex> lk(mu_);
    if (serverCache_.size() > 20000) serverCache_.clear();
    serverCache_[channelId] = sid;
    return sid;
}

AiPolicyService::Totals AiPolicyService::totals(const std::string& serverId) {
    auto r = db_.queryOne(std::string("SELECT ss.ai_token_budget AS token_budget, ss.ai_image_budget AS image_budget, "
        "(SELECT coalesce(sum(u.prompt_tokens + u.completion_tokens), 0) FROM ai_usage_records u WHERE u.server_id=ss.server_id AND u.created_at >= ") + kSince + ") AS tokens, "
        "(SELECT coalesce(sum(u.images), 0) FROM ai_usage_records u WHERE u.server_id=ss.server_id AND u.created_at >= " + kSince + ") AS images "
        "FROM server_settings ss WHERE ss.server_id=$1", {serverId});
    Totals t;
    if (r.isNull()) return t;
    t.tokens = r["tokens"].asInt64(); t.images = r["images"].asInt64();
    t.tokenBudget = r["token_budget"].asInt64(); t.imageBudget = r["image_budget"].asInt64();
    return t;
}

int AiPolicyService::maxConcurrent(const std::string& serverId) {
    auto r = db_.queryOne("SELECT ai_max_concurrent FROM server_settings WHERE server_id=$1", {serverId});
    return r.isNull() ? 4 : std::max(1, r["ai_max_concurrent"].asInt());
}

void AiPolicyService::checkTokens(const std::string& channelId) {
    auto sid = serverOf(channelId);
    if (sid.empty()) return;
    auto t = totals(sid);
    if (t.tokenBudget > 0 && t.tokens >= t.tokenBudget)
        throw ApiError(429, "ai_budget_exhausted", "This server's AI token budget is used up for this period. A server maintainer can raise it in Server settings → AI.");
}

void AiPolicyService::checkImages(const std::string& channelId) {
    auto sid = serverOf(channelId);
    if (sid.empty()) return;
    auto t = totals(sid);
    if (t.imageBudget > 0 && t.images >= t.imageBudget)
        throw ApiError(429, "ai_budget_exhausted", "This server's image budget is used up for this period. A server maintainer can raise it in Server settings → AI.");
}

std::shared_ptr<void> AiPolicyService::acquire(const std::string& channelId) {
    auto sid = serverOf(channelId);
    if (sid.empty()) return nullptr;
    int limit = maxConcurrent(sid);
    std::unique_lock<std::mutex> lk(mu_);
    if (!cv_.wait_for(lk, std::chrono::seconds(slotWaitSeconds_), [&] { return running_[sid] < limit; }))
        throw ApiError(503, "ai_busy", "This server is already running its maximum number of AI tasks; try again shortly.");
    running_[sid]++;
    return std::shared_ptr<void>(nullptr, [this, sid](void*) {
        std::lock_guard<std::mutex> g(mu_);
        if (--running_[sid] <= 0) running_.erase(sid);
        cv_.notify_all();
    });
}

void AiPolicyService::recordTokens(const std::string& channelId, const std::string& task, int promptTokens, int completionTokens) {
    auto sid = serverOf(channelId);
    if (sid.empty()) return;
    db_.exec("INSERT INTO ai_usage_records(server_id, channel_id, kind, task, prompt_tokens, completion_tokens) VALUES($1,$2,$3,$4,$5,$6)",
             {sid, channelId, task == "embedding" ? "embedding" : "llm", task.substr(0, 60), (int64_t)std::max(0, promptTokens), (int64_t)std::max(0, completionTokens)});
}

void AiPolicyService::recordImage(const std::string& channelId, const std::string& task) {
    auto sid = serverOf(channelId);
    if (sid.empty()) return;
    db_.exec("INSERT INTO ai_usage_records(server_id, channel_id, kind, task, images) VALUES($1,$2,'image',$3,1)", {sid, channelId, task.substr(0, 60)});
}

Json::Value AiPolicyService::usage(const std::string& serverId) {
    auto r = db_.queryOne(std::string("SELECT ss.ai_token_budget AS token_budget, ss.ai_image_budget AS image_budget, ss.ai_budget_period AS period, "
        "ss.ai_max_concurrent AS max_concurrent, ") + kSince + " AS period_start, "
        "(SELECT coalesce(sum(u.prompt_tokens + u.completion_tokens), 0) FROM ai_usage_records u WHERE u.server_id=ss.server_id AND u.created_at >= " + kSince + ") AS tokens_used, "
        "(SELECT coalesce(sum(u.images), 0) FROM ai_usage_records u WHERE u.server_id=ss.server_id AND u.created_at >= " + kSince + ") AS images_used "
        "FROM server_settings ss WHERE ss.server_id=$1", {serverId});
    if (r.isNull()) return Json::Value(Json::objectValue);
    if (r["period_start"].asString() == "-infinity") r["period_start"] = Json::Value();
    std::lock_guard<std::mutex> lk(mu_);
    auto it = running_.find(serverId);
    r["running"] = it == running_.end() ? 0 : it->second;
    return r;
}

void AiPolicyService::resetUsage(const std::string& serverId) {
    db_.exec("UPDATE server_settings SET ai_usage_reset_at=now() WHERE server_id=$1", {serverId});
}

} // namespace acerciae
