import pg from "pg";
import { CircuitBreaker } from "./reliability/circuitBreaker.js";
import { withReliability } from "./reliability/withReliability.js";

// Real Postgres introspection for the ADR-013 blocking-query scenario. No
// fixture-fallback concept — unlike dmvReader.ts's remote, sometimes-legitimately-
// unreachable SQL Server, dev-postgres/ is a fully local, fully-controlled dev
// container, matching supersetHealthSource.ts's same reasoning for Docker.
//
// Read-only: this module only ever runs the SELECT below. The one write this
// feature performs lives exclusively in pgRemediationExecutor.ts — see
// readOnlyGuard.test.ts's confined-write guard.

const PG_HOST = process.env.PG_DEMO_HOST ?? "localhost";
const PG_PORT = Number(process.env.PG_DEMO_PORT ?? 5434);
const PG_DATABASE = process.env.PG_DEMO_DATABASE ?? "orders";
const PG_USER = process.env.PG_DEMO_USER ?? "app";
const PG_PASSWORD = process.env.PG_DEMO_PASSWORD ?? "app";

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;

// A separate breaker instance from dmvLiveSource.ts's and supersetHealthSource.ts's
// — an unrelated dependency, failures here must never trip or be blocked by theirs.
const pgActivityCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
});

export interface PgActivityRow {
  pid: number;
  state: string;
  query: string;
  query_start: string;
  wait_event_type: string | null;
  datname: string;
  backend_type: string;
  blocked_by: number[];
}

// Deliberately NOT filtered to only-blocked rows — a blocker's own row must
// be present even when the blocker itself isn't blocked by anything (the
// common, safe case), so a caller assessing whether it's safe to terminate
// can find it. incidentFeedService.ts filters for blocked_by.length > 0
// client-side, the same split discoverSqlIncidents() already draws against
// dmvLiveSource.ts's own unfiltered row set.
const ACTIVITY_QUERY = `
  SELECT pid, state, query, query_start, wait_event_type, datname, backend_type,
         pg_blocking_pids(pid) AS blocked_by
  FROM pg_stat_activity
  WHERE pid != pg_backend_pid()
`;

function readConfig(): pg.ClientConfig {
  return {
    host: PG_HOST,
    port: PG_PORT,
    database: PG_DATABASE,
    user: PG_USER,
    password: PG_PASSWORD,
    connectionTimeoutMillis: TIMEOUT_MS,
  };
}

async function runQuery(): Promise<PgActivityRow[]> {
  const client = new pg.Client(readConfig());
  try {
    await client.connect();
    const result = await client.query<PgActivityRow>(ACTIVITY_QUERY);
    return result.rows;
  } finally {
    await client.end();
  }
}

// Throws UpstreamCallFailedError (all retries exhausted) or CircuitOpenError
// (breaker open) from the shared withReliability wrapper — same as
// supersetHealthSource.ts's checkSupersetHealth(), no extra wrapping needed
// since there's no separate "missing config" precondition to check here.
export async function queryPgActivity(): Promise<PgActivityRow[]> {
  return withReliability(runQuery, {
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    circuitBreaker: pgActivityCircuitBreaker,
  });
}
