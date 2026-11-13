#include "AwsSigV4.h"
#include "../core/Crypto.h"
#include <algorithm>
#include <cctype>
#include <ctime>
#include <openssl/hmac.h>

namespace acerciae::ai::aws {

static std::string hmac(const std::string& key, const std::string& data) {
    unsigned char out[EVP_MAX_MD_SIZE]; unsigned int len = 0;
    HMAC(EVP_sha256(), key.data(), (int)key.size(), reinterpret_cast<const unsigned char*>(data.data()), data.size(), out, &len);
    return std::string(reinterpret_cast<char*>(out), len);
}
static std::string hex(const std::string& bytes) {
    static const char* digits = "0123456789abcdef";
    std::string out; out.reserve(bytes.size() * 2);
    for (unsigned char c : bytes) { out += digits[c >> 4]; out += digits[c & 15]; }
    return out;
}
static std::string trim(const std::string& v) {
    auto a = v.find_first_not_of(" \t"), b = v.find_last_not_of(" \t");
    if (a == std::string::npos) return "";
    std::string out; bool space = false;
    for (auto c : v.substr(a, b - a + 1)) { if (c == ' ') { if (!space) out += c; space = true; } else { out += c; space = false; } }
    return out;
}

std::string uriEncode(const std::string& s, bool keepSlash) {
    static const char* digits = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '.' || c == '_' || c == '~' || (keepSlash && c == '/')) out += char(c);
        else { out += '%'; out += digits[c >> 4]; out += digits[c & 15]; }
    }
    return out;
}
std::string canonicalPath(const std::string& wirePath) { return wirePath.empty() ? "/" : uriEncode(wirePath, true); }

std::string canonicalRequest(const Request& req, const std::vector<std::pair<std::string, std::string>>& headers, std::string* signedNames) {
    std::vector<std::pair<std::string, std::string>> lower;
    for (const auto& [k, v] : headers) { std::string name = k; std::transform(name.begin(), name.end(), name.begin(), ::tolower); lower.emplace_back(name, trim(v)); }
    std::sort(lower.begin(), lower.end());
    std::string canonicalHeaders, names;
    for (const auto& [k, v] : lower) { canonicalHeaders += k + ":" + v + "\n"; names += (names.empty() ? "" : ";") + k; }
    if (signedNames) *signedNames = names;
    return req.method + "\n" + canonicalPath(req.path) + "\n" + req.query + "\n" + canonicalHeaders + "\n" + names + "\n" + crypto::sha256Hex(req.body);
}

std::string signature(const std::string& secret, const std::string& date, const std::string& region, const std::string& service, const std::string& stringToSign) {
    auto key = hmac(hmac(hmac(hmac("AWS4" + secret, date), region), service), "aws4_request");
    return hex(hmac(key, stringToSign));
}

std::vector<std::string> sign(const Request& req, const Credentials& c, const std::string& service, std::string amzDate) {
    if (amzDate.empty()) {
        std::time_t now = std::time(nullptr); std::tm tm{}; gmtime_r(&now, &tm);
        char buf[17]; std::strftime(buf, sizeof buf, "%Y%m%dT%H%M%SZ", &tm); amzDate = buf;
    }
    auto date = amzDate.substr(0, 8);
    auto headers = req.headers;
    headers.emplace_back("host", req.host);
    headers.emplace_back("x-amz-date", amzDate);
    if (!c.sessionToken.empty()) headers.emplace_back("x-amz-security-token", c.sessionToken);
    std::string names;
    auto canonical = canonicalRequest(req, headers, &names);
    auto scope = date + "/" + c.region + "/" + service + "/aws4_request";
    auto toSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + crypto::sha256Hex(canonical);
    std::vector<std::string> out;
    for (const auto& [k, v] : req.headers) out.push_back(k + ": " + v);
    out.push_back("X-Amz-Date: " + amzDate);
    if (!c.sessionToken.empty()) out.push_back("X-Amz-Security-Token: " + c.sessionToken);
    out.push_back("Authorization: AWS4-HMAC-SHA256 Credential=" + c.accessKeyId + "/" + scope + ", SignedHeaders=" + names +
                  ", Signature=" + signature(c.secretAccessKey, date, c.region, service, toSign));
    return out;   // Host is set by the HTTP client from the URL
}

} // namespace acerciae::ai::aws
