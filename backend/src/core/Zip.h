#pragma once
#include <string>
#include <utility>
#include <vector>

namespace acerciae::zip {
// A minimal ZIP writer (store method, no compression): enough for log exports and visual-novel bundles.
// Files are [{path, bytes}]; paths use forward slashes and must not start with "/".
std::string build(const std::vector<std::pair<std::string, std::string>>& files);
}
