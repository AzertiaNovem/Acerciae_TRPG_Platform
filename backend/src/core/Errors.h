#pragma once
#include <stdexcept>
#include <string>

namespace acerciae {

// Errors map directly onto HTTP status codes in the API layer.
class ApiError : public std::runtime_error {
public:
    ApiError(int status, std::string code, const std::string& msg)
        : std::runtime_error(msg), status_(status), code_(std::move(code)) {}
    int status() const { return status_; }
    const std::string& code() const { return code_; }
private:
    int status_;
    std::string code_;
};

inline ApiError badRequest(const std::string& m)   { return ApiError(400, "bad_request", m); }
inline ApiError unauthorized(const std::string& m) { return ApiError(401, "unauthorized", m); }
inline ApiError forbidden(const std::string& m)    { return ApiError(403, "forbidden", m); }
inline ApiError notFound(const std::string& m)     { return ApiError(404, "not_found", m); }
inline ApiError conflict(const std::string& m)     { return ApiError(409, "conflict", m); }

} // namespace acerciae
