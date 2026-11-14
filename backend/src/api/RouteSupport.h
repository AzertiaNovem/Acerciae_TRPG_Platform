#pragma once
#include "../auth/AuthService.h"
#include "../core/Errors.h"
#include <drogon/drogon.h>

namespace acerciae::http {
using namespace drogon;
using Cb = std::function<void(const HttpResponsePtr&)>;
using Params = std::vector<std::string>;
using Fn = std::function<Json::Value(const HttpRequestPtr&, const Principal&, const Params&)>;

HttpResponsePtr jsonResp(const Json::Value& v, int status = 200);
HttpResponsePtr errResp(int status, const std::string& code, const std::string& msg);
HttpResponsePtr errResp(const ApiError& e);   // {error, message} plus the members of e.details()
std::string bearer(const HttpRequestPtr& req);
std::string attachmentHeader(const std::string& name);
std::string siteOrigin(const HttpRequestPtr& req);
bool mayRedirect(const HttpRequestPtr& req);
HttpResponsePtr redirectTo(const std::string& url, const char* cacheControl);
bool wantsDirect(const HttpRequestPtr& req);
HttpResponsePtr directTo(const std::string& url, bool keep, const char* cacheControl);
HttpResponsePtr toBucket(const HttpRequestPtr& req, const std::string& url, bool keep, const char* cacheControl);
std::string etagOf(const std::string& key);
bool notModified(const HttpRequestPtr& req, const std::string& etag);
HttpResponsePtr notModifiedResponse(const std::string& etag, const std::string& cacheControl);
std::optional<Principal> fileAuth(const HttpRequestPtr& req);
HttpResponsePtr internalErr(const std::exception& e, const HttpRequestPtr& req = nullptr);
std::string clientIp(const HttpRequestPtr& req);
Json::Value body(const HttpRequestPtr& req);
int qint(const HttpRequestPtr& req, const char* k, int def);
int64_t qint64(const HttpRequestPtr& req, const char* k, int64_t def);
void run(const HttpRequestPtr& req, Cb&& cb, const Params& params, const Fn& fn, bool authRequired);
void dispatch(const HttpRequestPtr& req, Cb&& cb, Params params, const Fn& fn, bool auth, bool ai);
void route0(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true);
void route1(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true);
void route2(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true);
void route3(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool auth = true);
void offload(const HttpRequestPtr& req, Cb&& cb, Params params, const Fn& fn);
void ai1(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn, bool queuedWhenAsync = false);
void ai2(const std::string& path, std::vector<drogon::internal::HttpConstraint> m, Fn fn);
ChannelAccess access(const Principal& p, const std::string& channelId);
ChannelAccess studioAccess(const Principal& p, const std::string& channelId);
Json::Value ok();
extern const char* const kKeep;
extern const char* const kDirectType;
}
