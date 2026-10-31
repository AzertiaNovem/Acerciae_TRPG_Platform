#include "Maintenance.h"
#include "Services.h"
#include "../auth/AuthService.h"
#include "../chat/ChatService.h"
#include "../logstudio/PublicationService.h"
#include "../ws/WsGateway.h"
#include "../core/Log.h"
#include <chrono>

namespace acerciae {

void Maintenance::start() {
    if (running_.exchange(true)) return;
    thread_ = std::thread([this] { loop(); });
}
void Maintenance::stop() {
    if (!running_.exchange(false)) return;
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
}

void Maintenance::revalidateSockets() {
    auto& db = *s_.db;
    WsGateway::instance().revalidate(
        [&](const std::string& hash) {
            return !hash.empty() && !db.queryOne("SELECT 1 AS ok FROM auth_tokens WHERE token_hash=$1 AND expires_at > now()", {hash}).isNull();
        },
        [&](const std::string& userId, const std::string& key) {
            static const std::string spectate = WsGateway::spectateKey("");
            if (key.rfind(spectate, 0) == 0) return s_.chat->canSpectate(userId, key.substr(spectate.size()));
            return !db.queryOne("SELECT 1 AS ok FROM channel_members WHERE channel_id=$1 AND user_id=$2", {key, userId}).isNull();
        });
}

void Maintenance::sweep() {
    auto& db = *s_.db;
    db.exec("DELETE FROM auth_tokens WHERE expires_at < now() - interval '1 day'");
    db.exec("DELETE FROM ai_jobs WHERE finished_at IS NOT NULL AND finished_at < now() - make_interval(days => $1)", {(int64_t)std::max(1, s_.cfg.retentionAiJobDays)});
    db.exec("DELETE FROM studio_audit_log WHERE created_at < now() - make_interval(days => $1)", {(int64_t)std::max(30, s_.cfg.retentionAuditDays)});
    db.exec("DELETE FROM server_invites WHERE created_at < now() - interval '30 days' AND (revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at < now()) OR (max_uses > 0 AND uses >= max_uses))");
}

void Maintenance::loop() {
    auto nextSweep = std::chrono::steady_clock::now() + std::chrono::minutes(1);
    while (running_) {
        {
            std::unique_lock<std::mutex> lk(mu_);
            cv_.wait_for(lk, std::chrono::seconds(60), [&] { return !running_; });
        }
        if (!running_) break;
        try { revalidateSockets(); } catch (const std::exception& e) { ALOG_WARN << "socket revalidation: " << e.what(); }
        // Expired visual-novel bundles leave storage within a minute.
        try { s_.publication->expireBundles(); } catch (const std::exception& e) { ALOG_WARN << "bundle expiry: " << e.what(); }
        if (std::chrono::steady_clock::now() >= nextSweep) {
            try { sweep(); } catch (const std::exception& e) { ALOG_WARN << "retention sweep: " << e.what(); }
            nextSweep = std::chrono::steady_clock::now() + std::chrono::hours(1);
        }
    }
}

} // namespace acerciae
