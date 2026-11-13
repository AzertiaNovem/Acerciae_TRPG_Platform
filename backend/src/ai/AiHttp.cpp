#include "AiHttp.h"
#include "../core/NetGuard.h"
#include <curl/curl.h>
#include <cctype>
#include <memory>

namespace acerciae::ai::http {

Result post(const std::string& url, const std::vector<std::string>& headers, const std::string& body, long timeoutMs, std::size_t maxBytes) {
    return llm::postJson(url, headers, body, timeoutMs, maxBytes);
}

namespace {
size_t write(char* p, size_t s, size_t n, void* ctx) {
    auto& out = *static_cast<std::string*>(ctx);
    out.append(p, s * n);
    return s * n;
}
Result perform(CURL* c, curl_slist* headers, const net::PinnedRequest& pinned, long timeoutMs, std::size_t maxBytes) {
    Result r; std::string out;
    pinned.apply(c, maxBytes);
    curl_easy_setopt(c, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, timeoutMs);
    curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, 10000L);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, write);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &out);
    auto rc = curl_easy_perform(c);
    curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &r.status);
    if (rc != CURLE_OK) r.error = rc == CURLE_OPERATION_TIMEDOUT ? "the AI provider did not answer in time" : rc == CURLE_FILESIZE_EXCEEDED || rc == CURLE_WRITE_ERROR ? "the AI provider's answer was too large" : "could not reach the AI provider";
    r.body = std::move(out);
    return r;
}
}

Result postMultipart(const std::string& url, const std::vector<std::string>& hs, const std::vector<std::pair<std::string, std::string>>& fields,
                     const std::vector<FilePart>& files, long timeoutMs, std::size_t maxBytes) {
    Result r;
    std::unique_ptr<net::PinnedRequest> pinned;
    try { pinned = std::make_unique<net::PinnedRequest>(url); } catch (const std::exception& e) { r.error = e.what(); return r; }
    auto* c = curl_easy_init();
    if (!c) { r.error = "HTTP client unavailable"; return r; }
    curl_slist* headers = nullptr;
    for (const auto& h : hs) headers = curl_slist_append(headers, h.c_str());
    auto* form = curl_mime_init(c);
    for (const auto& [k, v] : fields) { auto* part = curl_mime_addpart(form); curl_mime_name(part, k.c_str()); curl_mime_data(part, v.data(), v.size()); }
    for (const auto& f : files) {
        auto* part = curl_mime_addpart(form); curl_mime_name(part, f.field.c_str()); curl_mime_filename(part, f.filename.c_str());
        curl_mime_type(part, f.mime.c_str()); curl_mime_data(part, f.bytes.data(), f.bytes.size());
    }
    curl_easy_setopt(c, CURLOPT_MIMEPOST, form);
    r = perform(c, headers, *pinned, timeoutMs, maxBytes);
    curl_mime_free(form); curl_slist_free_all(headers); curl_easy_cleanup(c);
    return r;
}

Result postOnce(const std::string& url, const std::vector<std::string>& hs, const std::string& body, long timeoutMs, std::size_t maxBytes) {
    Result r;
    std::unique_ptr<net::PinnedRequest> pinned;
    try { pinned = std::make_unique<net::PinnedRequest>(url); } catch (const std::exception& e) { r.error = e.what(); return r; }
    auto* c = curl_easy_init();
    if (!c) { r.error = "HTTP client unavailable"; return r; }
    curl_slist* headers = nullptr;
    for (const auto& h : hs) headers = curl_slist_append(headers, h.c_str());
    curl_easy_setopt(c, CURLOPT_POSTFIELDS, body.data());
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)body.size());
    r = perform(c, headers, *pinned, timeoutMs, maxBytes);
    curl_slist_free_all(headers); curl_easy_cleanup(c);
    return r;
}

Result get(const std::string& url, const std::vector<std::string>& hs, long timeoutMs, std::size_t maxBytes) {
    Result r;
    std::unique_ptr<net::PinnedRequest> pinned;
    try { pinned = std::make_unique<net::PinnedRequest>(url); } catch (const std::exception& e) { r.error = e.what(); return r; }
    auto* c = curl_easy_init();
    if (!c) { r.error = "HTTP client unavailable"; return r; }
    curl_slist* headers = nullptr;
    for (const auto& h : hs) headers = curl_slist_append(headers, h.c_str());
    curl_easy_setopt(c, CURLOPT_HTTPGET, 1L);
    r = perform(c, headers, *pinned, timeoutMs, maxBytes);
    curl_slist_free_all(headers); curl_easy_cleanup(c);
    return r;
}

std::string joinUrl(std::string base, const std::string& path) {
    while (!base.empty() && base.back() == '/') base.pop_back();
    return base + path;
}
std::string hostOf(const std::string& url) {
    auto start = url.find("://"); if (start == std::string::npos) return "";
    start += 3; auto end = url.find_first_of("/?#", start);
    return url.substr(start, end == std::string::npos ? std::string::npos : end - start);
}
std::string pathOf(const std::string& url) {
    auto start = url.find("://"); if (start == std::string::npos) return "/";
    auto slash = url.find('/', start + 3);
    if (slash == std::string::npos) return "/";
    auto end = url.find_first_of("?#", slash);
    return url.substr(slash, end == std::string::npos ? std::string::npos : end - slash);
}

std::string uriPath(const std::string& path) {
    static const char* digits = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : path) {
        if (std::isalnum(c) || c == '-' || c == '.' || c == '_' || c == '~' || c == '/') out += char(c);
        else { out += '%'; out += digits[c >> 4]; out += digits[c & 15]; }
    }
    return out;
}

} // namespace acerciae::ai::http
