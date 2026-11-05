#pragma once
#include "ObjectStore.h"
#include "../core/Db.h"

namespace acerciae::logstudio {
std::shared_ptr<ObjectStore> trackedObjectStore(std::shared_ptr<ObjectStore> store, Db& db);
// Inventory each configured physical backend. Existing hashes avoid downloading unchanged immutable objects.
int reconcileObjectInventory(Db& db, RoutingObjectStore& store, const std::function<bool()>& stopping);
}
