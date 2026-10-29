#include "HttpTransport.h"
#include "../core/NetGuard.h"
#include <curl/curl.h>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>

namespace acerciae::llm {
namespace {
using Clock = std::chrono::steady_clock;
bool retryable(long status) { return status == 429 || status == 502 || status == 503 || status == 504 || status == 529; }
struct Transfer {
    std::unique_ptr<net::PinnedRequest> pinned;
    std::string body;
    curl_slist* headers = nullptr;
    net::CappedBody received;
    std::promise<HttpResult> result;
    Clock::time_point deadline, readyAt = Clock::now();
    int attempt = 0, retryAfter = -1;
    ~Transfer() { curl_slist_free_all(headers); }
};
std::size_t headerCb(char* buffer, std::size_t size, std::size_t nitems, void* userdata) {
    std::string line(buffer, size * nitems);
    auto* transfer = static_cast<Transfer*>(userdata);
    std::string prefix = line.substr(0, 12);
    std::transform(prefix.begin(), prefix.end(), prefix.begin(), [](unsigned char c) { return std::tolower(c); });
    if (prefix == "retry-after:") {
        try { transfer->retryAfter = std::clamp(std::stoi(line.substr(12)), 0, 20); } catch (...) {}
    }
    return size * nitems;
}

// One reactor multiplexes all model sockets. No transfer or retry sleeps on this thread.
// Callers may wait on futures only in AI/background workers, never in a Drogon loop.
class Transport {
public:
    Transport(std::size_t concurrent, std::size_t queued) : capacity_(concurrent), limit_(concurrent + queued) {
        multi_ = curl_multi_init();
        if (!multi_) throw std::runtime_error("AI HTTP client unavailable");
        curl_multi_setopt(multi_, CURLMOPT_MAX_TOTAL_CONNECTIONS, static_cast<long>(capacity_));
        curl_multi_setopt(multi_, CURLMOPT_MAXCONNECTS, static_cast<long>(capacity_));
        thread_ = std::thread([this] { loop(); });
    }
    ~Transport() { stop(); }
    std::future<HttpResult> submit(std::unique_ptr<Transfer> t) {
        auto future = t->result.get_future();
        std::lock_guard lock(mu_);
        if (stopping_ || outstanding_ >= limit_) {
            t->result.set_value({0, {}, stopping_ ? "AI HTTP client is stopping" : "AI HTTP queue is full; try again shortly"});
        } else {
            ++outstanding_;
            incoming_.push_back(std::move(t));
            curl_multi_wakeup(multi_);
        }
        return future;
    }
    void stop() {
        std::lock_guard stopLock(stopMu_);
        { std::lock_guard lock(mu_); stopping_ = true; if (multi_) curl_multi_wakeup(multi_); }
        if (thread_.joinable()) thread_.join();
        if (multi_) { curl_multi_cleanup(multi_); multi_ = nullptr; }
    }
private:
    void finish(std::unique_ptr<Transfer> t, HttpResult result) {
        { std::lock_guard lock(mu_); --outstanding_; }
        t->result.set_value(std::move(result));
    }
    void start(std::unique_ptr<Transfer> t) {
        auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(t->deadline - Clock::now()).count();
        if (remaining <= 0) { finish(std::move(t), {0, {}, "the AI request deadline was exceeded"}); return; }
        CURL* c = curl_easy_init();
        if (!c) { finish(std::move(t), {0, {}, "AI HTTP client unavailable"}); return; }
        t->received.data.clear(); t->retryAfter = -1; ++t->attempt;
        t->pinned->apply(c, t->received.limit);
        curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(c, CURLOPT_HTTPHEADER, t->headers);
        curl_easy_setopt(c, CURLOPT_POSTFIELDS, t->body.c_str());
        curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(t->body.size()));
        curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, net::cappedWrite);
        curl_easy_setopt(c, CURLOPT_WRITEDATA, &t->received);
        curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, headerCb);
        curl_easy_setopt(c, CURLOPT_HEADERDATA, t.get());
        curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, static_cast<long>(remaining));
        curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, static_cast<long>(std::min<int64_t>(10000, remaining)));
        // The overall deadline also bounds silent first-token/reasoning waits. Do not impose
        // a shorter low-speed timeout that would kill otherwise healthy long reasoning calls.
        auto rc = curl_multi_add_handle(multi_, c);
        if (rc != CURLM_OK) {
            curl_easy_cleanup(c);
            finish(std::move(t), {0, {}, "could not schedule the AI HTTP request"});
        } else active_.emplace(c, std::move(t));
    }
    void completed(CURL* c, CURLcode rc) {
        auto found = active_.find(c);
        if (found == active_.end()) return;
        auto t = std::move(found->second); active_.erase(found);
        HttpResult out;
        curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &out.status);
        curl_multi_remove_handle(multi_, c); curl_easy_cleanup(c);
        out.body = std::move(t->received.data);
        bool retry = false;
        if (rc == CURLE_WRITE_ERROR || rc == CURLE_FILESIZE_EXCEEDED) out.error = "the AI provider response exceeded the size limit";
        else if (rc != CURLE_OK) {
            out.error = std::string("could not reach the AI provider: ") + curl_easy_strerror(rc);
            retry = rc == CURLE_COULDNT_CONNECT || rc == CURLE_GOT_NOTHING || rc == CURLE_RECV_ERROR;
        } else retry = retryable(out.status);
        if (retry && t->attempt < 3 && Clock::now() < t->deadline) {
            int seconds = rc != CURLE_OK ? t->attempt : t->retryAfter >= 0 ? t->retryAfter : 1 << t->attempt;
            t->readyAt = Clock::now() + std::chrono::seconds(seconds);
            waiting_.push_back(std::move(t));
        } else finish(std::move(t), std::move(out));
    }
    void cancelAll(const char* error) {
        for (auto& [c, t] : active_) {
            curl_multi_remove_handle(multi_, c); curl_easy_cleanup(c);
            finish(std::move(t), {0, {}, error});
        }
        active_.clear();
        for (auto& t : waiting_) finish(std::move(t), {0, {}, error});
        waiting_.clear();
    }
    void loop() {
        for (;;) {
            bool stopping;
            {
                std::lock_guard lock(mu_);
                stopping = stopping_;
                while (!incoming_.empty()) { waiting_.push_back(std::move(incoming_.front())); incoming_.pop_front(); }
            }
            if (stopping) { cancelAll("AI HTTP client is stopping"); return; }
            for (auto it = waiting_.begin(); it != waiting_.end();) {
                if ((*it)->deadline <= Clock::now()) {
                    auto t = std::move(*it); it = waiting_.erase(it);
                    finish(std::move(t), {0, {}, "the AI request deadline was exceeded"});
                } else if (active_.size() < capacity_ && (*it)->readyAt <= Clock::now()) {
                    auto t = std::move(*it); it = waiting_.erase(it); start(std::move(t));
                } else ++it;
            }
            int running = 0;
            auto rc = curl_multi_perform(multi_, &running);
            if (rc != CURLM_OK) cancelAll("AI HTTP event loop failed");
            int left = 0;
            while (auto* message = curl_multi_info_read(multi_, &left))
                if (message->msg == CURLMSG_DONE) completed(message->easy_handle, message->data.result);
            // Wake immediately on submission/shutdown; bounded polling also expires queued deadlines.
            curl_multi_poll(multi_, nullptr, 0, 50, nullptr);
        }
    }
    CURLM* multi_ = nullptr;
    std::size_t capacity_, limit_, outstanding_ = 0;
    std::mutex mu_, stopMu_;
    bool stopping_ = false;
    std::thread thread_;
    std::deque<std::unique_ptr<Transfer>> incoming_, waiting_;
    std::unordered_map<CURL*, std::unique_ptr<Transfer>> active_;
};
std::mutex transportMu;
std::shared_ptr<Transport> transport;
std::shared_ptr<Transport> getTransport() {
    std::lock_guard lock(transportMu);
    if (!transport) transport = std::make_shared<Transport>(32, 128);
    return transport;
}
} // namespace

void configureTransport(std::size_t concurrent, std::size_t queued) {
    if (!concurrent || concurrent > 256 || queued > 4096) throw std::invalid_argument("invalid AI HTTP transport limits");
    std::lock_guard lock(transportMu);
    if (transport) transport->stop();
    transport = std::make_shared<Transport>(concurrent, queued);
}
void stopTransport() { getTransport()->stop(); }

std::future<HttpResult> postJsonAsync(const std::string& url, const std::vector<std::string>& headers, const std::string& body, long timeoutMs, std::size_t maxResponseBytes) {
    auto t = std::make_unique<Transfer>();
    t->deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
    t->body = body; t->received.limit = maxResponseBytes;
    // DNS validation/pinning stays on the submitting AI worker, outside both network loops.
    try { t->pinned = std::make_unique<net::PinnedRequest>(url); }
    catch (const std::exception& e) { auto f = t->result.get_future(); t->result.set_value({0, {}, e.what()}); return f; }
    for (const auto& line : headers) t->headers = curl_slist_append(t->headers, line.c_str());
    return getTransport()->submit(std::move(t));
}
HttpResult postJson(const std::string& url, const std::vector<std::string>& headers, const std::string& body, long timeoutMs, std::size_t maxResponseBytes) {
    return postJsonAsync(url, headers, body, timeoutMs, maxResponseBytes).get();
}
std::string excerpt(const std::string& body, std::size_t n) {
    std::string s = body.substr(0, n);
    for (auto& ch : s) if ((unsigned char)ch < 0x20) ch = ' ';
    return s;
}
} // namespace acerciae::llm
