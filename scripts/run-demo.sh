#!/usr/bin/env bash
# Runs the CoreOps guardrail + audit-trail demo end to end, narrated, one beat
# at a time. Single responsibility: drive the live demo sequence documented in
# coreops-demo-steps.md — nothing here builds, deploys, or modifies the repo.
#
# Usage:
#   scripts/run-demo.sh            # interactive: press Enter between beats
#   scripts/run-demo.sh --auto     # hands-free: short pauses instead of Enter
#
# Every beat prints the real command it ran and the real response — nothing
# here is staged or hypothetical. Run it once yourself before presenting so
# the first live run isn't also the first time you've seen the output.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_DIR="$REPO_ROOT/mcp-server"
COOKIE_JAR="$(mktemp)"
CORR_ID_FILE="$(mktemp)"
HOST="http://localhost:8787"
AUTO=false
[[ "${1:-}" == "--auto" ]] && AUTO=true

BOLD=$(tput bold 2>/dev/null || echo "")
DIM=$(tput dim 2>/dev/null || echo "")
GREEN=$(tput setaf 2 2>/dev/null || echo "")
RED=$(tput setaf 1 2>/dev/null || echo "")
BLUE=$(tput setaf 4 2>/dev/null || echo "")
RESET=$(tput sgr0 2>/dev/null || echo "")

beat() {
  echo ""
  echo "${BOLD}${BLUE}── $1 ──${RESET}"
  echo ""
}

pause() {
  if $AUTO; then
    sleep 2.5
  else
    read -r -p "${DIM}press Enter to continue...${RESET}" _
  fi
}

run() {
  echo "${DIM}\$ $*${RESET}"
}

cleanup() {
  rm -f "$COOKIE_JAR" "$CORR_ID_FILE"
}
trap cleanup EXIT

echo "${BOLD}CoreOps — live demo${RESET}"
echo "${DIM}$(date)${RESET}"

# ---------------------------------------------------------------------------
beat "Setup — make sure the server is running"

if curl -s -o /dev/null -w "" "$HOST/health" 2>/dev/null; then
  echo "server already running at $HOST"
else
  run "npm run http &"
  (cd "$MCP_DIR" && npm run http > /tmp/coreops-demo.log 2>&1 &)
  echo -n "waiting for server to come up"
  for _ in $(seq 1 20); do
    if curl -s -o /dev/null "$HOST/health" 2>/dev/null; then
      echo " up."
      break
    fi
    echo -n "."
    sleep 1
  done
fi
curl -s "$HOST/health" | jq .
pause

# ---------------------------------------------------------------------------
beat "Beat 1 — Sign in (proves real auth exists)"

AUTH_USER=$(grep '^AUTH_USERNAME=' "$MCP_DIR/.env" | cut -d= -f2-)
AUTH_PASS=$(grep '^AUTH_PASSWORD=' "$MCP_DIR/.env" | cut -d= -f2-)
run "POST /api/login"
curl -s -c "$COOKIE_JAR" -X POST "$HOST/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$AUTH_USER\",\"password\":\"$AUTH_PASS\"}" | jq .
pause

# ---------------------------------------------------------------------------
beat "Beat 2 — Show the live incident (the evidence)"

run "GET /dmv/exec-requests"
curl -s -b "$COOKIE_JAR" "$HOST/dmv/exec-requests" | jq .
echo ""
echo "${BOLD}Session 61${RESET} — suspended, blocked by session 52. That's the real"
echo "blocking-chain incident the rest of this demo acts on."
pause

# ---------------------------------------------------------------------------
beat "Beat 3 — Propose a remediation (the guardrail blocks it)"

run "POST /api/guardrail/propose"
PROPOSE=$(curl -s -b "$COOKIE_JAR" -X POST "$HOST/api/guardrail/propose")
echo "$PROPOSE" | jq .
ITEM_ID=$(echo "$PROPOSE" | jq -r .itemId)
CORR_ID=$(echo "$PROPOSE" | jq -r .correlationId)
echo "$CORR_ID" > "$CORR_ID_FILE"
echo ""
echo "${RED}${BOLD}BLOCKED${RESET} — real evidence, valid action type, still doesn't run."
echo "Nothing executes without a human explicitly saying yes."
pause

# ---------------------------------------------------------------------------
beat "Beat 4 — Approve it (the human-in-the-loop closes)"

run "POST /api/guardrail/decide"
curl -s -b "$COOKIE_JAR" -X POST "$HOST/api/guardrail/decide" \
  -H "Content-Type: application/json" \
  -d "{\"itemId\":\"$ITEM_ID\",\"decision\":\"approve\"}" | jq .
echo ""
echo "${GREEN}${BOLD}ALLOWED — EXECUTED${RESET} — same action, same evidence, now runs,"
echo "because a real person made the call."
pause

# ---------------------------------------------------------------------------
beat "Beat 5 — Reconstruct the decision by correlation ID (the audit trail)"

run "GET /api/audit?correlationId=$CORR_ID"
curl -s -b "$COOKIE_JAR" "$HOST/api/audit?correlationId=$CORR_ID" | jq .
echo ""
echo "One correlation ID, the whole story: the enqueue, then the decision,"
echo "each timestamped, with the real approver's name."
pause

# ---------------------------------------------------------------------------
beat "Beat 6 — Prove it survives a restart"

echo "Killing the server outright..."
run "pkill -f \"tsx.*httpServer\""
pkill -f "tsx.*httpServer" 2>/dev/null
sleep 1
echo "Restarting..."
run "npm run http &"
(cd "$MCP_DIR" && npm run http > /tmp/coreops-demo.log 2>&1 &)
echo -n "waiting for server to come back up"
for _ in $(seq 1 20); do
  if curl -s -o /dev/null "$HOST/health" 2>/dev/null; then
    echo " up."
    break
  fi
  echo -n "."
  sleep 1
done

echo "Logging in again — a fresh restart means a fresh session:"
run "POST /api/login"
curl -s -c "$COOKIE_JAR" -X POST "$HOST/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$AUTH_USER\",\"password\":\"$AUTH_PASS\"}" > /dev/null

CORR_ID=$(cat "$CORR_ID_FILE")
echo "Re-querying the SAME correlation ID from before the restart:"
run "GET /api/audit?correlationId=$CORR_ID"
curl -s -b "$COOKIE_JAR" "$HOST/api/audit?correlationId=$CORR_ID" | jq .
echo ""
echo "${GREEN}${BOLD}Same two entries, same timestamps.${RESET} The record isn't just in"
echo "memory — it's real evidence that outlives the process itself."
pause

# ---------------------------------------------------------------------------
beat "Beat 7 — The honest failure (optional — a good answer to a question)"

echo "Azure's SQL Server free-tier quota is exhausted this month (renews"
echo "2026-09-01), so this call is *expected* to fail honestly rather than"
echo "silently substitute fixture data and call it real:"
run "GET /api/recommendation"
curl -s -b "$COOKIE_JAR" "$HOST/api/recommendation" | jq .
echo ""
echo "It doesn't guess. It tells you plainly it couldn't get real evidence."

echo ""
echo "${BOLD}Demo complete.${RESET} Server is still running — stop it with:"
echo "  pkill -f \"tsx.*httpServer\""
