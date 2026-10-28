#pragma once
#include <curl/curl.h>
#include <string>

namespace acerciae::net {

// Outbound AI endpoints are chosen by server maintainers, and anyone may create a server. Every call to such an
// endpoint goes through this guard: https only, no credentials/query/fragment in the URL, and the host must resolve
// to public addresses only. The resolution is pinned for the request (no DNS rebinding) and redirects are never
// followed. An operator who runs self-hosted models sets AI_ALLOW_PRIVATE_ENDPOINTS=true to allow http:// and
// private, loopback and link-local hosts.
void setAllowPrivate(bool allow);
bool allowPrivate();

// True for addresses an outbound AI call must not reach unless private endpoints are allowed: loopback,
// RFC 1918, carrier-grade NAT, link-local, unique-local, multicast, unspecified, documentation and benchmark
// ranges, and IPv4-mapped forms of those. `ip` is a numeric IPv4 or IPv6 address.
bool isRestrictedAddress(const std::string& ip);

// Syntax and scheme check for a URL a maintainer saves; throws std::invalid_argument with a user-facing message.
void checkEndpointSyntax(const std::string& url);

// Resolves and pins an endpoint for one request. Throws std::runtime_error with a safe message when the URL is
// malformed or the host resolves to a restricted address (and private endpoints are not allowed).
class PinnedRequest {
public:
    explicit PinnedRequest(const std::string& url);
    ~PinnedRequest();
    PinnedRequest(const PinnedRequest&) = delete;
    PinnedRequest& operator=(const PinnedRequest&) = delete;
    // Sets URL, pinned resolution, protocols, no redirects and the response size cap on a curl handle.
    void apply(CURL* c, std::size_t maxResponseBytes) const;
    const std::string& url() const { return url_; }
private:
    std::string url_;
    curl_slist* resolve_ = nullptr;
};

// Write callback that appends to a std::string and aborts the transfer once `limit` bytes would be exceeded.
struct CappedBody { std::string data; std::size_t limit = 16u * 1024 * 1024; };
std::size_t cappedWrite(char* ptr, std::size_t size, std::size_t nmemb, void* userdata);

} // namespace acerciae::net
