import type { PgActivityRow } from "./pgActivitySource.js";

// See docs/ADR-013-real-postgres-remediation.md for the full decision record.
//
// Real DBA judgment for Postgres, mirroring sqlRemediationSafety.ts's exact
// three-rule shape — translated to Postgres's own real system-view semantics,
// not copy-pasted. Pure and deterministic — no I/O, no LLM call — this gates
// whether kill_postgres_backend is even offered as an option.
//
// Three rules, each a real, well-known Postgres DBA practice: a system
// backend is never touched, a long-running query is investigated rather than
// killed blind, and a chained blocker means the real root cause is further
// up the chain, not this backend.

const LONG_RUNNING_THRESHOLD_MS = 5 * 60_000; // 5 minutes

export interface RemediationSafetyResult {
  safe: boolean;
  reason: string;
}

export function assessPostgresRemediation(pid: number, allRows: PgActivityRow[]): RemediationSafetyResult {
  const blocker = allRows.find((row) => row.pid === pid);
  if (!blocker) {
    return {
      safe: false,
      reason: `No evidence found for backend ${pid} — cannot assess whether terminating it is safe.`,
    };
  }

  if (blocker.backend_type !== "client backend") {
    return {
      safe: false,
      reason: `Backend ${blocker.pid} is a Postgres system process (${blocker.backend_type}), not a client query — terminating it risks breaking autovacuum, replication, or an internal server process. Never automated.`,
    };
  }

  const elapsedMs = Date.now() - new Date(blocker.query_start).getTime();
  if (elapsedMs > LONG_RUNNING_THRESHOLD_MS) {
    const minutes = Math.round(elapsedMs / 60_000);
    return {
      safe: false,
      reason: `Backend ${blocker.pid} has been running for ${minutes} minutes — likely a large, legitimate transaction. Terminating it would force an expensive rollback. Recommend manual review, not automated remediation.`,
    };
  }

  if (blocker.blocked_by.length > 0) {
    return {
      safe: false,
      reason: `Backend ${blocker.pid} is itself blocked by backend ${blocker.blocked_by[0]} — this is a blocking chain, not a single blocker. Terminating backend ${blocker.pid} won't resolve the root cause. Investigate backend ${blocker.blocked_by[0]} instead.`,
    };
  }

  return {
    safe: true,
    reason: `Backend ${blocker.pid} is a routine client query with a short hold time and no upstream blocker — safe to terminate.`,
  };
}
