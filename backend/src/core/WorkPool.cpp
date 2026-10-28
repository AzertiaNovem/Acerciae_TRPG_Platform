#include "WorkPool.h"
#include "Log.h"

namespace acerciae {

WorkPool::WorkPool(std::string name, int threads, std::size_t maxQueued) : name_(std::move(name)), maxQueued_(maxQueued) {
    for (int i = 0; i < std::max(1, threads); ++i) threads_.emplace_back([this] { loop(); });
}
WorkPool::~WorkPool() { stop(); }

bool WorkPool::submit(std::function<void()> task) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (stopping_ || queue_.size() >= maxQueued_) return false;
        queue_.push_back(std::move(task));
    }
    cv_.notify_one();
    return true;
}

std::size_t WorkPool::queued() { std::lock_guard<std::mutex> lk(mu_); return queue_.size(); }

void WorkPool::stop() {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (stopping_ && threads_.empty()) return;
        stopping_ = true;
    }
    cv_.notify_all();
    for (auto& t : threads_) if (t.joinable()) t.join();
    threads_.clear();
}

void WorkPool::loop() {
    for (;;) {
        std::function<void()> task;
        {
            std::unique_lock<std::mutex> lk(mu_);
            cv_.wait(lk, [&] { return stopping_ || !queue_.empty(); });
            if (queue_.empty()) return;   // stopping and drained
            task = std::move(queue_.front());
            queue_.pop_front();
        }
        try { task(); }
        catch (const std::exception& e) { ALOG_ERROR << name_ << " task failed: " << e.what(); }
        catch (...) { ALOG_ERROR << name_ << " task failed"; }
    }
}

} // namespace acerciae
