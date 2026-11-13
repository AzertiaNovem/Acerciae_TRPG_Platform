#pragma once
#include "../llm/Llm.h"
#include <string>
#include <vector>

namespace acerciae::ai {
// The vector column holds 1536 dimensions: providers are asked for 1536 where they can be, shorter vectors are padded
// with zeros (which keeps every cosine similarity) and longer ones cut and renormalised (Matryoshka-trained models).
constexpr std::size_t kEmbeddingDimensions = 1536;
// Embeds one text with the endpoint of a server's embedding use: OpenAI-style /embeddings (openai, responses,
// alibaba compatible mode, openrouter), Google embedContent, or Bedrock InvokeModel (Titan v2, Cohere embed).
// Empty on failure (logged); never throws for provider errors.
std::vector<float> embed(const LlmEndpoint& ep, const std::string& text);
std::vector<float> fitDimensions(std::vector<float> v);
}
