#pragma once
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace acerciae {

// A fixed set of threads with a bounded queue. Used for work that must not hold Drogon's network threads (model
// calls triggered by a request) and for background tasks that used to run on detached threads (summaries, module
// imports), so that shutdown can stop accepting work and wait for what is running instead of leaving it behind.
class WorkPool {
public:
    WorkPool(std::string name, int threads, std::size_t maxQueued);
    ~WorkPool();
    WorkPool(const WorkPool&) = delete;
    WorkPool& operator=(const WorkPool&) = delete;
    // False when the queue is full or the pool is stopping; the task is not run.
    bool submit(std::function<void()> task);
    // Stops accepting work, lets queued and running tasks finish, joins the threads. Idempotent.
    void stop();
    std::size_t queued();
private:
    void loop();
    std::string name_;
    std::size_t maxQueued_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<std::function<void()>> queue_;
    std::vector<std::thread> threads_;
    bool stopping_ = false;
};

} // namespace acerciae
