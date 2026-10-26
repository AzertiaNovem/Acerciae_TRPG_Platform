#include "ObjectStore.h"
#include "../core/Crypto.h"
#include "../core/Log.h"
#include <curl/curl.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <ctime>
#include <cstdlib>

namespace acerciae::logstudio {
namespace fs = std::filesystem;

std::string safeObjectKey(const std::string& channelId, const std::string& category, const std::string& ext) {
    std::string e; for (char c : ext) if (std::isalnum((unsigned char)c)) e += (char)std::tolower(c);
    return "channels/" + channelId + "/" + category + "/" + crypto::uuid4() + (e.empty() ? "" : "." + e);
}

// ---- local ----------------------------------------------------------------------------------------
class LocalObjectStore : public ObjectStore {
public:
    explicit LocalObjectStore(std::string root) : root_(std::move(root)) { fs::create_directories(root_); }
    fs::path pathFor(const std::string& key) const {
        if (key.find("..") != std::string::npos || key.empty() || key[0] == '/') throw std::runtime_error("invalid object key");
        return fs::path(root_) / key;
    }
    void put(const std::string& key, const std::string& bytes, const std::string&) override { auto p = pathFor(key); fs::create_directories(p.parent_path()); std::ofstream o(p, std::ios::binary); o.write(bytes.data(), (std::streamsize)bytes.size()); }
    std::optional<std::string> get(const std::string& key) override { auto p = pathFor(key); if (!fs::exists(p)) return std::nullopt; std::ifstream i(p, std::ios::binary); return std::string((std::istreambuf_iterator<char>(i)), std::istreambuf_iterator<char>()); }
    bool exists(const std::string& key) override { return fs::exists(pathFor(key)); }
    void remove(const std::string& key) override { std::error_code ec; fs::remove(pathFor(key), ec); }
    std::string kind() const override { return "local"; }
private:
    std::string root_;
};

// ---- S3 (SigV4) -----------------------------------------------------------------------------------
static std::string hexOf(const unsigned char* d, size_t n) { static const char* x = "0123456789abcdef"; std::string o; for (size_t i = 0; i < n; ++i) { o += x[d[i] >> 4]; o += x[d[i] & 15]; } return o; }
static std::string sha256hex(const std::string& s) { unsigned char md[32]; SHA256((const unsigned char*)s.data(), s.size(), md); return hexOf(md, 32); }
static std::string hmacRaw(const std::string& key, const std::string& data) { unsigned char md[EVP_MAX_MD_SIZE]; unsigned len = 0; HMAC(EVP_sha256(), key.data(), (int)key.size(), (const unsigned char*)data.data(), data.size(), md, &len); return std::string((char*)md, len); }
static size_t wcb(char* p, size_t s, size_t n, void* u) { ((std::string*)u)->append(p, s * n); return s * n; }
static std::string uriEncode(const std::string& s, bool keepSlash) { std::ostringstream o; for (unsigned char c : s) { if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' || (keepSlash && c == '/')) o << c; else o << '%' << std::uppercase << std::hex << std::setw(2) << std::setfill('0') << (int)c; } return o.str(); }

class S3ObjectStore : public ObjectStore {
public:
    S3ObjectStore(std::string endpoint, std::string region, std::string bucket, std::string ak, std::string sk, bool pathStyle)
        : endpoint_(std::move(endpoint)), region_(std::move(region)), bucket_(std::move(bucket)), ak_(std::move(ak)), sk_(std::move(sk)), pathStyle_(pathStyle) { if (!endpoint_.empty() && endpoint_.back() == '/') endpoint_.pop_back(); }
    void put(const std::string& key, const std::string& bytes, const std::string& ct) override { long st; auto r = request("PUT", key, bytes, ct, st); if (st < 200 || st >= 300) throw std::runtime_error("s3 put failed: http " + std::to_string(st) + " " + r.substr(0, 200)); }
    std::optional<std::string> get(const std::string& key) override { long st; auto r = request("GET", key, "", "", st); if (st == 404) return std::nullopt; if (st < 200 || st >= 300) throw std::runtime_error("s3 get failed: http " + std::to_string(st)); return r; }
    bool exists(const std::string& key) override { long st; request("HEAD", key, "", "", st); return st >= 200 && st < 300; }
    void remove(const std::string& key) override { long st; request("DELETE", key, "", "", st); }
    std::string kind() const override { return "s3"; }
private:
    std::string request(const std::string& method, const std::string& key, const std::string& body, const std::string& ct, long& status) {
        std::string host, scheme = "https"; { auto e = endpoint_; auto p = e.find("://"); if (p != std::string::npos) { scheme = e.substr(0, p); e = e.substr(p + 3); } host = e; }
        std::string canonicalUri = pathStyle_ ? "/" + bucket_ + "/" + uriEncode(key, true) : "/" + uriEncode(key, true);
        std::string hostHeader = pathStyle_ ? host : bucket_ + "." + host;
        std::time_t now = std::time(nullptr); std::tm tm{}; gmtime_r(&now, &tm); char amz[32], date[16]; std::strftime(amz, sizeof amz, "%Y%m%dT%H%M%SZ", &tm); std::strftime(date, sizeof date, "%Y%m%d", &tm);
        std::string payloadHash = sha256hex(body);
        std::string canonicalHeaders = "host:" + hostHeader + "\nx-amz-content-sha256:" + payloadHash + "\nx-amz-date:" + std::string(amz) + "\n";
        std::string signedHeaders = "host;x-amz-content-sha256;x-amz-date";
        std::string canonicalRequest = method + "\n" + canonicalUri + "\n\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + payloadHash;
        std::string scope = std::string(date) + "/" + region_ + "/s3/aws4_request";
        std::string sts = "AWS4-HMAC-SHA256\n" + std::string(amz) + "\n" + scope + "\n" + sha256hex(canonicalRequest);
        auto kDate = hmacRaw("AWS4" + sk_, date); auto kRegion = hmacRaw(kDate, region_); auto kService = hmacRaw(kRegion, "s3"); auto kSigning = hmacRaw(kService, "aws4_request");
        auto sigRaw = hmacRaw(kSigning, sts); std::string signature = hexOf((const unsigned char*)sigRaw.data(), sigRaw.size());
        std::string auth = "AWS4-HMAC-SHA256 Credential=" + ak_ + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
        std::string url = scheme + "://" + hostHeader + canonicalUri;
        CURL* c = curl_easy_init(); std::string out; struct curl_slist* h = nullptr;
        h = curl_slist_append(h, ("Authorization: " + auth).c_str()); h = curl_slist_append(h, ("x-amz-date: " + std::string(amz)).c_str()); h = curl_slist_append(h, ("x-amz-content-sha256: " + payloadHash).c_str());
        if (!ct.empty()) h = curl_slist_append(h, ("Content-Type: " + ct).c_str());
        curl_easy_setopt(c, CURLOPT_URL, url.c_str()); curl_easy_setopt(c, CURLOPT_HTTPHEADER, h); curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, wcb); curl_easy_setopt(c, CURLOPT_WRITEDATA, &out); curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, 60000L); curl_easy_setopt(c, CURLOPT_NOPROXY, "*");
        if (method == "PUT") { curl_easy_setopt(c, CURLOPT_UPLOAD, 1L); curl_easy_setopt(c, CURLOPT_READFUNCTION, +[](char* buf, size_t s, size_t n, void* u) -> size_t { auto* src = (std::pair<const std::string*, size_t>*)u; size_t left = src->first->size() - src->second; size_t take = std::min(left, s * n); memcpy(buf, src->first->data() + src->second, take); src->second += take; return take; }); }
        std::pair<const std::string*, size_t> src{&body, 0}; if (method == "PUT") { curl_easy_setopt(c, CURLOPT_READDATA, &src); curl_easy_setopt(c, CURLOPT_INFILESIZE_LARGE, (curl_off_t)body.size()); }
        else if (method == "HEAD") curl_easy_setopt(c, CURLOPT_NOBODY, 1L); else if (method == "DELETE") curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, "DELETE");
        auto rc = curl_easy_perform(c); status = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status); if (rc != CURLE_OK) { ALOG_WARN << "s3 transport: " << curl_easy_strerror(rc); status = 0; }
        curl_slist_free_all(h); curl_easy_cleanup(c); return out;
    }
    std::string endpoint_, region_, bucket_, ak_, sk_; bool pathStyle_;
};

std::unique_ptr<ObjectStore> makeObjectStore(const Config& cfg) {
    auto env = [](const char* k, const char* d) { const char* v = std::getenv(k); return (v && *v) ? std::string(v) : std::string(d); };
    if (env("OBJECT_STORE", "local") == "s3") {
        ALOG_INFO << "object store: s3 endpoint=" << env("S3_ENDPOINT", "") << " bucket=" << env("S3_BUCKET", "");
        return std::make_unique<S3ObjectStore>(env("S3_ENDPOINT", "http://minio:9000"), env("S3_REGION", "us-east-1"), env("S3_BUCKET", "acerciae"), env("S3_ACCESS_KEY", ""), env("S3_SECRET_KEY", ""), env("S3_PATH_STYLE", "true") == "true");
    }
    auto root = (fs::path(cfg.uploadDir) / "objects").string();
    ALOG_INFO << "object store: local dir " << root;
    return std::make_unique<LocalObjectStore>(root);
}

} // namespace
