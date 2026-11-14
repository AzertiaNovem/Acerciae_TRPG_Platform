#pragma once
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>

namespace acerciae {
struct Services;

// Housekeeping on one background thread:
// - every minute, sockets are re-checked: a socket whose login session ended is closed, and a subscription to a
//   channel its user may no longer follow is dropped (removals and logouts also act immediately; this catches
//   expiry and anything missed); interactive-message actions abandoned mid-way (their claim lapsed over 2 minutes
//   ago) are finished with the lines they already posted;
// - every hour, old rows are swept: expired sessions, finished background AI jobs and studio audit rows past their
//   retention, spent or revoked server invites, and the action rows of interactive messages closed over a day ago.
class Maintenance {
public:
    explicit Maintenance(Services& s) : s_(s) {}
    ~Maintenance() { stop(); }
    void start();
    void stop();
    void revalidateSockets();
    void sweep();
private:
    void loop();
    Services& s_;
    std::atomic<bool> running_{false};
    std::thread thread_;
    std::mutex mu_;
    std::condition_variable cv_;
};

} // namespace acerciae
