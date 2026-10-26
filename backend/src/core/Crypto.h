#pragma once
#include <string>

namespace acerciae::crypto {
std::string randomHex(std::size_t bytes);
std::string sha256Hex(const std::string& data);
std::string hmacSha256Hex(const std::string& key, const std::string& data);
std::string hashPassword(const std::string& password);               // pbkdf2$iter$salt$hash
bool verifyPassword(const std::string& password, const std::string& stored);
std::string uuid4();
// Secrets at rest (per-server API keys): AES-256-GCM under a key derived from `masterSecret`.
// Output is "v1:" + hex(iv | tag | ciphertext). openSecret throws on tampering or a wrong key.
std::string sealSecret(const std::string& masterSecret, const std::string& plaintext);
std::string openSecret(const std::string& masterSecret, const std::string& sealed);
} // namespace acerciae::crypto
