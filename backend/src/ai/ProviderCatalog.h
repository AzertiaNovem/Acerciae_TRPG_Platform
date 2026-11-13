#pragma once
#include <json/json.h>
#include <string>
#include <vector>

namespace acerciae::ai {

// The kinds of AI provider a server can add, what each can do, and the fields it needs; and the uses a provider and a
// model are assigned to. A use can only be given a provider whose kind has the use's capability (Stability AI makes
// images, never text or embeddings).
//
// Capabilities: text | embedding | image_generation | image_edit | tts.
// Uses: text (every text task), text_chronicle / text_assist / text_writing (optional overrides for a group of tasks;
// unset = follow text), embedding, image_generation, image_edit (unset = follow image generation), tts.
namespace catalog {
const Json::Value& kinds();                       // [{id, label, capabilities[], default_api_base, fields[], models{capability: [ids]}, notes}]
const Json::Value& uses();                        // [{id, capability, modes[], label}]
const Json::Value* kind(const std::string& id);   // nullptr when unknown
const Json::Value* use(const std::string& id);
bool supports(const std::string& kind, const std::string& capability);
std::string capabilityOf(const std::string& use);
std::string defaultApiBase(const std::string& kind);
// The use whose model runs a text task: its group override when one is set, else "text".
std::string textUseFor(const std::string& task);
}

} // namespace acerciae::ai
