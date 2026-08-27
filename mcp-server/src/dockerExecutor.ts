import { execFile } from "node:child_process";
import { withReliability } from "./reliability/withReliability.js";

// The one real, privileged execution path in this codebase — everything else
// (SQL, SSRS, Cloud) stays ADR-010's honest stand-in. Docker/Superset is the
// single narrow exception: `docker restart` on a local dev container needs no
// new credential, touches no production system, and is trivially reversible.
// See docs/ADR-012-real-docker-execution.md.

export const SUPERSET_CONTAINER_NAME = "coreops-dev-superset";
const SUPERSET_HEALTH_URL = "http://localhost:8088/health";

const RESTART_TIMEOUT_MS = 15_000;
const HEALTH_CONFIRM_TIMEOUT_MS = 45_000;
const HEALTH_POLL_INTERVAL_MS = 3_000;

export class DockerRestartFailedError extends Error {
  readonly errorClass = "DockerRestartFailedError" as const;
  constructor(cause: unknown) {
    super(
      `docker restart ${SUPERSET_CONTAINER_NAME} failed: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "DockerRestartFailedError";
    this.cause = cause;
  }
}

export interface DockerRestartOutcome {
  attempted: true;
  confirmedHealthy: boolean;
  waitedMs: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runDockerRestart(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("docker", ["restart", SUPERSET_CONTAINER_NAME], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// A minimal, direct health probe — deliberately NOT checkSupersetHealth() from
// supersetHealthSource.ts. That function shares one module-level CircuitBreaker
// with incidentFeedService.ts's own polling; several early failures are
// *expected* here while the container boots, and confirmed via
// supersetHealthSource.test.ts that 5 failures in 60s opens that breaker for a
// 30s cooldown — exactly when this needs a fast, frequent answer. A separate
// probe avoids tripping (or being blocked by) that shared breaker.
async function isSupersetHealthyOnce(): Promise<boolean> {
  try {
    const res = await fetch(SUPERSET_HEALTH_URL);
    return res.ok;
  } catch {
    return false;
  }
}

export async function restartSupersetContainer(): Promise<DockerRestartOutcome> {
  try {
    await withReliability(runDockerRestart, {
      timeoutMs: RESTART_TIMEOUT_MS,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
  } catch (error) {
    throw new DockerRestartFailedError(error);
  }

  const start = Date.now();
  let confirmedHealthy = false;
  while (Date.now() - start < HEALTH_CONFIRM_TIMEOUT_MS) {
    if (await isSupersetHealthyOnce()) {
      confirmedHealthy = true;
      break;
    }
    await delay(HEALTH_POLL_INTERVAL_MS);
  }

  return { attempted: true, confirmedHealthy, waitedMs: Date.now() - start };
}
