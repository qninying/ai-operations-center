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
// Deliberately models 2 distinct real DBA situations, not just one blocking
// pair — see docs/ADR-010-sql-remediation-safety.md and
// sqlRemediationSafety.ts. Each is independently assessed by
// assessBlockingSessionRemediation() when its incident's Fix is clicked:
//   - 61 blocked by 52: routine, short block — safe to auto-remediate.
//   - 84 blocked by 71: 71 has been running 32 minutes — a real DBA
//     investigates a long-running transaction before killing it, doesn't
//     kill it blind.
// Trimmed 2026-08-27 from an earlier 4-scenario set (system-session and
// chained-blocker cases also existed) to keep the demo incident list
// shorter — those two rules are still covered by sqlRemediationSafety.ts's
// own unit tests, just no longer represented as a live dashboard incident.
export const dmExecRequestsFixture: DmvExecRequestRow[] = [
  { session_id: 52, status: "running", command: "SELECT", wait_type: null, blocking_session_id: 0, cpu_time_ms: 1200, total_elapsed_time_ms: 1450, database_name: "OpsWarehouse" },
  { session_id: 61, status: "suspended", command: "UPDATE", wait_type: "LCK_M_X", blocking_session_id: 52, cpu_time_ms: 40, total_elapsed_time_ms: 8600, database_name: "OpsWarehouse" },
  { session_id: 77, status: "runnable", command: "SELECT INTO", wait_type: "PAGEIOLATCH_SH", blocking_session_id: 0, cpu_time_ms: 300, total_elapsed_time_ms: 900, database_name: "StagingETL" },
  { session_id: 71, status: "running", command: "MERGE", wait_type: null, blocking_session_id: 0, cpu_time_ms: 620000, total_elapsed_time_ms: 1_920_000, database_name: "OpsWarehouse" },
  { session_id: 84, status: "suspended", command: "UPDATE", wait_type: "LCK_M_U", blocking_session_id: 71, cpu_time_ms: 55, total_elapsed_time_ms: 42000, database_name: "OpsWarehouse" },
];
