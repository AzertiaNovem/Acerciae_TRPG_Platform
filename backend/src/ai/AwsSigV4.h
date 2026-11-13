#pragma once
#include <string>
#include <utility>
#include <vector>

namespace acerciae::ai::aws {

// AWS Signature Version 4 for a single HTTPS request (Bedrock runtime signs as service "bedrock", Polly as "polly").
struct Credentials { std::string accessKeyId, secretAccessKey, sessionToken, region; };
struct Request {
    std::string method = "POST";
    std::string host;                 // e.g. bedrock-runtime.us-east-1.amazonaws.com
    std::string path = "/";           // as sent on the wire (already percent-encoded once)
    std::string query;                // canonical query string ("" when none)
    std::vector<std::pair<std::string, std::string>> headers;   // extra headers to sign (content-type, accept, …)
    std::string body;
};
// The canonical URI of a non-S3 service: every path segment percent-encoded once more (Bedrock model ids carry ':').
std::string canonicalPath(const std::string& wirePath);
// RFC 3986 encoding of everything but A-Z a-z 0-9 - . _ ~ (uppercase hex).
std::string uriEncode(const std::string& s, bool keepSlash = false);
// The headers to send: the request's own, plus Host, X-Amz-Date, X-Amz-Security-Token (temporary credentials) and
// Authorization. amzDate: YYYYMMDDTHHMMSSZ (now when empty).
std::vector<std::string> sign(const Request& req, const Credentials& creds, const std::string& service, std::string amzDate = "");
// Internals exposed for the test vectors.
std::string canonicalRequest(const Request& req, const std::vector<std::pair<std::string, std::string>>& signedHeaders, std::string* signedNames);
std::string signature(const std::string& secret, const std::string& date, const std::string& region, const std::string& service, const std::string& stringToSign);

} // namespace acerciae::ai::aws
