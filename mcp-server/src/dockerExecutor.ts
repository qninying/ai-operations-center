import { execFile } from "node:child_process";
import pg from "pg";
import { withReliability } from "./reliability/withReliability.js";
import { readPgDemoConfig } from "./pgActivitySource.js";
import {
  getPostgresRestartTarget,
  getSupersetHealthUrl,
  getSupersetRestartTarget,
  type RestartTarget,
} from "./demoTargetConfig.js";
import { restartFlyMachine } from "./flyMachinesExecutor.js";

// The one real, privileged execution path in this codebase — everything else
// (SQL, SSRS, Cloud) stays ADR-010's honest stand-in. Docker-controlled local
// dev containers are the narrow exception: `docker restart` needs no new
// credential, touches no production system, and is trivially reversible.
// Two targets share this mechanism — dev-superset (ADR-012) and dev-postgres
// (added for the same reason: a real "unreachable" incident deserves a real
// restart, not a stand-in, same confined-blast-radius argument as Superset's).
// A second pair of these same two targets, pointed at the Fly-hosted sidecar
// apps instead of local Docker, is resolved per-call via demoTargetConfig.ts's
// DEMO_TARGET switch (default "local", unchanged behavior unless set to "prod")
// and executed via flyMachinesExecutor.ts instead of execFile. See
// docs/ADR-012-real-docker-execution.md.

export const SUPERSET_CONTAINER_NAME = "coreops-dev-superset";
export const POSTGRES_CONTAINER_NAME = "coreops-dev-postgres";

const RESTART_TIMEOUT_MS = 15_000;
const HEALTH_CONFIRM_TIMEOUT_MS = 45_000;
const HEALTH_POLL_INTERVAL_MS = 3_000;

export class DockerRestartFailedError extends Error {
  readonly errorClass = "DockerRestartFailedError" as const;
  constructor(readonly containerName: string, cause: unknown) {
    super(`docker restart ${containerName} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
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

function runDockerRestart(containerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("docker", ["restart", containerName], (error) => {
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
    const res = await fetch(`${getSupersetHealthUrl()}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// Same "separate from the shared breaker" reasoning as isSupersetHealthyOnce()
// above, applied to Postgres: a direct connect-and-query, not queryPgActivity()
// (which shares pgActivitySource.ts's own circuit breaker with the incident
// feed's regular polling). Reuses readPgDemoConfig() so this and
// pgActivitySource.ts can't silently drift on connection parameters — that
// function is itself DEMO_TARGET-aware (demoTargetConfig.ts), so this probe
// automatically points at the same place the regular incident-feed query does.
async function isPostgresReachableOnce(): Promise<boolean> {
  const client = new pg.Client(readPgDemoConfig());
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function performRestart(target: RestartTarget): Promise<void> {
  if (target.kind === "local") {
    try {
      await withReliability(() => runDockerRestart(target.containerName), {
        timeoutMs: RESTART_TIMEOUT_MS,
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
      });
    } catch (error) {
      throw new DockerRestartFailedError(target.containerName, error);
    }
    return;
  }
  // target.kind === "fly" — restartFlyMachine throws its own typed
  // FlyMachineRestartFailedError; not re-wrapped as DockerRestartFailedError,
  // since this genuinely isn't a docker command failing.
  await restartFlyMachine(target.appName, target.machineId, target.apiToken);
}

async function restartContainerAndConfirm(
  target: RestartTarget,
  isHealthyOnce: () => Promise<boolean>
): Promise<DockerRestartOutcome> {
  await performRestart(target);

  const start = Date.now();
  let confirmedHealthy = false;
  while (Date.now() - start < HEALTH_CONFIRM_TIMEOUT_MS) {
    if (await isHealthyOnce()) {
      confirmedHealthy = true;
      break;
    }
    await delay(HEALTH_POLL_INTERVAL_MS);
  }

  return { attempted: true, confirmedHealthy, waitedMs: Date.now() - start };
}

export function restartSupersetContainer(): Promise<DockerRestartOutcome> {
  return restartContainerAndConfirm(getSupersetRestartTarget(SUPERSET_CONTAINER_NAME), isSupersetHealthyOnce);
}

export function restartPostgresContainer(): Promise<DockerRestartOutcome> {
  return restartContainerAndConfirm(getPostgresRestartTarget(POSTGRES_CONTAINER_NAME), isPostgresReachableOnce);
}
