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
export const dmExecRequestsFixture: DmvExecRequestRow[] = [
  { session_id: 52, status: "running", command: "SELECT", wait_type: null, blocking_session_id: 0, cpu_time_ms: 1200, total_elapsed_time_ms: 1450, database_name: "OpsWarehouse" },
  { session_id: 61, status: "suspended", command: "UPDATE", wait_type: "LCK_M_X", blocking_session_id: 52, cpu_time_ms: 40, total_elapsed_time_ms: 8600, database_name: "OpsWarehouse" },
  { session_id: 77, status: "runnable", command: "SELECT INTO", wait_type: "PAGEIOLATCH_SH", blocking_session_id: 0, cpu_time_ms: 300, total_elapsed_time_ms: 900, database_name: "StagingETL" },
];
