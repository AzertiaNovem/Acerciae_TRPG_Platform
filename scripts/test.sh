#!/usr/bin/env bash
# Runs every test layer against a local PostgreSQL. Usage: scripts/test.sh [postgres-superuser-url]
# Requires: built backend (backend/build), node 20+, psql. Creates/wipes databases acerciae_test and acerciae_e2e.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG="${1:-postgresql://postgres@localhost:5432/postgres}"
PGBASE="${PG%/*}"
echo "== unit tests"; "$ROOT/backend/build/unit_tests"
echo "== database tests"; psql "$PG" -q -c "DROP DATABASE IF EXISTS acerciae_test" -c "CREATE DATABASE acerciae_test"
(cd "$ROOT/backend" && TEST_DATABASE_URL="$PGBASE/acerciae_test" ./build/db_tests)
echo "== end-to-end scenarios"; psql "$PG" -q -c "DROP DATABASE IF EXISTS acerciae_e2e" -c "CREATE DATABASE acerciae_e2e"
PORT=18080
cd "$ROOT/backend"
DATABASE_URL="$PGBASE/acerciae_e2e" HTTP_PORT=$PORT MIGRATIONS_DIR=./migrations UPLOAD_DIR=/tmp/acerciae-e2e-uploads SEED_DEMO=false AI_OBSERVER_INTERVAL_MS=2000 IMAGE_PROVIDER=mock TTS_PROVIDER=mock ./build/acerciae-server > /tmp/acerciae-e2e.log 2>&1 &
SERVER_PID=$!
cd "$ROOT"
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
(cd "$ROOT/tests/integration" && [ -d node_modules ] || npm install --silent)
(cd "$ROOT/tests/integration" && API_BASE="http://localhost:$PORT" node --test --test-timeout=60000 scenarios.test.mjs reminders.test.mjs script-knowledge.test.mjs ai-providers.test.mjs character-space.test.mjs knowledge-groups.test.mjs vnscript.test.mjs profile.test.mjs)
echo "== frontend typecheck"; (cd "$ROOT/frontend" && [ -d node_modules ] || npm install --silent) && (cd "$ROOT/frontend" && npx tsc --noEmit)
echo "ALL GREEN"
