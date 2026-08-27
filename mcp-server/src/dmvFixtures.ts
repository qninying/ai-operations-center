export interface DmvExecRequestRow {
  session_id: number;
  status: string;
  command: string;
  wait_type: string | null;
  blocking_session_id: number;
  cpu_time_ms: number;
  total_elapsed_time_ms: number;
  database_name: string;
}

// STUB: fixture data standing in for a live `sys.dm_exec_requests` query.
// Swap for a real mssql/tedious query behind the same shape when a target
// SQL Server instance + read-only credentials are available.
//
// Deliberately models 4 distinct real DBA situations, not just one blocking
// pair — see docs/ADR-010-sql-remediation-safety.md and
// sqlRemediationSafety.ts. Each is independently assessed by
// assessBlockingSessionRemediation() when its incident's Fix is clicked:
//   - 61 blocked by 52: routine, short block — safe to auto-remediate.
//   - 84 blocked by 71: 71 has been running 32 minutes — a real DBA
//     investigates a long-running transaction before killing it, doesn't
//     kill it blind.
//   - 103 blocked by 6: session 6 is a SQL Server system session (id <= 50)
//     — never safe to automate, could break an internal server process.
//   - 130 -> 118 -> 95: a genuine 3-link blocking chain. Killing 118 (the
//     immediate blocker of 130) wouldn't fix anything, since 118 is itself
//     blocked by 95 — the real root cause is further up the chain, exactly
//     the kind of blocking-chain-vs-single-blocker distinction a working
//     DBA has to make before acting.
export const dmExecRequestsFixture: DmvExecRequestRow[] = [
  { session_id: 52, status: "running", command: "SELECT", wait_type: null, blocking_session_id: 0, cpu_time_ms: 1200, total_elapsed_time_ms: 1450, database_name: "OpsWarehouse" },
  { session_id: 61, status: "suspended", command: "UPDATE", wait_type: "LCK_M_X", blocking_session_id: 52, cpu_time_ms: 40, total_elapsed_time_ms: 8600, database_name: "OpsWarehouse" },
  { session_id: 77, status: "runnable", command: "SELECT INTO", wait_type: "PAGEIOLATCH_SH", blocking_session_id: 0, cpu_time_ms: 300, total_elapsed_time_ms: 900, database_name: "StagingETL" },
  { session_id: 71, status: "running", command: "MERGE", wait_type: null, blocking_session_id: 0, cpu_time_ms: 620000, total_elapsed_time_ms: 1_920_000, database_name: "OpsWarehouse" },
  { session_id: 84, status: "suspended", command: "UPDATE", wait_type: "LCK_M_U", blocking_session_id: 71, cpu_time_ms: 55, total_elapsed_time_ms: 42000, database_name: "OpsWarehouse" },
  { session_id: 6, status: "background", command: "LOG WRITER", wait_type: null, blocking_session_id: 0, cpu_time_ms: 0, total_elapsed_time_ms: 0, database_name: "master" },
  { session_id: 103, status: "suspended", command: "INSERT", wait_type: "LCK_M_IX", blocking_session_id: 6, cpu_time_ms: 12, total_elapsed_time_ms: 3400, database_name: "OpsWarehouse" },
  { session_id: 95, status: "running", command: "SELECT INTO", wait_type: null, blocking_session_id: 0, cpu_time_ms: 8000, total_elapsed_time_ms: 15000, database_name: "StagingETL" },
  { session_id: 118, status: "suspended", command: "UPDATE", wait_type: "LCK_M_X", blocking_session_id: 95, cpu_time_ms: 200, total_elapsed_time_ms: 9800, database_name: "StagingETL" },
  { session_id: 130, status: "suspended", command: "SELECT", wait_type: "LCK_M_S", blocking_session_id: 118, cpu_time_ms: 10, total_elapsed_time_ms: 6000, database_name: "StagingETL" },
];
