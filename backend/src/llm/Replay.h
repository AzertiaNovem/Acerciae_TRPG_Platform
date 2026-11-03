#pragma once
#include <json/json.h>
#include <string>

// Replaying a model's own turn in a later request (a visual-novel part resumed with the user's answers). The turn is
// stored as the provider returned it: Anthropic content blocks, or OpenAI Responses output items. Both may carry the
// model's reasoning in a sealed form (a `thinking` block with its `signature`, a `reasoning` item with its
// `encrypted_content`) that the provider verifies on replay: it must come back byte for byte, from the same model,
// and never be made up or edited. What cannot be verified is left out of the replay; the text of the turn is always
// kept, so the conversation still reads correctly, just without the hidden reasoning.
namespace acerciae::llm {

// The blocks / items to send back as the assistant turn, or null when only the plain text should be replayed
// (another provider than the one that produced the turn, nothing replayable, or an unknown shape).
// `exchange` is {provider, model, content, provider_content}; `provider` and `model` are the endpoint in use now.
Json::Value replayableAssistant(const Json::Value& exchange, const std::string& provider, const std::string& model);

// Whether the replay would carry sealed reasoning (used to decide that a provider's rejection of the replay should
// be retried without the model's turn).
bool carriesReasoning(const Json::Value& replay);

} // namespace acerciae::llm
