import sql from "mssql";
import type { SsrsExecutionLogRow } from "./ssrsFixtures.js";
import type { ReadSsrsInput, SupportedSsrsQuery } from "./ssrsTypes.js";
import { CircuitBreaker } from "./reliability/circuitBreaker.js";
import { withReliability } from "./reliability/withReliability.js";

// Real SQL Server I/O for the SSRS read path, mirroring dmvLiveSource.ts exactly.
// SSRS logs every report execution to the ExecutionLog3 view in the ReportServer
// catalog database — a separate database from SQLSERVER_DATABASE (the reporting
// data itself), typically on the same instance, hence its own required env var
// (SSRS_REPORTSERVER_DATABASE) reusing SQLSERVER_HOST/USER/PASSWORD. Every query
// here is parameterized (sql.NVarChar bound params) — reportPath is never
// interpolated into SQL text; queryName is used only as a lookup key into
// SSRS_QUERIES, a fixed map of hardcoded, pre-approved statements. Read-only by
// construction, same as the DMV path — see readOnlyGuard.test.ts, which scans this
// exact file for that class of keyword.

const REQUIRED_ENV_VARS = [
  "SQLSERVER_HOST",
  "SSRS_REPORTSERVER_DATABASE",
  "SQLSERVER_USER",
  "SQLSERVER_PASSWORD",
] as const;

// Same reliability spec as the DMV path (10s timeout, 3 retries, circuit breaker
// after 5 failures/60s with a 30s cooldown), but its own dedicated circuit breaker
// instance — a failing ReportServer database must not trip the breaker guarding
// the (separate) SQL Server data path, and vice versa.
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;

const ssrsCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
});

export class SsrsLiveSourceUnavailableError extends Error {
  readonly errorClass = "SsrsLiveSourceUnavailableError" as const;

  constructor(readonly missingEnvVars: string[]) {
    super(
      `SSRS ReportServer database connection not configured. Missing env vars: ${missingEnvVars.join(", ")}.`
    );
    this.name = "SsrsLiveSourceUnavailableError";
  }
}

// Fixed, pre-approved, read-only statements keyed by query name — queryName is
// validated against SUPPORTED_SSRS_QUERIES by the caller before this map is even
// consulted, so it is never used to build SQL text. rsSuccess is excluded at the
// query level — this path exists to surface incidents, not a full execution log.
//
// Found live, 2026-08-28, the first time this query ever ran against a real
// ExecutionLog3 table (seedSsrsExecutionLog.ts): TimeStart/TimeEnd are DATETIME2
// columns, and the mssql driver deserializes those as native JS Date objects, not
// strings — SsrsExecutionLogRowSchema expects z.string() (matching
// ssrsFixtures.ts's own ISO-string rows), so every real row failed validation
// with InvalidSsrsDataFormatError. CONVERT(..., 127) forces an ISO 8601 string at
// the SQL layer instead of relying on the driver's own type mapping.
const SSRS_QUERIES: Record<SupportedSsrsQuery, string> = {
  ExecutionLog3: `
    SELECT TOP (3)
      InstanceName AS instance_name,
      ItemPath AS report_path,
      UserName AS user_name,
      Status AS status,
      CONVERT(VARCHAR(33), TimeStart, 127) AS time_start,
      CONVERT(VARCHAR(33), TimeEnd, 127) AS time_end,
      TimeDataRetrieval AS time_data_retrieval_ms,
      TimeProcessing AS time_processing_ms,
      TimeRendering AS time_rendering_ms
    FROM dbo.ExecutionLog3
    WHERE Status <> 'rsSuccess'
      AND (@reportPath IS NULL OR ItemPath = @reportPath)
    ORDER BY TimeStart DESC
  `,
};

function readConnectionConfig(): sql.config {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new SsrsLiveSourceUnavailableError(missing);
  }

  return {
    server: process.env.SQLSERVER_HOST!,
    database: process.env.SSRS_REPORTSERVER_DATABASE!,
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
  input: ReadSsrsInput,
  config: sql.config
): Promise<SsrsExecutionLogRow[]> {
  const pool = new sql.ConnectionPool(config);
  try {
    await pool.connect();
    const request = pool.request();
    request.input("reportPath", sql.NVarChar, input.reportPath ?? null);
    const result = await request.query<SsrsExecutionLogRow>(
      SSRS_QUERIES[input.queryName as SupportedSsrsQuery]
    );
    return result.recordset;
  } finally {
    await pool.close();
  }
}

// Throws SsrsLiveSourceUnavailableError (no attempt made — missing config is never
// retried, it won't change between attempts), UpstreamCallFailedError (all retries
// exhausted), or CircuitOpenError (breaker open, no attempt made). Never returns a
// partial/best-effort result. The caller (ssrsReader.ts) decides what to do with
// any of these, typically falling back to fixture data.
export async function querySsrsExecutionLog(input: ReadSsrsInput): Promise<SsrsExecutionLogRow[]> {
  const config = readConnectionConfig();

  return withReliability(() => runQuery(input, config), {
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    circuitBreaker: ssrsCircuitBreaker,
  });
}
