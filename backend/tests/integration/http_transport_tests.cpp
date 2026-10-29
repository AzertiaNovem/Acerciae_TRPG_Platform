#include "llm/HttpTransport.h"
#include "core/NetGuard.h"
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <atomic>
#include <chrono>
#include <future>
#include <iostream>
#include <thread>
#include <vector>

using namespace acerciae;
using namespace std::chrono_literals;
namespace {
int failures = 0;
void check(bool ok, const char* name) { if (!ok) { ++failures; std::cerr << "FAIL: " << name << '\n'; } }
class Fixture {
public:
    std::atomic<int> slowActive{0}, maxSlowActive{0}, retries{0}, hangs{0};
    Fixture() {
        fd_ = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (bind(fd_, reinterpret_cast<sockaddr*>(&address), sizeof address) || listen(fd_, 32)) throw std::runtime_error("fixture bind failed");
        socklen_t len = sizeof address; getsockname(fd_, reinterpret_cast<sockaddr*>(&address), &len);
        url = "http://127.0.0.1:" + std::to_string(ntohs(address.sin_port));
        thread_ = std::thread([this] {
            while (!stopping_) {
                int c = accept(fd_, nullptr, nullptr);
                if (c < 0) break;
                clients_.emplace_back([this, c] { serve(c); close(c); });
            }
        });
    }
    ~Fixture() {
        stopping_ = true; shutdown(fd_, SHUT_RDWR); close(fd_);
        thread_.join();
        for (auto& client : clients_) client.join();
    }
    std::string url;
private:
    void serve(int c) {
        timeval timeout{2, 0}; setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
        std::string req; char buf[2048];
        while (req.find("\r\n\r\n") == std::string::npos) { auto n = recv(c, buf, sizeof buf, 0); if (n <= 0) return; req.append(buf, n); }
        bool retry = req.find(" /retry ") != std::string::npos && retries.fetch_add(1) == 0;
        if (req.find(" /slow ") != std::string::npos) {
            int active = ++slowActive, peak = maxSlowActive;
            while (active > peak && !maxSlowActive.compare_exchange_weak(peak, active)) {}
            std::this_thread::sleep_for(300ms); --slowActive;
        }
        if (req.find(" /hang ") != std::string::npos) { ++hangs; std::this_thread::sleep_for(800ms); }
        std::string body = req.find(" /large ") != std::string::npos ? std::string(500, 'x') : "ok";
        std::string response = std::string("HTTP/1.1 ") + (retry ? "503 Busy\r\nRetry-After: 1" : "200 OK") +
            "\r\nConnection: close\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body;
#ifdef SO_NOSIGPIPE
        int yes = 1; setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof yes);
        send(c, response.data(), response.size(), 0);
#else
        send(c, response.data(), response.size(), MSG_NOSIGNAL);
#endif
    }
    int fd_;
    std::atomic<bool> stopping_{false};
    std::thread thread_;
    std::vector<std::thread> clients_;
};
}
int main() {
    curl_global_init(CURL_GLOBAL_DEFAULT);
    net::setAllowPrivate(true);
    {
        Fixture fixture;
        auto post = [&](const char* path, long timeout = 3000, std::size_t cap = 1024) {
            return llm::postJsonAsync(fixture.url + path, {"Content-Type: application/json"}, "{}", timeout, cap);
        };
        llm::configureTransport(2, 2);
        auto a = post("/slow"), b = post("/slow"), queued = post("/slow", 60), d = post("/slow");
        auto overload = post("/slow");
        check(overload.get().error.find("queue is full") != std::string::npos, "bounded queue rejects excess work");
        check(queued.wait_for(250ms) == std::future_status::ready, "queued deadline expires without waiting for active sockets");
        check(queued.get().error.find("deadline") != std::string::npos, "queue time counts toward request deadline");
        check(a.get().status == 200 && b.get().status == 200 && d.get().status == 200, "concurrent requests complete");
        check(fixture.maxSlowActive == 2, "one IO reactor multiplexes exactly the configured concurrent transfers");
        llm::configureTransport(1, 4);
        auto retry = post("/retry");
        for (int n = 0; n < 100 && !fixture.retries; ++n) std::this_thread::sleep_for(5ms);
        auto fast = post("/fast");
        check(fast.wait_for(500ms) == std::future_status::ready && fast.get().status == 200, "retry backoff releases connection slot and does not block IO");
        check(retry.get().status == 200 && fixture.retries == 2, "timer retries transient failure");
        check(post("/large", 1000, 32).get().error.find("size limit") != std::string::npos, "response cap enforced");
        check(!post("/hang", 80).get().error.empty(), "silent upstream times out");
        auto active = post("/hang");
        for (int n = 0; n < 100 && fixture.hangs < 2; ++n) std::this_thread::sleep_for(5ms);
        auto pending = post("/fast");
        llm::stopTransport();
        check(active.get().error.find("stopping") != std::string::npos && pending.get().error.find("stopping") != std::string::npos, "shutdown resolves active and queued futures");
        check(post("/fast").get().error.find("stopping") != std::string::npos, "stopped transport rejects new work");
    }
    curl_global_cleanup();
    std::cout << "transport tests: " << failures << " failures\n";
    return failures ? 1 : 0;
}
