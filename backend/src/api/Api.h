#pragma once
namespace acerciae {
// Registers every HTTP route on the Drogon app. Routes are thin: parse → authorise → service → JSON.
void registerRoutes();
}
