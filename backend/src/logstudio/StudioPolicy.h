#pragma once
#include "../core/Db.h"
#include "../core/Errors.h"
namespace acerciae::logstudio {
inline void requireCloudPermission(Db &db, const std::string &channel) {
  auto row = db.queryOne(
      "SELECT studio_cloud_allowed FROM channels WHERE id=$1", {channel});
  if (row.isNull() || !row["studio_cloud_allowed"].asBool())
    throw forbidden("Log Studio cloud processing is disabled for this "
                    "campaign; the GM can enable it in Library settings");
}
} // namespace acerciae::logstudio
