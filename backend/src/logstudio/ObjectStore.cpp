#include "ObjectStore.h"
#include "../core/Crypto.h"
#include "../core/Log.h"
#include <curl/curl.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <filesystem>
#include <vector>
#include <algorithm>
#include <map>
#include <set>
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
    // `useProxy`: honour the process's HTTP(S)_PROXY settings. Off for a store on the local network (MinIO), on for
    // public services such as R2, which may only be reachable through the egress proxy.
    S3ObjectStore(std::string kind, std::string endpoint, std::string region, std::string bucket, std::string ak, std::string sk, bool pathStyle, bool useProxy)
        : kind_(std::move(kind)), endpoint_(std::move(endpoint)), region_(std::move(region)), bucket_(std::move(bucket)), ak_(std::move(ak)), sk_(std::move(sk)), pathStyle_(pathStyle), useProxy_(useProxy) { if (!endpoint_.empty() && endpoint_.back() == '/') endpoint_.pop_back(); }
    void put(const std::string& key, const std::string& bytes, const std::string& ct) override { long st; auto r = request("PUT", key, bytes, ct, st); if (st < 200 || st >= 300) throw std::runtime_error(kind_ + " put failed: http " + std::to_string(st) + " " + r.substr(0, 200)); }
    std::optional<std::string> get(const std::string& key) override { long st; auto r = request("GET", key, "", "", st); if (st == 404) return std::nullopt; if (st < 200 || st >= 300) throw std::runtime_error(kind_ + " get failed: http " + std::to_string(st)); return r; }
    bool exists(const std::string& key) override { long st; request("HEAD", key, "", "", st); return st >= 200 && st < 300; }
    void remove(const std::string& key) override { long st; request("DELETE", key, "", "", st); }
    std::string kind() const override { return kind_; }
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
        curl_easy_setopt(c, CURLOPT_URL, url.c_str()); curl_easy_setopt(c, CURLOPT_HTTPHEADER, h); curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, wcb); curl_easy_setopt(c, CURLOPT_WRITEDATA, &out); curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, 60000L); if (!useProxy_) curl_easy_setopt(c, CURLOPT_NOPROXY, "*");
        if (method == "PUT") { curl_easy_setopt(c, CURLOPT_UPLOAD, 1L); curl_easy_setopt(c, CURLOPT_READFUNCTION, +[](char* buf, size_t s, size_t n, void* u) -> size_t { auto* src = (std::pair<const std::string*, size_t>*)u; size_t left = src->first->size() - src->second; size_t take = std::min(left, s * n); memcpy(buf, src->first->data() + src->second, take); src->second += take; return take; }); }
        std::pair<const std::string*, size_t> src{&body, 0}; if (method == "PUT") { curl_easy_setopt(c, CURLOPT_READDATA, &src); curl_easy_setopt(c, CURLOPT_INFILESIZE_LARGE, (curl_off_t)body.size()); }
        else if (method == "HEAD") curl_easy_setopt(c, CURLOPT_NOBODY, 1L); else if (method == "DELETE") curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, "DELETE");
        auto rc = curl_easy_perform(c); status = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status); if (rc != CURLE_OK) { ALOG_WARN << kind_ << " transport: " << curl_easy_strerror(rc); status = 0; }
        curl_slist_free_all(h); curl_easy_cleanup(c); return out;
    }
    std::string kind_, endpoint_, region_, bucket_, ak_, sk_; bool pathStyle_, useProxy_;
};

static std::string envOr(const char* k, const std::string& d = "") { const char* v = std::getenv(k); return (v && *v) ? std::string(v) : d; }

std::unique_ptr<ObjectStore> makeBackend(const std::string& kind, const Config& cfg) {
    if (kind == "local") return std::make_unique<LocalObjectStore>((fs::path(cfg.uploadDir) / "objects").string());
    if (kind == "s3")
        return std::make_unique<S3ObjectStore>("s3", envOr("S3_ENDPOINT", "http://minio:9000"), envOr("S3_REGION", "us-east-1"), envOr("S3_BUCKET", "acerciae"),
                                               envOr("S3_ACCESS_KEY"), envOr("S3_SECRET_KEY"), envOr("S3_PATH_STYLE", "true") == "true", envOr("S3_USE_PROXY", "false") == "true");
    if (kind == "r2") {
        // Cloudflare R2 speaks the S3 API at https://<account id>.r2.cloudflarestorage.com with region "auto".
        // R2_ENDPOINT overrides it, e.g. for the EU jurisdiction (https://<account id>.eu.r2.cloudflarestorage.com).
        auto account = envOr("R2_ACCOUNT_ID"), endpoint = envOr("R2_ENDPOINT");
        if (endpoint.empty() && !account.empty()) endpoint = "https://" + account + ".r2.cloudflarestorage.com";
        auto bucket = envOr("R2_BUCKET"), ak = envOr("R2_ACCESS_KEY_ID"), sk = envOr("R2_SECRET_ACCESS_KEY");
        std::vector<std::string> missing;
        if (endpoint.empty()) missing.push_back("R2_ACCOUNT_ID (or R2_ENDPOINT)");
        if (bucket.empty()) missing.push_back("R2_BUCKET");
        if (ak.empty()) missing.push_back("R2_ACCESS_KEY_ID");
        if (sk.empty()) missing.push_back("R2_SECRET_ACCESS_KEY");
        if (!missing.empty()) {
            std::string m; for (auto& x : missing) m += (m.empty() ? "" : ", ") + x;
            throw std::runtime_error("Cloudflare R2 storage is selected but not configured: set " + m);
        }
        return std::make_unique<S3ObjectStore>("r2", endpoint, "auto", bucket, ak, sk, true, envOr("R2_USE_PROXY", "true") == "true");
    }
    throw std::runtime_error("unknown object store '" + kind + "' (use local, s3 or r2)");
}

bool isImageObject(const std::string& key, const std::string& contentType) {
    if (contentType.rfind("image/", 0) == 0) return true;
    auto dot = key.rfind('.');
    if (dot == std::string::npos || key.find('/', dot) != std::string::npos) return false;
    std::string ext; for (char c : key.substr(dot + 1)) ext += (char)std::tolower((unsigned char)c);
    static const std::set<std::string> exts = {"png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp"};
    return exts.count(ext) > 0;
}

RoutingObjectStore::RoutingObjectStore(std::shared_ptr<ObjectStore> general, std::shared_ptr<ObjectStore> images, std::vector<std::shared_ptr<ObjectStore>> fallbacks)
    : general_(std::move(general)), images_(std::move(images)) {
    for (auto& s : std::vector<std::shared_ptr<ObjectStore>>{general_, images_})
        if (std::find(all_.begin(), all_.end(), s) == all_.end()) all_.push_back(s);
    for (auto& s : fallbacks) if (s && std::find(all_.begin(), all_.end(), s) == all_.end()) all_.push_back(s);
}
std::vector<ObjectStore*> RoutingObjectStore::readOrder(const std::string& key) const {
    std::vector<ObjectStore*> order{isImageObject(key) ? images_.get() : general_.get()};
    for (auto& s : all_) if (s.get() != order[0]) order.push_back(s.get());
    return order;
}
void RoutingObjectStore::put(const std::string& key, const std::string& bytes, const std::string& contentType) {
    (isImageObject(key, contentType) ? images_ : general_)->put(key, bytes, contentType);
}
std::optional<std::string> RoutingObjectStore::get(const std::string& key) {
    // A backend that fails (rather than reporting "not found") must not turn into a silent 404 when no other has it.
    std::optional<std::runtime_error> firstError;
    for (auto* s : readOrder(key)) {
        try { if (auto v = s->get(key)) return v; }
        catch (const std::exception& e) { ALOG_WARN << "object store " << s->kind() << ": " << e.what(); if (!firstError) firstError.emplace(e.what()); }
    }
    if (firstError) throw *firstError;
    return std::nullopt;
}
bool RoutingObjectStore::exists(const std::string& key) {
    for (auto* s : readOrder(key)) { try { if (s->exists(key)) return true; } catch (const std::exception& e) { ALOG_WARN << "object store " << s->kind() << ": " << e.what(); } }
    return false;
}
void RoutingObjectStore::remove(const std::string& key) {
    std::optional<std::runtime_error> firstError;
    for (auto* s : readOrder(key)) {
        try { s->remove(key); }
        catch (const std::exception& e) { if (!firstError) firstError.emplace(e.what()); }
    }
    if (firstError) throw *firstError;
}
std::string RoutingObjectStore::kind() const {
    return general_ == images_ ? general_->kind() : general_->kind() + "+images:" + images_->kind();
}

CopyReport copyObjects(ObjectStore& from, ObjectStore& to, const std::vector<std::pair<std::string, std::string>>& keysAndMimes) {
    CopyReport r;
    for (auto& [key, mime] : keysAndMimes) {
        try {
            if (to.exists(key)) { ++r.alreadyPresent; continue; }
            auto bytes = from.get(key);
            if (!bytes) { ++r.missingAtSource; continue; }
            to.put(key, *bytes, mime);
            ++r.copied;
        } catch (const std::exception& e) { ALOG_WARN << "copy " << key << ": " << e.what(); ++r.failed; }
    }
    return r;
}

std::unique_ptr<ObjectStore> makeObjectStore(const Config& cfg) {
    auto generalKind = envOr("OBJECT_STORE", "local");
    auto imageKind = envOr("IMAGE_STORE", generalKind);
    std::map<std::string, std::shared_ptr<ObjectStore>> built;
    auto backend = [&](const std::string& kind) { auto& b = built[kind]; if (!b) b = makeBackend(kind, cfg); return b; };
    auto general = backend(generalKind), images = backend(imageKind);
    // Objects written under an earlier setting stay readable: the local directory always, and the other remote
    // stores whenever their credentials are still in the environment.
    std::vector<std::shared_ptr<ObjectStore>> fallbacks{backend("local")};
    if (!envOr("R2_BUCKET").empty() && !built.count("r2")) { try { fallbacks.push_back(backend("r2")); } catch (const std::exception& e) { ALOG_WARN << "R2 read fallback disabled: " << e.what(); } }
    if (!envOr("S3_ACCESS_KEY").empty() && !built.count("s3")) fallbacks.push_back(backend("s3"));
    std::string fb; for (auto& [k, b] : built) if (k != generalKind && k != imageKind) fb += (fb.empty() ? "" : ", ") + k;
    ALOG_INFO << "object store: media=" << generalKind << " images=" << imageKind << (generalKind == "s3" || imageKind == "s3" ? " s3 bucket=" + envOr("S3_BUCKET", "acerciae") : "")
              << (generalKind == "r2" || imageKind == "r2" ? " r2 bucket=" + envOr("R2_BUCKET") : "") << (fb.empty() ? "" : " read fallbacks=" + fb);
    if (built.size() == 1) return std::make_unique<RoutingObjectStore>(general, images);
    return std::make_unique<RoutingObjectStore>(general, images, fallbacks);
}

} // namespace
