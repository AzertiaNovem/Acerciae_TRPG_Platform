#pragma once
#include <json/json.h>
#include <map>
#include <string>

namespace acerciae::ai {

// A server's provider with its secrets unsealed, for the length of one call. Never logged, never returned to clients.
struct ProviderAccess {
    std::string id, name, kind;
    std::string apiBase;                         // the configured endpoint, else the kind's default ({region} filled in)
    std::string apiKey;                          // the kind's main secret
    Json::Value options = Json::Value(Json::objectValue);   // the kind's plain fields (region, access_key_id, …)
    std::map<std::string, std::string> secrets;  // the kind's other secrets (session_token, speech_access_token, …)
    std::string option(const std::string& key, const std::string& fallback = "") const {
        return options.isMember(key) && options[key].isString() && !options[key].asString().empty() ? options[key].asString() : fallback;
    }
    std::string secret(const std::string& key) const { auto it = secrets.find(key); return it == secrets.end() ? "" : it->second; }
};

// What a use resolves to: a provider and model, the built-in mock, or nothing. Inherited uses are already followed.
struct UseConfig {
    std::string use;
    std::string mode = "disabled";               // provider | mock | disabled
    ProviderAccess provider;                     // mode == provider
    std::string model;
    Json::Value options = Json::Value(Json::objectValue);    // reasoning_effort; size, quality; voice
    bool live() const { return mode == "provider"; }
    std::string option(const std::string& key, const std::string& fallback = "") const {
        return options.isMember(key) && options[key].isString() && !options[key].asString().empty() ? options[key].asString() : fallback;
    }
};

} // namespace acerciae::ai
