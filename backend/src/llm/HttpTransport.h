#pragma once
#include <string>
#include <future>
#include <memory>
#include <vector>

namespace acerciae::llm {

struct HttpResult {
    long status = 0;
    std::string body;
    std::string error;   // transport or guard failure, safe to show to users
};

// Configure once at startup; stop after producers stop, before curl_global_cleanup.
// Socket IO and retry timers share a dedicated nonblocking curl-multi reactor.
void configureTransport(std::size_t concurrent, std::size_t queued);
void stopTransport();
// DNS pinning runs on the submitting AI worker. The returned future completes on success,
// deadline (including queue/retries), overload or shutdown. Never wait for it on a network loop.
std::future<HttpResult> postJsonAsync(const std::string& url, const std::vector<std::string>& headers,
                                    const std::string& body, long timeoutMs,
                                    std::size_t maxResponseBytes = 16u * 1024 * 1024);

// POSTs JSON to a maintainer-configured AI endpoint through the endpoint guard (pinned public resolution, no
// redirects, response size cap). 429, 502, 503, 504 and 529 are retried up to twice, honouring Retry-After up to
// 20 seconds, inside a single overall deadline (not a fresh deadline per retry). A connection that fails or drops is
// retried too, after 1 then 2 seconds (a refused one not inside a FailFastPass, below). Provider bodies are never copied into `error`; callers log them and report the status only.
HttpResult postJson(const std::string& url, const std::vector<std::string>& headers, const std::string& body, long timeoutMs,
                    std::size_t maxResponseBytes = 16u * 1024 * 1024);

// The first `n` bytes of a provider body for server logs (control characters flattened).
std::string excerpt(const std::string& body, std::size_t n = 300);

// One pass of a background loop over many channels that retries failed work on its own schedule (the observer's
// scan, the consolidation pass). Open one on the loop's thread for the length of a pass. Requests submitted from that
// thread while it is open do not retry a connection the provider refused, and an endpoint (scheme, host, port) that
// refused one is not called again in the same pass: those requests fail at once with the same error. The loop's own
// backoff comes back to the work later. Without it every request to a provider that is down costs seconds of
// connection retries, and the pass holds up every channel after it. Requests from other threads, and after the
// pass, keep the transport's retries.
class FailFastPass {
public:
    FailFastPass();
    ~FailFastPass();
    FailFastPass(const FailFastPass&) = delete;
    FailFastPass& operator=(const FailFastPass&) = delete;
    struct Refused;   // endpoints that refused a connection in this pass; shared with its requests still in flight
private:
    std::shared_ptr<Refused> refused_, previous_;
};

} // namespace acerciae::llm
