#pragma once
#include "LogModel.h"
#include <memory>

namespace acerciae::logstudio {

// External format adapter. detect() must be cheap; parse() must never drop messages — unrecognised
// material is kept as `unrecognised` events with raw_text and reported in issues.
class LogAdapter {
public:
    virtual ~LogAdapter() = default;
    virtual std::string name() const = 0;
    virtual std::string supportedVersions() const = 0;
    virtual bool detect(const std::string& text) const = 0;
    virtual ParsedLog parse(const std::string& text) const = 0;
    virtual std::string exportText(const std::vector<LogEvent>& events) const { (void)events; return ""; }
};

std::unique_ptr<LogAdapter> makeNativeJsonAdapter();
std::unique_ptr<LogAdapter> makeSealDiceJsonAdapter();
std::unique_ptr<LogAdapter> makeSealDiceTextAdapter();
std::unique_ptr<LogAdapter> makeRenderedLogAdapter();
std::unique_ptr<LogAdapter> makeQQExportAdapter();

// Registry: tries adapters in order (explicit name wins, otherwise auto-detect).
class AdapterRegistry {
public:
    AdapterRegistry();
    const LogAdapter* byName(const std::string& name) const;
    const LogAdapter* detect(const std::string& text) const;
    std::vector<const LogAdapter*> all() const;
private:
    std::vector<std::unique_ptr<LogAdapter>> adapters_;
};

// Native JSON export (schemaVersion 1.0) and plain-text export.
Json::Value toNativeJson(const std::vector<LogEvent>& events, const Json::Value& meta);
std::string toPlainText(const std::vector<LogEvent>& events);

} // namespace acerciae::logstudio
