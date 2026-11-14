#pragma once
#include <json/value.h>
#include <stdexcept>
#include <string>

namespace acerciae {

// Errors map directly onto HTTP status codes in the API layer. `details` (an object) adds fields to the error body
// next to `error` and `message`, e.g. the JSON paths of an invalid document or a retry delay.
class ApiError : public std::runtime_error {
public:
    ApiError(int status, std::string code, const std::string& msg)
        : std::runtime_error(msg), status_(status), code_(std::move(code)) {}
    ApiError(int status, std::string code, const std::string& msg, Json::Value details)
        : std::runtime_error(msg), status_(status), code_(std::move(code)), details_(std::move(details)) {}
    int status() const { return status_; }
    const std::string& code() const { return code_; }
    const Json::Value& details() const { return details_; }
private:
    int status_;
    std::string code_;
    Json::Value details_;
};

inline ApiError badRequest(const std::string& m)   { return ApiError(400, "bad_request", m); }
inline ApiError unauthorized(const std::string& m) { return ApiError(401, "unauthorized", m); }
inline ApiError forbidden(const std::string& m)    { return ApiError(403, "forbidden", m); }
inline ApiError notFound(const std::string& m)     { return ApiError(404, "not_found", m); }
inline ApiError conflict(const std::string& m)     { return ApiError(409, "conflict", m); }

} // namespace acerciae
