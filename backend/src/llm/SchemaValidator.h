#pragma once
#include <json/json.h>
#include <string>
#include <vector>

namespace acerciae {
// Minimal JSON Schema (draft-07 subset) validator: type, properties, required, items, enum,
// minimum/maximum, minLength/maxLength, minItems/maxItems, additionalProperties(bool), oneOf/anyOf (first match).
class SchemaValidator {
public:
    static bool validate(const Json::Value& schema, const Json::Value& value, std::vector<std::string>& errors, const std::string& path = "$");
    static std::string errorsToString(const std::vector<std::string>& errors);
};
}
