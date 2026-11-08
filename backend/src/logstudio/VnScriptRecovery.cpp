#include "VnScriptRecovery.h"
#include "VnScriptInternals.h"
#include "../core/Json.h"
namespace acerciae::logstudio::vnscript {
ChunkReuse chooseChunk(const Json::Value* row, bool requestMatches, bool reusablePrefix) {
    if (!row) return ChunkReuse::generate;
    if ((*row)["answers"].isObject()) return ChunkReuse::answered;
    if (!requestMatches || !reusablePrefix) return ChunkReuse::generate;
    if ((*row)["questions"].isNull() && (*row)["response"]["script"].isArray()) return ChunkReuse::completed;
    if ((*row)["questions"].isObject()) return ChunkReuse::waiting;
    return ChunkReuse::generate;
}
Json::Value questionsOf(const Json::Value &ans) {
      Json::Value q(Json::arrayValue);
      for (const auto &x : ans["questions"]) {
        if (!x.isObject() || q.size() >= 5) continue;
        auto text = clip(json::str(x, "question"), 600);
        if (text.empty()) continue;
        Json::Value y; y["id"] = clip(json::str(x, "id", "q" + std::to_string(q.size() + 1)), 24); y["question"] = text;
        y["refs"] = Json::Value(Json::arrayValue); for (const auto &r : x["refs"]) if (r.isString() && y["refs"].size() < 8) y["refs"].append(clip(r.asString(), 12));
        y["options"] = Json::Value(Json::arrayValue); for (const auto &o : x["options"]) if (o.isString() && y["options"].size() < 6) y["options"].append(clip(o.asString(), 200));
        q.append(y);
      }
      return q;
    }
}
