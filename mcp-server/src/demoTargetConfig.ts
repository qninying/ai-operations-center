// The one switch between the two places dev-postgres/dev-superset can run:
// "local" (default — Docker Compose on this machine, what ADR-012/ADR-013 were
// built and verified against) and "prod" (the Fly-hosted sidecar apps, reached
// over Fly's private 6PN network and restarted via the Fly Machines API, since
// the coreops Fly app has no Docker daemon and can't reach a laptop's
// localhost). See ADR-012's "second target, pointed to prod" addendum.
//
// Deliberately additive, not a replacement: DEMO_TARGET defaults to "local" so
// nothing about the existing, already-verified local demo path changes unless
// this is set explicitly.

export type DemoTarget = "local" | "prod";

export function getDemoTarget(): DemoTarget {
  return process.env.DEMO_TARGET === "prod" ? "prod" : "local";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when DEMO_TARGET=prod`);
  }
  return value;
}

export interface PostgresConnectionTarget {
  host: string;
  port: number;
}

// Local defaults match dev-postgres/docker-compose.yml's published port
// (5434->5432) exactly, same as pgActivitySource.ts/seedPostgresBlockingScenario.ts
// already assumed — centralized here so prod doesn't silently drift from them.
export function getPostgresConnectionTarget(): PostgresConnectionTarget {
  if (getDemoTarget() === "prod") {
    return {
      host: requireEnv("PG_PROD_HOST"),
      port: Number(process.env.PG_PROD_PORT ?? 5432),
    };
  }
  return {
    host: process.env.PG_DEMO_HOST ?? "localhost",
    port: Number(process.env.PG_DEMO_PORT ?? 5434),
  };
}

export function getSupersetHealthUrl(): string {
  if (getDemoTarget() === "prod") {
    return requireEnv("SUPERSET_PROD_URL");
  }
  return "http://localhost:8088";
}

export type RestartTarget =
  | { kind: "local"; containerName: string }
  | { kind: "fly"; appName: string; machineId: string; apiToken: string };

// Shared by both restart targets (dev-superset, dev-postgres) — only the env
// var names differ per service, same shape either way. Each service gets its
// OWN token (`fly tokens create deploy -a <app>` only scopes to one app at a
// time — there is no single-token way to scope across both sidecar apps), so
// a compromised or over-broad token for one never grants access to the other.
// A real new credential either way, unlike local docker restart's "no
// credential at all" — see ADR-012's addendum on why that scoping matters.
function resolveFlyRestartTarget(appEnvName: string, machineIdEnvName: string, tokenEnvName: string): RestartTarget {
  return {
    kind: "fly",
    appName: requireEnv(appEnvName),
    machineId: requireEnv(machineIdEnvName),
    apiToken: requireEnv(tokenEnvName),
  };
}

export function getSupersetRestartTarget(localContainerName: string): RestartTarget {
  if (getDemoTarget() === "prod") {
    return resolveFlyRestartTarget(
      "FLY_DEV_SUPERSET_APP",
      "FLY_DEV_SUPERSET_MACHINE_ID",
      "FLY_DEV_SUPERSET_API_TOKEN"
    );
  }
  return { kind: "local", containerName: localContainerName };
}

export function getPostgresRestartTarget(localContainerName: string): RestartTarget {
  if (getDemoTarget() === "prod") {
    return resolveFlyRestartTarget(
      "FLY_DEV_POSTGRES_APP",
      "FLY_DEV_POSTGRES_MACHINE_ID",
      "FLY_DEV_POSTGRES_API_TOKEN"
    );
  }
  return { kind: "local", containerName: localContainerName };
}
