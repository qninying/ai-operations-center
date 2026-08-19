import sql from "mssql";
import type { DmvExecRequestRow } from "./dmvFixtures.js";
import type { ReadDmvInput, SupportedDmv } from "./dmvTypes.js";
import { CircuitBreaker } from "./reliability/circuitBreaker.js";
import { withReliability } from "./reliability/withReliability.js";

// Real SQL Server I/O for R3 (result shaping + substitutions) and R5 (reliability &
// polish). Every query here is parameterized (sql.NVarChar bound params) — dmvName
// itself is never interpolated into SQL text; it's used only as a lookup key into
// DMV_QUERIES, a fixed map of hardcoded, pre-approved statements. Read-only by
// construction: this module has no code path capable of a write, a mutation, or a
// stored-procedure call — see readOnlyGuard.test.ts, which scans this exact file for
// that class of keyword.

const REQUIRED_ENV_VARS = [
  "SQLSERVER_HOST",
  "SQLSERVER_DATABASE",
  "SQLSERVER_USER",
  "SQLSERVER_PASSWORD",
] as const;

// R5 spec: 10s timeout per attempt, 3 retries with exponential backoff, circuit
// breaker after 5 failures in a 60s window with a 30s cooldown before a half-open
// trial. Shared as one module-level breaker so failures accumulate across every call
// to queryLiveDmv(), not just within a single call's own retries.
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;

const dmvCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
});

export class LiveSourceUnavailableError extends Error {
  readonly errorClass = "LiveSourceUnavailableError" as const;

  constructor(readonly missingEnvVars: string[]) {
    super(
      `SQL Server connection not configured. Missing env vars: ${missingEnvVars.join(", ")}.`
    );
    this.name = "LiveSourceUnavailableError";
  }
}

// Fixed, pre-approved, read-only statements keyed by DMV name — dmvName is validated
// against SUPPORTED_DMVS by the caller before this map is even consulted, so it is
// never used to build SQL text.
const DMV_QUERIES: Record<SupportedDmv, string> = {
  // STORY-006: ordering by cpu_time DESC alone was a real bug, only found by
  // running this against a real instance — a blocked session has near-zero CPU
  // time by definition (it's waiting, not computing), so on a real server with
  // background engine noise (Azure SQL Database serverless alone runs 40-50+
  // internal system sessions — XE dispatchers, HADR workers, lazy writer, broker
  // tasks, none of it real activity), a genuine blocking scenario was getting
  // silently pushed out of TOP(3) by system housekeeping. Fixture data's clean
  // 3-row dataset could never have exposed this. Fixed two ways: excludes
  // status = 'background' (engine housekeeping, not application activity), and
  // sorts any blocked session (blocking_session_id <> 0) ahead of everything
  // else before falling back to cpu_time as the tiebreaker.
  "sys.dm_exec_requests": `
    SELECT TOP (3)
      r.session_id,
      r.status,
      r.command,
      r.wait_type,
      r.blocking_session_id,
      r.cpu_time AS cpu_time_ms,
      r.total_elapsed_time AS total_elapsed_time_ms,
      DB_NAME(r.database_id) AS database_name
    FROM sys.dm_exec_requests r
    WHERE r.status <> 'background'
      AND (@databaseName IS NULL OR DB_NAME(r.database_id) = @databaseName)
    ORDER BY
      CASE WHEN r.blocking_session_id <> 0 THEN 0 ELSE 1 END,
      r.cpu_time DESC
  `,
};

function readConnectionConfig(): sql.config {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new LiveSourceUnavailableError(missing);
  }

  return {
    server: process.env.SQLSERVER_HOST!,
    database: process.env.SQLSERVER_DATABASE!,
    user: process.env.SQLSERVER_USER!,
    password: process.env.SQLSERVER_PASSWORD!,
    connectionTimeout: TIMEOUT_MS,
    requestTimeout: TIMEOUT_MS,
    options: {
      trustServerCertificate: false,
    },
  };
}

async function runQuery(
  input: ReadDmvInput,
  config: sql.config
): Promise<DmvExecRequestRow[]> {
  const pool = new sql.ConnectionPool(config);
  try {
    await pool.connect();
    const request = pool.request();
    request.input("databaseName", sql.NVarChar, input.databaseName ?? null);
    const result = await request.query<DmvExecRequestRow>(
      DMV_QUERIES[input.dmvName as SupportedDmv]
    );
    return result.recordset;
  } finally {
    await pool.close();
  }
}

// Throws LiveSourceUnavailableError (no attempt made — missing config is never
// retried, it won't change between attempts), UpstreamCallFailedError (all retries
// exhausted), or CircuitOpenError (breaker open, no attempt made). Never returns a
// partial/best-effort result. The caller (dmvReader.ts) decides what to do with any
// of these, typically falling back to fixture data.
export async function queryLiveDmv(input: ReadDmvInput): Promise<DmvExecRequestRow[]> {
  const config = readConnectionConfig();

  return withReliability(() => runQuery(input, config), {
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    circuitBreaker: dmvCircuitBreaker,
  });
}
