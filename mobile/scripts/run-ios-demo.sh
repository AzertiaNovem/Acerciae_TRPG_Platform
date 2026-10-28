#!/usr/bin/env bash
set -euo pipefail
MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-17

# Only select a runtime that actually supports a conventional iPhone 17.
SIMULATOR_ID="$(python3 - "$DEVICE_TYPE" <<'PY'
import json, subprocess, sys
device_type = sys.argv[1]
def sim(*args):
    return subprocess.check_output(['xcrun', 'simctl', *args], text=True)
runtimes = [r for r in json.loads(sim('list', 'runtimes', '-j'))['runtimes']
            if r.get('isAvailable') and any(d['identifier'] == device_type for d in r.get('supportedDeviceTypes', []))]
if not runtimes:
    sys.exit('No compatible iPhone 17 runtime. Install a supported iOS runtime in Xcode Settings > Components.')
runtime = max(runtimes, key=lambda r: tuple(map(int, r['version'].split('.'))))
devices = json.loads(sim('list', 'devices', '-j'))['devices'].get(runtime['identifier'], [])
device = next((d for d in devices if d['name'] == 'Acerciae iPhone 17' and d.get('isAvailable')
               and d.get('deviceTypeIdentifier') == device_type), None)
print(device['udid'] if device else sim('create', 'Acerciae iPhone 17', device_type, runtime['identifier']).strip())
PY
)"
xcodebuild -project "$MOBILE_DIR/ios/Acerciae.xcodeproj" -scheme Acerciae \
  -destination "platform=iOS Simulator,id=$SIMULATOR_ID" \
  -derivedDataPath "$MOBILE_DIR/ios/DerivedData" CODE_SIGNING_ALLOWED=NO build
if ! xcrun simctl list devices booted -j | python3 -c 'import json,sys; target=sys.argv[1]; sys.exit(0 if any(d["udid"]==target for group in json.load(sys.stdin)["devices"].values() for d in group) else 1)' "$SIMULATOR_ID"; then
  xcrun simctl boot "$SIMULATOR_ID"
fi
xcrun simctl bootstatus "$SIMULATOR_ID" -b
xcrun simctl install "$SIMULATOR_ID" "$MOBILE_DIR/ios/DerivedData/Build/Products/Debug-iphonesimulator/Acerciae.app"
xcrun simctl launch "$SIMULATOR_ID" app.acerciae.mobile
printf 'Demo launched on Acerciae iPhone 17 (%s). Select it in Xcode Device Hub or Simulator.\n' "$SIMULATOR_ID"
