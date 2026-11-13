#pragma once
#include "../llm/HttpTransport.h"
#include <string>
#include <vector>

namespace acerciae::ai::http {

using Result = llm::HttpResult;
// POST through the AI transport (endpoint guard, retries on 429/5xx, one overall deadline). Any body and content type.
Result post(const std::string& url, const std::vector<std::string>& headers, const std::string& body, long timeoutMs, std::size_t maxBytes = 32u * 1024 * 1024);
// One POST through the endpoint guard, no retries: for jobs that retry on their own schedule (images, speech).
Result postOnce(const std::string& url, const std::vector<std::string>& headers, const std::string& body, long timeoutMs, std::size_t maxBytes = 32u * 1024 * 1024);
struct FilePart { std::string field, filename, mime, bytes; };
// multipart/form-data POST through the endpoint guard (no retries: uploads are not repeated blindly).
Result postMultipart(const std::string& url, const std::vector<std::string>& headers, const std::vector<std::pair<std::string, std::string>>& fields,
                     const std::vector<FilePart>& files, long timeoutMs, std::size_t maxBytes = 32u * 1024 * 1024);
// GET through the endpoint guard (results some providers hand back as a URL).
Result get(const std::string& url, const std::vector<std::string>& headers, long timeoutMs, std::size_t maxBytes = 64u * 1024 * 1024);
std::string joinUrl(std::string base, const std::string& path);   // base without trailing '/', then path
// Host of an https URL ("" when it has none).
std::string hostOf(const std::string& url);
std::string pathOf(const std::string& url);   // the path part ("/" when none)
// A model path ("models/gemini-embedding-001") with each segment percent-encoded, slashes kept.
std::string uriPath(const std::string& path);

} // namespace acerciae::ai::http
