import { CircuitBreaker } from "./reliability/circuitBreaker.js";
import { withReliability } from "./reliability/withReliability.js";

// Docker-sourced incident: is the dev-superset stack (mcp-server/dev-superset/,
// Superset + Postgres) actually reachable. Mirrors dmvLiveSource.ts/
// cloudBlobSource.ts/ssrsLiveSource.ts's shape (own CircuitBreaker, same
// reliability budget, a typed unavailable error) even though this source needs
// no credential — Superset exposes a real, documented, unauthenticated
// GET /health (confirmed directly: dev-superset/setup.sh's own readiness poll
// uses exactly this route). No login dance needed for a liveness check, unlike
// dev-superset/verify-live-pattern.ts's full authenticated query-history path,
// which proves something different (that the live-query-then-fallback pattern
// works against a real system) and is intentionally not reused here.
//
// Unlike the other three sources, "unreachable" here IS the incident, not just
// "can't check this source" — this module has no fixture-fallback concept.

const SUPERSET_URL = "http://localhost:8088";

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;

const supersetCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
});

export class SupersetUnavailableError extends Error {
  readonly errorClass = "SupersetUnavailableError" as const;
  constructor(cause: unknown) {
    super(`Could not reach Superset at ${SUPERSET_URL}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SupersetUnavailableError";
    this.cause = cause;
  }
}

// A connection-level failure (container down, port unreachable) throws Node's
// raw fetch TypeError before any HTTP response exists — translated into the
// typed error here, same fix verify-live-pattern.ts needed for the same reason.
async function fetchHealth(): Promise<Response> {
  try {
    return await fetch(`${SUPERSET_URL}/health`);
  } catch (error) {
    throw new SupersetUnavailableError(error);
  }
}

async function checkOnce(): Promise<void> {
  const res = await fetchHealth();
  if (!res.ok) {
    throw new SupersetUnavailableError(new Error(`Superset /health responded with HTTP ${res.status}`));
  }
}

// Throws SupersetUnavailableError for any connectivity failure or non-ok
// response, UpstreamCallFailedError (all retries exhausted) or CircuitOpenError
// (breaker open) from the shared withReliability wrapper. Resolves on a real
// 200 from Superset's own /health route.
export async function checkSupersetHealth(): Promise<void> {
  await withReliability(checkOnce, {
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    circuitBreaker: supersetCircuitBreaker,
  });
}
