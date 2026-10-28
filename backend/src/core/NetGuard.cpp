#include "NetGuard.h"
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#include <atomic>
#include <cstring>
#include <stdexcept>
#include <vector>

namespace acerciae::net {
namespace {
std::atomic<bool> g_allowPrivate{false};

bool v4Restricted(uint32_t a) {   // host byte order
    auto in = [&](uint32_t net, int bits) { return bits == 0 || (a >> (32 - bits)) == (net >> (32 - bits)); };
    return in(0x00000000, 8)      // 0.0.0.0/8 "this network"
        || in(0x0A000000, 8)      // 10/8
        || in(0x64400000, 10)     // 100.64/10 carrier-grade NAT
        || in(0x7F000000, 8)      // 127/8 loopback
        || in(0xA9FE0000, 16)     // 169.254/16 link-local (cloud metadata)
        || in(0xAC100000, 12)     // 172.16/12
        || in(0xC0000000, 24)     // 192.0.0/24 IETF protocol assignments
        || in(0xC0000200, 24)     // 192.0.2/24 documentation
        || in(0xC0A80000, 16)     // 192.168/16
        || in(0xC6120000, 15)     // 198.18/15 benchmarking
        || in(0xC6336400, 24)     // 198.51.100/24 documentation
        || in(0xCB007100, 24)     // 203.0.113/24 documentation
        || in(0xE0000000, 4)      // 224/4 multicast
        || in(0xF0000000, 4);     // 240/4 reserved, broadcast
}
bool v6Restricted(const unsigned char* b) {
    static const unsigned char zero[16] = {0};
    if (std::memcmp(b, zero, 16) == 0) return true;                                   // ::
    if (std::memcmp(b, zero, 15) == 0 && b[15] == 1) return true;                     // ::1
    bool mapped = std::memcmp(b, zero, 10) == 0 && b[10] == 0xff && b[11] == 0xff;    // ::ffff:a.b.c.d
    bool compat = std::memcmp(b, zero, 12) == 0;                                      // ::a.b.c.d (deprecated)
    if (mapped || compat) return v4Restricted((uint32_t(b[12]) << 24) | (uint32_t(b[13]) << 16) | (uint32_t(b[14]) << 8) | b[15]);
    if ((b[0] & 0xfe) == 0xfc) return true;                                           // fc00::/7 unique local
    if (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) return true;                           // fe80::/10 link-local
    if (b[0] == 0xfe && (b[1] & 0xc0) == 0xc0) return true;                           // fec0::/10 site-local
    if (b[0] == 0xff) return true;                                                    // ff00::/8 multicast
    if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == 0xb8) return true;    // 2001:db8::/32 documentation
    if (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b) return true;    // 64:ff9b::/96 NAT64 (embeds v4)
    return false;
}
struct Parts { std::string scheme, host, port; };
Parts parse(const std::string& url) {
    if (url.size() > 300 || url.find_first_of("\r\n\t ") != std::string::npos) throw std::invalid_argument("API base must be an http(s) URL without spaces (max 300 characters)");
    CURLU* u = curl_url();
    if (!u) throw std::invalid_argument("invalid API base URL");
    Parts p; bool ok = curl_url_set(u, CURLUPART_URL, url.c_str(), 0) == CURLUE_OK;
    auto get = [&](CURLUPart part, std::string& out, unsigned flags = 0) { char* v = nullptr; bool got = curl_url_get(u, part, &v, flags) == CURLUE_OK; if (got && v) out = v; curl_free(v); return got; };
    std::string extra;
    if (ok) {
        get(CURLUPART_SCHEME, p.scheme); get(CURLUPART_HOST, p.host); get(CURLUPART_PORT, p.port, CURLU_DEFAULT_PORT);
        for (auto part : {CURLUPART_USER, CURLUPART_PASSWORD, CURLUPART_QUERY, CURLUPART_FRAGMENT}) if (get(part, extra)) ok = false;
    }
    curl_url_cleanup(u);
    if (!ok || p.host.empty()) throw std::invalid_argument("API base must be an http(s) URL without credentials, query parameters or fragments");
    if (p.scheme != "https" && p.scheme != "http") throw std::invalid_argument("API base must be an http(s) URL");
    if (p.scheme == "http" && !g_allowPrivate) throw std::invalid_argument("API base must use https (plain http is only allowed when the operator enables AI_ALLOW_PRIVATE_ENDPOINTS)");
    if (p.host.size() > 2 && p.host.front() == '[' && p.host.back() == ']') p.host = p.host.substr(1, p.host.size() - 2);
    return p;
}
} // namespace

void setAllowPrivate(bool allow) { g_allowPrivate = allow; }
bool allowPrivate() { return g_allowPrivate; }

bool isRestrictedAddress(const std::string& ip) {
    unsigned char buf[16];
    if (inet_pton(AF_INET, ip.c_str(), buf) == 1) return v4Restricted((uint32_t(buf[0]) << 24) | (uint32_t(buf[1]) << 16) | (uint32_t(buf[2]) << 8) | buf[3]);
    if (inet_pton(AF_INET6, ip.c_str(), buf) == 1) return v6Restricted(buf);
    return true;   // not a numeric address: refuse
}

void checkEndpointSyntax(const std::string& url) {
    if (url.empty()) return;
    auto p = parse(url);
    if (!g_allowPrivate) {
        // A literal address can be judged now; host names are resolved and checked on every request.
        unsigned char buf[16];
        bool literal = inet_pton(AF_INET, p.host.c_str(), buf) == 1 || inet_pton(AF_INET6, p.host.c_str(), buf) == 1;
        if ((literal && isRestrictedAddress(p.host)) || p.host == "localhost" || (p.host.size() > 10 && p.host.compare(p.host.size() - 10, 10, ".localhost") == 0))
            throw std::invalid_argument("API base must not point at a private, loopback or link-local address");
    }
}

PinnedRequest::PinnedRequest(const std::string& url) : url_(url) {
    Parts p;
    try { p = parse(url); } catch (const std::invalid_argument& e) { throw std::runtime_error(e.what()); }
    if (g_allowPrivate) return;
    addrinfo hints{}; hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    if (getaddrinfo(p.host.c_str(), p.port.c_str(), &hints, &res) != 0 || !res) throw std::runtime_error("cannot resolve the AI provider host");
    std::vector<std::string> ips;
    for (auto* ai = res; ai; ai = ai->ai_next) {
        char text[INET6_ADDRSTRLEN] = {0};
        if (ai->ai_family == AF_INET) inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in*>(ai->ai_addr)->sin_addr, text, sizeof text);
        else if (ai->ai_family == AF_INET6) inet_ntop(AF_INET6, &reinterpret_cast<sockaddr_in6*>(ai->ai_addr)->sin6_addr, text, sizeof text);
        else continue;
        ips.push_back(text);
    }
    freeaddrinfo(res);
    if (ips.empty()) throw std::runtime_error("cannot resolve the AI provider host");
    // Every address must be public: a host that answers with a mix could be steered to the private one.
    for (auto& ip : ips) if (isRestrictedAddress(ip)) throw std::runtime_error("the AI provider host resolves to a private, loopback or link-local address");
    std::string pinned;
    for (auto& ip : ips) { if (!pinned.empty()) pinned += ","; pinned += ip.find(':') != std::string::npos ? "[" + ip + "]" : ip; }
    resolve_ = curl_slist_append(nullptr, (p.host + ":" + p.port + ":" + pinned).c_str());
}
PinnedRequest::~PinnedRequest() { if (resolve_) curl_slist_free_all(resolve_); }

void PinnedRequest::apply(CURL* c, std::size_t maxResponseBytes) const {
    curl_easy_setopt(c, CURLOPT_URL, url_.c_str());
    if (resolve_) curl_easy_setopt(c, CURLOPT_RESOLVE, resolve_);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(c, CURLOPT_PROTOCOLS_STR, g_allowPrivate ? "http,https" : "https");
    curl_easy_setopt(c, CURLOPT_MAXFILESIZE_LARGE, (curl_off_t)maxResponseBytes);
}

std::size_t cappedWrite(char* ptr, std::size_t size, std::size_t nmemb, void* userdata) {
    auto* body = static_cast<CappedBody*>(userdata);
    std::size_t n = size * nmemb;
    if (body->data.size() + n > body->limit) return 0;   // aborts the transfer (CURLE_WRITE_ERROR)
    body->data.append(ptr, n);
    return n;
}

} // namespace acerciae::net
