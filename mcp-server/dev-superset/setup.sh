#!/usr/bin/env bash
# Stands up a real, running Apache Superset + Postgres, initializes it, and runs
# one real successful query and one real failing query, so verify-live-pattern.ts
# has genuine execution history to read. Bakes in fixes for two real issues hit
# building this: Superset's base image ships with no SQL Lab database driver
# installed at all (psycopg2 has to be installed after the container starts, and
# specifically with --target into the venv's site-packages — a plain `pip install`
# defaults to a --user location the venv's Python never looks at), and Superset's
# CSRF protection needs a session cookie carried alongside the token, not just the
# token header.
#
# Usage: ./setup.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Starting containers..."
docker compose up -d

echo "Waiting for Superset to report healthy..."
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8088/health 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then break; fi
  sleep 2
done

echo "Running database migrations..."
docker exec coreops-dev-superset superset db upgrade > /dev/null

echo "Creating admin user (admin/admin, dev-only)..."
docker exec coreops-dev-superset superset fab create-admin \
  --username admin --firstname Admin --lastname User \
  --email admin@example.com --password admin > /dev/null 2>&1 || true

echo "Running superset init (roles/permissions)..."
docker exec coreops-dev-superset superset init > /dev/null

# Superset ships with zero SQL Lab database drivers pre-installed — even SQLite is
# explicitly blocked as a data source "for security reasons". Installing directly
# with --target into the venv's own site-packages: a plain `pip install` (even as
# root) silently installs to a --user path the venv's python3 never consults, which
# looks like it worked (pip says "Successfully installed") but leaves the module
# unimportable.
echo "Installing the Postgres driver into the running container..."
docker exec -u root coreops-dev-superset pip install \
  --target=/app/.venv/lib/python3.10/site-packages --no-user -q psycopg2-binary

echo "Authenticating..."
RESP=$(curl -s -X POST http://localhost:8088/api/v1/security/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin","provider":"db","refresh":true}')
TOKEN=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

COOKIE_JAR=$(mktemp)
CSRF_RESP=$(curl -s -c "$COOKIE_JAR" http://localhost:8088/api/v1/security/csrf_token/ -H "Authorization: Bearer $TOKEN")
CSRF=$(echo "$CSRF_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])")

echo "Registering the Postgres verify-db as a SQL Lab source..."
curl -s -X POST http://localhost:8088/api/v1/database/ \
  -b "$COOKIE_JAR" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-CSRFToken: $CSRF" \
  -H "Content-Type: application/json" \
  -H "Referer: http://localhost:8088/" \
  -d '{
    "database_name": "coreops-verify",
    "sqlalchemy_uri": "postgresql+psycopg2://verify:verify@verify-db:5432/verify",
    "expose_in_sqllab": true,
    "allow_run_async": false
  }' > /dev/null

echo "Running one real successful query and one real failing query..."
curl -s -X POST http://localhost:8088/api/v1/sqllab/execute/ \
  -b "$COOKIE_JAR" -H "Authorization: Bearer $TOKEN" -H "X-CSRFToken: $CSRF" \
  -H "Content-Type: application/json" -H "Referer: http://localhost:8088/" \
  -d '{"database_id": 1, "sql": "SELECT 1 AS ok", "schema": "public", "runAsync": false}' > /dev/null

curl -s -X POST http://localhost:8088/api/v1/sqllab/execute/ \
  -b "$COOKIE_JAR" -H "Authorization: Bearer $TOKEN" -H "X-CSRFToken: $CSRF" \
  -H "Content-Type: application/json" -H "Referer: http://localhost:8088/" \
  -d '{"database_id": 1, "sql": "SELECT * FROM this_table_does_not_exist", "schema": "public", "runAsync": false}' > /dev/null

rm -f "$COOKIE_JAR"

echo ""
echo "Done. Superset is running at http://localhost:8088 (admin/admin, dev-only)."
echo "Real query history now exists. Run: npx tsx verify-live-pattern.ts"
