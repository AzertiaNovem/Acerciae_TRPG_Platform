#pragma once
#include <string>
#include <vector>

namespace acerciae::llm {

struct HttpResult {
    long status = 0;
    std::string body;
    std::string error;   // transport or guard failure, safe to show to users
};

// POSTs JSON to a maintainer-configured AI endpoint through the endpoint guard (pinned public resolution, no
// redirects, response size cap). 429, 502, 503, 504 and 529 are retried up to twice, honouring Retry-After up to
// 20 seconds. Provider bodies are never copied into `error`; callers log them and report the status only.
HttpResult postJson(const std::string& url, const std::vector<std::string>& headers, const std::string& body, long timeoutMs,
                    std::size_t maxResponseBytes = 16u * 1024 * 1024);

// The first `n` bytes of a provider body for server logs (control characters flattened).
std::string excerpt(const std::string& body, std::size_t n = 300);

} // namespace acerciae::llm
