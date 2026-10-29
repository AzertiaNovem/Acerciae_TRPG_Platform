#!/usr/bin/env bash
# Runs every test layer against a local PostgreSQL. Usage: scripts/test.sh [postgres-superuser-url]
# Requires: built backend (backend/build), Node 22.13+, psql, openssl. Creates/wipes databases acerciae_test and
# acerciae_e2e. The Log Studio suite needs the PDF worker and a Chromium/Chrome: set CHROMIUM_PATH, or it is looked up
# (chromium, chromium-browser, google-chrome); without one that suite is skipped with a notice.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG="${1:-postgresql://postgres@localhost:5432/postgres}"
PGBASE="${PG%/*}"
PORT="${E2E_PORT:-18080}"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

echo "== unit tests"; "$ROOT/backend/build/unit_tests"
echo "== database tests"; psql "$PG" -q -c "DROP DATABASE IF EXISTS acerciae_test" -c "CREATE DATABASE acerciae_test"
(cd "$ROOT/backend" && TEST_DATABASE_URL="$PGBASE/acerciae_test" ./build/db_tests)

echo "== end-to-end (HTTP + WebSocket)"
psql "$PG" -q -c "DROP DATABASE IF EXISTS acerciae_e2e" -c "CREATE DATABASE acerciae_e2e"
WORKER_TOKEN="$(openssl rand -hex 32)"
# Strict mode: a nested database transaction fails the request instead of risking a pool deadlock. The provider suites
# talk to local protocol fixtures, hence private endpoints.
(cd "$ROOT/backend" && exec env AUTH_SECRET="$(openssl rand -hex 32)" PDF_WORKER_TOKEN="$WORKER_TOKEN" ACERCIAE_STRICT_DB=1 AI_ALLOW_PRIVATE_ENDPOINTS=true \
  AUTH_REGISTER_PER_HOUR=100000 DATABASE_URL="$PGBASE/acerciae_e2e" HTTP_PORT=$PORT MIGRATIONS_DIR=./migrations \
  UPLOAD_DIR="${TMPDIR:-/tmp}/acerciae-e2e-uploads" SEED_DEMO=false AI_OBSERVER_INTERVAL_MS=2000 \
  ./build/acerciae-server > "${TMPDIR:-/tmp}/acerciae-e2e.log" 2>&1) &
PIDS+=($!)
for i in $(seq 1 30); do curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done

SUITES=$(cd "$ROOT/tests/integration" && ls *.test.mjs)
CHROME="${CHROMIUM_PATH:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}"
if [ -n "$CHROME" ]; then
  (cd "$ROOT/pdf-worker" && [ -d node_modules ] || npm --prefix "$ROOT/pdf-worker" ci --silent)
  (cd "$ROOT/pdf-worker" && exec env API_BASE="http://127.0.0.1:$PORT" PDF_WORKER_TOKEN="$WORKER_TOKEN" CHROMIUM_PATH="$CHROME" \
    node src/index.mjs > "${TMPDIR:-/tmp}/acerciae-pdf-worker.log" 2>&1) &
  PIDS+=($!)
else
  echo "   no Chromium/Chrome found: skipping logstudio.test.mjs (set CHROMIUM_PATH to run it)"
  SUITES=$(echo "$SUITES" | grep -v '^logstudio.test.mjs$')
fi
(cd "$ROOT/tests/integration" && [ -d node_modules ] || npm --prefix "$ROOT/tests/integration" ci --silent)
# shellcheck disable=SC2086
(cd "$ROOT/tests/integration" && API_BASE="http://localhost:$PORT" node --test --test-concurrency=1 --test-timeout=300000 $SUITES)
# Every server the suites built (chat, dice, Log Studio, speech, PDFs, …) must be deletable: deletion relies on the
# schema cascading from servers and channels.
echo "== every server deletes cleanly"
psql "$PGBASE/acerciae_e2e" -q -v ON_ERROR_STOP=1 -c "BEGIN" -c "DELETE FROM servers" -c "SELECT 'left: ' || ((SELECT count(*) FROM channels) + (SELECT count(*) FROM messages) + (SELECT count(*) FROM media_assets))" -c "ROLLBACK"

echo "== gm-agent tests"; (cd "$ROOT/gm-agent" && [ -d node_modules ] || npm ci --silent) && (cd "$ROOT/gm-agent" && npm test --silent)
echo "== pdf worker tests"; (cd "$ROOT/pdf-worker" && [ -d node_modules ] || npm ci --silent) && (cd "$ROOT/pdf-worker" && npm test --silent)
echo "== frontend typecheck, tests and build"
(cd "$ROOT/frontend" && [ -d node_modules ] || npm ci --silent)
(cd "$ROOT/frontend" && npx tsc --noEmit && npm test --silent && npm run build --silent)
echo "ALL GREEN"
