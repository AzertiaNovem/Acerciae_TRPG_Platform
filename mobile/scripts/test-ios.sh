#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
swift test --package-path "$ROOT/mobile/ios/AcerciaeCore"
# Use an isolated simulator and delete it even when a test fails.
DEVICE_JSON="$(xcrun simctl list devices available --json)"
read -r RUNTIME DEVICE_TYPE < <(printf '%s' "$DEVICE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next((r+" "+x["deviceTypeIdentifier"] for r in sorted(d,reverse=True) for x in d[r] if "iPhone" in x["name"])))')
SIMULATOR="$(xcrun simctl create "Acerciae checks $$" "$DEVICE_TYPE" "$RUNTIME")"
trap 'xcrun simctl shutdown "$SIMULATOR" >/dev/null 2>&1 || true; xcrun simctl delete "$SIMULATOR"' EXIT
xcodebuild -project "$ROOT/mobile/ios/Acerciae.xcodeproj" -scheme Acerciae -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIMULATOR" -parallel-testing-enabled NO \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
