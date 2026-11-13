#pragma once
#include <json/json.h>
#include <string>
namespace acerciae::llm {
// Accumulate a bounded SSE response into the provider's non-streamed response object. JSON
// responses are accepted for compatible gateways that ignore stream=true.
Json::Value responsesResponse(const std::string& body);   // OpenAI Responses API
Json::Value anthropicResponse(const std::string& body);
// OpenAI Chat Completions stream: deltas folded into {choices:[{message:{content, tool_calls}, finish_reason}], usage}.
Json::Value chatCompletionsResponse(const std::string& body);
}
