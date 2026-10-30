#pragma once
#include <json/json.h>
#include <string>
namespace acerciae::llm {
// Accumulate a bounded SSE response into the provider's non-streamed response object. JSON
// responses are accepted for compatible gateways that ignore stream=true.
Json::Value responsesResponse(const std::string& body);   // OpenAI Responses API
Json::Value anthropicResponse(const std::string& body);
}
