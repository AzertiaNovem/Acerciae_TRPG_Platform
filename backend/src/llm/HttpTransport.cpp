#include "HttpTransport.h"
#include "../core/NetGuard.h"
#include <curl/curl.h>
#include <algorithm>
#include <chrono>
#include <thread>

namespace acerciae::llm {
namespace {
std::size_t headerCb(char* buffer, std::size_t size, std::size_t nitems, void* userdata) {
    std::string line(buffer, size * nitems);
    auto* retryAfter = static_cast<int*>(userdata);
    if (line.size() > 12 && (line.compare(0, 12, "retry-after:") == 0 || line.compare(0, 12, "Retry-After:") == 0)) {
        try { *retryAfter = std::stoi(line.substr(12)); } catch (...) {}
    }
    return size * nitems;
}
bool retryable(long status) { return status == 429 || status == 502 || status == 503 || status == 504 || status == 529; }
} // namespace

HttpResult postJson(const std::string& url, const std::vector<std::string>& headers, const std::string& body, long timeoutMs, std::size_t maxResponseBytes) {
    HttpResult out;
    for (int attempt = 0; attempt < 3; ++attempt) {
        out = HttpResult{};
        std::unique_ptr<net::PinnedRequest> pinned;
        try { pinned = std::make_unique<net::PinnedRequest>(url); }
        catch (const std::exception& e) { out.error = e.what(); return out; }
        CURL* c = curl_easy_init();
        if (!c) { out.error = "HTTP client unavailable"; return out; }
        curl_slist* h = nullptr;
        for (const auto& line : headers) h = curl_slist_append(h, line.c_str());
        net::CappedBody received; received.limit = maxResponseBytes;
        int retryAfter = -1;
        pinned->apply(c, maxResponseBytes);
        curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
        curl_easy_setopt(c, CURLOPT_POSTFIELDS, body.c_str());
        curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)body.size());
        curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, net::cappedWrite);
        curl_easy_setopt(c, CURLOPT_WRITEDATA, &received);
        curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, headerCb);
        curl_easy_setopt(c, CURLOPT_HEADERDATA, &retryAfter);
        curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, timeoutMs);
        curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, 10000L);
        auto rc = curl_easy_perform(c);
        curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &out.status);
        curl_slist_free_all(h);
        curl_easy_cleanup(c);
        out.body = std::move(received.data);
        if (rc == CURLE_WRITE_ERROR || rc == CURLE_FILESIZE_EXCEEDED) { out.error = "the AI provider response exceeded the size limit"; return out; }
        if (rc != CURLE_OK) {
            out.error = std::string("could not reach the AI provider: ") + curl_easy_strerror(rc);
            if (attempt < 2 && (rc == CURLE_COULDNT_CONNECT || rc == CURLE_GOT_NOTHING || rc == CURLE_RECV_ERROR)) { std::this_thread::sleep_for(std::chrono::seconds(1 + attempt)); continue; }
            return out;
        }
        if (retryable(out.status) && attempt < 2) {
            int wait = retryAfter >= 0 ? std::min(retryAfter, 20) : 2 << attempt;
            std::this_thread::sleep_for(std::chrono::seconds(wait));
            continue;
        }
        return out;
    }
    return out;
}

std::string excerpt(const std::string& body, std::size_t n) {
    std::string s = body.substr(0, n);
    for (auto& ch : s) if ((unsigned char)ch < 0x20) ch = ' ';
    return s;
}

} // namespace acerciae::llm
