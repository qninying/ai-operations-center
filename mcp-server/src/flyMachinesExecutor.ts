import { withReliability } from "./reliability/withReliability.js";
import { recordSourceCheck } from "./sourceReachability.js";

// The "prod" counterpart to dockerExecutor.ts's local
// `execFile("docker", ["restart", ...])` — the coreops Fly app has no Docker
// daemon in production, so restarting a Fly-hosted dev-postgres/dev-superset
// sidecar machine goes through Fly's own REST API instead. See
// docs/ADR-012-real-docker-execution.md's "second target, pointed to prod"
// addendum for why this stays a narrow, specific exception mirroring the local
// one, not a general capability.

const FLY_MACHINES_API_BASE = "https://api.machines.dev/v1";
const RESTART_TIMEOUT_MS = 15_000;

export class FlyMachineRestartFailedError extends Error {
  readonly errorClass = "FlyMachineRestartFailedError" as const;
  constructor(
    readonly appName: string,
    readonly machineId: string,
    cause: unknown
  ) {
    super(
      `Fly machine restart failed (app=${appName}, machine=${machineId}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "FlyMachineRestartFailedError";
    this.cause = cause;
  }
}

// Never logs apiToken, in the request or in any thrown error message — only
// the app/machine identifiers, which are not secret.
async function callRestart(appName: string, machineId: string, apiToken: string): Promise<void> {
  const res = await fetch(`${FLY_MACHINES_API_BASE}/apps/${appName}/machines/${machineId}/restart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) {
    throw new Error(`Fly Machines API responded with HTTP ${res.status}`);
  }
}

export async function restartFlyMachine(appName: string, machineId: string, apiToken: string): Promise<void> {
  try {
    // Single bounded attempt, same as the local docker restart path — a
    // restart command that already ran should not be blindly retried.
    await withReliability(() => callRestart(appName, machineId, apiToken), {
      timeoutMs: RESTART_TIMEOUT_MS,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    recordSourceCheck("flyMachinesApi", "success");
  } catch (error) {
    recordSourceCheck("flyMachinesApi", "failure", { errorClass: error instanceof Error ? error.name : "Error" });
    throw new FlyMachineRestartFailedError(appName, machineId, error);
  }
}
