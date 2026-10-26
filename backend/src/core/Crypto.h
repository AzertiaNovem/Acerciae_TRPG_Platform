#pragma once
#include <string>

namespace acerciae::crypto {
std::string randomHex(std::size_t bytes);
std::string sha256Hex(const std::string& data);
std::string hmacSha256Hex(const std::string& key, const std::string& data);
std::string hashPassword(const std::string& password);               // pbkdf2$iter$salt$hash
bool verifyPassword(const std::string& password, const std::string& stored);
std::string uuid4();
} // namespace acerciae::crypto
