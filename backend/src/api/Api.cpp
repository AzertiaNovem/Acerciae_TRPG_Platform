#include "Api.h"
#include "Routes.h"

namespace acerciae {
void registerRoutes() {
    http::registerAuthRoutes();
    http::registerChannelRoutes();
    http::registerCharacterRoutes();
    http::registerKnowledgeRoutes();
    http::registerStudioRoutes();
    http::registerMediaRoutes();
    http::registerCors();
}
}
