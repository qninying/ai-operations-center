import pg from "pg";
import { withReliability } from "./reliability/withReliability.js";

// The ONLY file in this codebase allowed to write to Postgres — see
// readOnlyGuard.test.ts's confined-write guard, which structurally asserts
// pg_terminate_backend appears nowhere else in src/. See
// docs/ADR-013-real-postgres-remediation.md.
//
// Same execution-then-confirmation discipline as dockerExecutor.ts: a
// command "succeeding" is not the same as the outcome being true, so this
// always independently re-checks pg_stat_activity for the pid afterward
// rather than trusting pg_terminate_backend's own boolean return value.

const PG_HOST = process.env.PG_DEMO_HOST ?? "localhost";
const PG_PORT = Number(process.env.PG_DEMO_PORT ?? 5434);
const PG_DATABASE = process.env.PG_DEMO_DATABASE ?? "orders";
const PG_USER = process.env.PG_DEMO_USER ?? "app";
const PG_PASSWORD = process.env.PG_DEMO_PASSWORD ?? "app";

const TERMINATE_TIMEOUT_MS = 10_000;
const CONFIRM_TIMEOUT_MS = 10_000;
const CONFIRM_POLL_INTERVAL_MS = 500;

export class PgTerminateFailedError extends Error {
  readonly errorClass = "PgTerminateFailedError" as const;
  constructor(readonly pid: number, cause: unknown) {
    super(`pg_terminate_backend(${pid}) failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PgTerminateFailedError";
    this.cause = cause;
  }
}

export interface PgTerminateOutcome {
  attempted: true;
  confirmedTerminated: boolean;
  waitedMs: number;
}

function readConfig(): pg.ClientConfig {
  return {
    host: PG_HOST,
    port: PG_PORT,
    database: PG_DATABASE,
    user: PG_USER,
    password: PG_PASSWORD,
    connectionTimeoutMillis: TERMINATE_TIMEOUT_MS,
  };
}

async function runTerminate(pid: number): Promise<void> {
  const client = new pg.Client(readConfig());
  try {
    await client.connect();
    // Parameterized — $1 is pg's own placeholder binding, never string-interpolated.
    await client.query("SELECT pg_terminate_backend($1)", [pid]);
  } finally {
    await client.end();
  }
}

async function isBackendStillPresent(pid: number): Promise<boolean> {
  const client = new pg.Client(readConfig());
  try {
    await client.connect();
    const result = await client.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
    return (result.rowCount ?? 0) > 0;
  } finally {
    await client.end();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function terminatePostgresBackend(pid: number): Promise<PgTerminateOutcome> {
  try {
    await withReliability(() => runTerminate(pid), {
      timeoutMs: TERMINATE_TIMEOUT_MS,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
  } catch (error) {
    throw new PgTerminateFailedError(pid, error);
  }

  const start = Date.now();
  let confirmedTerminated = false;
  while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
    try {
      const stillPresent = await isBackendStillPresent(pid);
      if (!stillPresent) {
        confirmedTerminated = true;
        break;
      }
    } catch {
      // A confirmation query failure isn't a reason to declare success —
      // keep polling within the bounded window rather than assuming either outcome.
    }
    await delay(CONFIRM_POLL_INTERVAL_MS);
  }

  return { attempted: true, confirmedTerminated, waitedMs: Date.now() - start };
}
