#include "Crypto.h"
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <sstream>
#include <iomanip>
#include <vector>
#include <cstring>
#include <stdexcept>

namespace acerciae::crypto {

static std::string hex(const unsigned char* d, size_t n) {
    static const char* digits = "0123456789abcdef";
    std::string out; out.reserve(n * 2);
    for (size_t i = 0; i < n; ++i) { out += digits[d[i] >> 4]; out += digits[d[i] & 15]; }
    return out;
}

std::string randomHex(std::size_t bytes) {
    std::vector<unsigned char> buf(bytes);
    if (RAND_bytes(buf.data(), (int)bytes) != 1) throw std::runtime_error("RAND_bytes failed");
    return hex(buf.data(), bytes);
}

std::string sha256Hex(const std::string& data) {
    unsigned char md[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(data.data()), data.size(), md);
    return hex(md, SHA256_DIGEST_LENGTH);
}

std::string hmacSha256Hex(const std::string& key, const std::string& data) {
    unsigned char md[EVP_MAX_MD_SIZE]; unsigned int len = 0;
    HMAC(EVP_sha256(), key.data(), (int)key.size(),
         reinterpret_cast<const unsigned char*>(data.data()), data.size(), md, &len);
    return hex(md, len);
}

static std::string pbkdf2(const std::string& pw, const std::string& salt, int iter) {
    unsigned char out[32];
    PKCS5_PBKDF2_HMAC(pw.c_str(), (int)pw.size(),
                      reinterpret_cast<const unsigned char*>(salt.data()), (int)salt.size(),
                      iter, EVP_sha256(), 32, out);
    return hex(out, 32);
}

std::string hashPassword(const std::string& password) {
    const int iter = 60000;
    auto salt = randomHex(16);
    return "pbkdf2$" + std::to_string(iter) + "$" + salt + "$" + pbkdf2(password, salt, iter);
}

bool verifyPassword(const std::string& password, const std::string& stored) {
    std::vector<std::string> parts; std::string cur;
    for (char c : stored) { if (c == '$') { parts.push_back(cur); cur.clear(); } else cur += c; }
    parts.push_back(cur);
    if (parts.size() != 4 || parts[0] != "pbkdf2") return false;
    int iter = 0; try { iter = std::stoi(parts[1]); } catch (...) { return false; }
    auto calc = pbkdf2(password, parts[2], iter);
    if (calc.size() != parts[3].size()) return false;
    unsigned char diff = 0;
    for (size_t i = 0; i < calc.size(); ++i) diff |= (unsigned char)(calc[i] ^ parts[3][i]);
    return diff == 0;
}

std::string uuid4() {
    unsigned char b[16];
    if (RAND_bytes(b, 16) != 1) throw std::runtime_error("RAND_bytes failed");
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    auto h = hex(b, 16);
    return h.substr(0,8)+"-"+h.substr(8,4)+"-"+h.substr(12,4)+"-"+h.substr(16,4)+"-"+h.substr(20);
}

} // namespace acerciae::crypto
