import pg from "pg";
import { readPgDemoConfig } from "./pgActivitySource.js";
import { withReliability } from "./reliability/withReliability.js";
import { CircuitBreaker } from "./reliability/circuitBreaker.js";

// Real, targeted lookup for the check_postgres_backend_blocked MCP tool: given
// one real backend pid, is it currently blocked, and by what? Deliberately a
// single-row, parameterized query -- not a reuse of pgActivitySource.ts's own
// unfiltered ACTIVITY_QUERY -- so the pid a caller (or a model, through the
// tool) supplies is always a real BOUND parameter, never string-built into the
// query text. Same parameter-binding discipline the one real write in this
// codebase (pgRemediationExecutor.ts) already follows; this is the read-only
// equivalent for a single lookup.

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;

// A separate breaker instance from pgActivitySource.ts's/dockerExecutor.ts's own
// -- an unrelated call path, its failures must never trip or be blocked by theirs.
const backendStatusCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
});

// Pooled, not a fresh Client per call (unlike pgActivitySource.ts's/
// dockerExecutor.ts's own one-off Client) -- created once at module load,
// reused across every invocation of this tool. pg.Pool manages its own
// internal connection lifecycle; callers borrow a client via pool.connect()
// and MUST release it back (see checkPostgresBackendBlocked's finally below)
// rather than closing it, so the pool -- not this module -- decides when a
// real connection actually gets torn down.
const pool = new pg.Pool(readPgDemoConfig());

const STATUS_QUERY = `
  SELECT pid, state, query, query_start, wait_event_type, datname, backend_type,
         pg_blocking_pids(pid) AS blocked_by
  FROM pg_stat_activity
  WHERE pid = $1
`;

export interface PgBackendStatus {
  pid: number;
  found: boolean;
  state: string | null;
  query: string | null;
  waitEventType: string | null;
  datname: string | null;
  backendType: string | null;
  blockedBy: number[];
}

async function runQuery(pid: number): Promise<PgBackendStatus> {
  const client = await pool.connect();
  try {
    // $1 -- pid is always a bound parameter, never concatenated into
    // STATUS_QUERY's text, regardless of where the caller's pid value
    // originated (including a model-supplied tool argument).
    const result = await client.query(STATUS_QUERY, [pid]);
    if (result.rows.length === 0) {
      return { pid, found: false, state: null, query: null, waitEventType: null, datname: null, backendType: null, blockedBy: [] };
    }
    const row = result.rows[0];
    return {
      pid: row.pid,
      found: true,
      state: row.state,
      query: row.query,
      waitEventType: row.wait_event_type,
      datname: row.datname,
      backendType: row.backend_type,
      blockedBy: row.blocked_by ?? [],
    };
  } finally {
    // Released back to the pool, not closed -- a real, reused connection for
    // the next call, matching the "pooled or reused connection" requirement.
    client.release();
  }
}

// Throws UpstreamTimeoutError (the stable "TimeoutError"-shaped class this
// call path uses -- see reliability/withReliability.ts), UpstreamCallFailedError
// (all retries exhausted), or CircuitOpenError (breaker open) -- the caller
// (mcpServerFactory.ts) is the one place that turns any of these into the MCP
// error result contract, never a thrown error crossing the tool boundary.
export async function checkPostgresBackendBlocked(
  pid: number,
  onAttempt?: (attempt: number, maxAttempts: number) => void
): Promise<PgBackendStatus> {
  return withReliability(() => runQuery(pid), {
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    circuitBreaker: backendStatusCircuitBreaker,
    onAttempt,
  });
}
