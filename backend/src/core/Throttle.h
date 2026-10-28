#pragma once
#include <chrono>
#include <deque>
#include <mutex>
#include <string>
#include <unordered_map>

namespace acerciae {

// Counts attempts per key in a sliding window: once `limit` attempts fall inside `window`, the key waits until the
// oldest of them leaves the window. In memory, per process; enough to stop password guessing against one backend.
class Throttle {
public:
    Throttle(int limit, std::chrono::seconds window) : limit_(limit), window_(window) {}
    // Seconds until the key may try again; 0 when it may try now.
    int retryAfter(const std::string& key) {
        std::lock_guard<std::mutex> lk(mu_);
        auto it = hits_.find(key);
        if (it == hits_.end()) return 0;
        prune(it->second);
        if ((int)it->second.size() < limit_) return 0;
        auto wait = std::chrono::duration_cast<std::chrono::seconds>(it->second.front() + window_ - Clock::now()).count();
        return (int)std::max<long long>(1, wait);
    }
    void hit(const std::string& key) {
        std::lock_guard<std::mutex> lk(mu_);
        if (hits_.size() > 100000) hits_.clear();   // bound memory under a flood of distinct keys
        auto& q = hits_[key];
        prune(q);
        q.push_back(Clock::now());
    }
    void clear(const std::string& key) { std::lock_guard<std::mutex> lk(mu_); hits_.erase(key); }
private:
    using Clock = std::chrono::steady_clock;
    void prune(std::deque<Clock::time_point>& q) { auto cutoff = Clock::now() - window_; while (!q.empty() && q.front() < cutoff) q.pop_front(); }
    int limit_;
    std::chrono::seconds window_;
    std::mutex mu_;
    std::unordered_map<std::string, std::deque<Clock::time_point>> hits_;
};

} // namespace acerciae
