#pragma once
#include <json/json.h>
#include <string>
namespace acerciae::llm {
// Accumulate a bounded SSE response into the existing completion contract. JSON
// responses are accepted for compatible gateways that ignore stream=true.
Json::Value openAiResponse(const std::string& body);
Json::Value anthropicResponse(const std::string& body);
}
