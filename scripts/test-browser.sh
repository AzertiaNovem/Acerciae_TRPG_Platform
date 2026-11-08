#!/usr/bin/env bash
# Local-only browser contracts. The caller owns a disposable backend; fixtures use no external AI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export ACERCIAE_NO_DOTENV=1
export API_BASE="${API_BASE:-http://127.0.0.1:18080}"
export ACERCIAE_API_TARGET="$API_BASE"
PREVIEW_PORT="${BROWSER_PORT:-18442}"
DEV_PORT="${BROWSER_DEV_PORT:-18443}"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
(cd "$ROOT/frontend" && exec ./node_modules/.bin/vite preview --host 127.0.0.1 --port "$PREVIEW_PORT" --strictPort > "${TMPDIR:-/tmp}/acerciae-browser-preview.log" 2>&1) &
PIDS+=($!)
(cd "$ROOT/frontend" && exec ./node_modules/.bin/vite --host 127.0.0.1 --port "$DEV_PORT" --strictPort > "${TMPDIR:-/tmp}/acerciae-browser-vite.log" 2>&1) &
PIDS+=($!)
for port in "$PREVIEW_PORT" "$DEV_PORT"; do
  for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$port" >/dev/null 2>&1 && break || sleep 1; done
  curl -fsS "http://127.0.0.1:$port" >/dev/null
done
cd "$ROOT/tests/browser"
for engine in chromium webkit; do
  for suite in desktop-accounts references recall theme pbta pbta-review session-retry; do
    WEB_BASE="http://127.0.0.1:$PREVIEW_PORT" node "$suite.mjs" "$engine"
  done
  WEB_BASE="http://127.0.0.1:$DEV_PORT" node vn-hybrid.mjs "$engine"
done
