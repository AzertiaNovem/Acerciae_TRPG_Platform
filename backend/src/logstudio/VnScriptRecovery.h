#pragma once
#include <json/json.h>
namespace acerciae::logstudio::vnscript {
enum class ChunkReuse { answered, completed, waiting, generate };
// Decisions only. The model orchestrator owns I/O, transaction locks and cancellation.
ChunkReuse chooseChunk(const Json::Value* row, bool requestMatches, bool reusablePrefix);
Json::Value questionsOf(const Json::Value& answer);
}
