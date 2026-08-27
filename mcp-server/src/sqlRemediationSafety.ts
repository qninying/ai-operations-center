import type { DmvExecRequestRow } from "./dmvFixtures.js";

// See docs/ADR-010-sql-remediation-safety.md for the full decision record.
//
// Real DBA judgment, not a generic mapping: decides whether killing a SQL
// Server blocking session is safe to automate, using the same reasoning a
// working DBA applies before running KILL on a real production server. Pure
// and deterministic — no I/O, no LLM call — this is the one recommendation
// step in the whole system that is genuinely never AI-decided, because it
// gates whether `kill_blocking_session` (a real, newly-allowed but real
// production write) is even offered as an option.
//
// Three rules, each a real, well-known DBA practice, not invented loosely:
// system sessions are never touched, a long-running blocker is investigated
// rather than killed blind, and a chained blocker is a sign the real root
// cause is further up the chain, not this session.

const SYSTEM_SESSION_MAX_ID = 50;
const LONG_RUNNING_THRESHOLD_MS = 5 * 60_000; // 5 minutes

export interface RemediationSafetyResult {
  safe: boolean;
  reason: string;
}

export function assessBlockingSessionRemediation(
  sessionId: number,
  allRows: DmvExecRequestRow[]
): RemediationSafetyResult {
  const blocker = allRows.find((row) => row.session_id === sessionId);
  if (!blocker) {
    return {
      safe: false,
      reason: `No evidence found for session ${sessionId} — cannot assess whether killing it is safe.`,
    };
  }

  if (blocker.session_id <= SYSTEM_SESSION_MAX_ID) {
    return {
      safe: false,
      reason: `Session ${blocker.session_id} is a SQL Server system session (id ≤ ${SYSTEM_SESSION_MAX_ID}) — killing it risks breaking replication or an internal server process. Never automated.`,
    };
  }

  if (blocker.total_elapsed_time_ms > LONG_RUNNING_THRESHOLD_MS) {
    const minutes = Math.round(blocker.total_elapsed_time_ms / 60_000);
    return {
      safe: false,
      reason: `Session ${blocker.session_id} has been running for ${minutes} minutes — likely a large, legitimate transaction. Killing it would force an expensive rollback. Recommend manual review, not automated remediation.`,
    };
  }

  if (blocker.blocking_session_id !== 0) {
    return {
      safe: false,
      reason: `Session ${blocker.session_id} is itself blocked by session ${blocker.blocking_session_id} — this is a blocking chain, not a single blocker. Killing session ${blocker.session_id} won't resolve the root cause. Investigate session ${blocker.blocking_session_id} instead.`,
    };
  }

  return {
    safe: true,
    reason: `Session ${blocker.session_id} is a routine user session with a short hold time and no upstream blocker — safe to kill.`,
  };
}
