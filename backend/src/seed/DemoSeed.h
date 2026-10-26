#pragma once
#include "../app/Services.h"
#include <json/json.h>
#include <string>
#include <vector>

namespace acerciae {
// Builds a complete demonstration campaign through the real services so that every message becomes an
// event, every event is observed by the AI, and the documents/highlights are produced by the pipeline.
// Users: keeper / alice / bob / carol — password "password".
struct DemoSeed {
    static bool run(Services& s, bool force);
    static std::vector<std::string> demoModulePages();
};
}
