import { describe, it, expect, afterEach } from "vitest";
import {
  getDemoTarget,
  getPostgresConnectionTarget,
  getPostgresRestartTarget,
  getSupersetHealthUrl,
  getSupersetRestartTarget,
} from "./demoTargetConfig.js";

const ENV_KEYS = [
  "DEMO_TARGET",
  "PG_DEMO_HOST",
  "PG_DEMO_PORT",
  "PG_PROD_HOST",
  "PG_PROD_PORT",
  "SUPERSET_PROD_URL",
  "FLY_DEV_SUPERSET_APP",
  "FLY_DEV_SUPERSET_MACHINE_ID",
  "FLY_DEV_SUPERSET_API_TOKEN",
  "FLY_DEV_POSTGRES_APP",
  "FLY_DEV_POSTGRES_MACHINE_ID",
  "FLY_DEV_POSTGRES_API_TOKEN",
] as const;

describe("demoTargetConfig", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("defaults to local when DEMO_TARGET is unset", () => {
    expect(getDemoTarget()).toBe("local");
  });

  it("treats any value other than exactly 'prod' as local, not just unset", () => {
    process.env.DEMO_TARGET = "production"; // a plausible typo, must not silently match
    expect(getDemoTarget()).toBe("local");
  });

  it("local Postgres target: defaults, no env required", () => {
    expect(getPostgresConnectionTarget()).toEqual({ host: "localhost", port: 5434 });
  });

  it("local Postgres target: respects PG_DEMO_HOST/PORT overrides", () => {
    process.env.PG_DEMO_HOST = "custom-host";
    process.env.PG_DEMO_PORT = "9999";
    expect(getPostgresConnectionTarget()).toEqual({ host: "custom-host", port: 9999 });
  });

  it("local Superset health URL: fixed default", () => {
    expect(getSupersetHealthUrl()).toBe("http://localhost:8088");
  });

  it("local restart targets: local container names, no Fly env required", () => {
    expect(getSupersetRestartTarget("coreops-dev-superset")).toEqual({
      kind: "local",
      containerName: "coreops-dev-superset",
    });
    expect(getPostgresRestartTarget("coreops-dev-postgres")).toEqual({
      kind: "local",
      containerName: "coreops-dev-postgres",
    });
  });

  it("prod Postgres target: reads PG_PROD_HOST/PORT, defaults port to 5432", () => {
    process.env.DEMO_TARGET = "prod";
    process.env.PG_PROD_HOST = "dev-postgres.internal";
    expect(getPostgresConnectionTarget()).toEqual({ host: "dev-postgres.internal", port: 5432 });
  });

  it("prod Postgres target: throws a clear error when PG_PROD_HOST is missing", () => {
    process.env.DEMO_TARGET = "prod";
    expect(() => getPostgresConnectionTarget()).toThrow("PG_PROD_HOST is required when DEMO_TARGET=prod");
  });

  it("prod Superset URL: throws a clear error when SUPERSET_PROD_URL is missing", () => {
    process.env.DEMO_TARGET = "prod";
    expect(() => getSupersetHealthUrl()).toThrow("SUPERSET_PROD_URL is required when DEMO_TARGET=prod");
  });

  it("prod Superset restart target: resolves app/machine/token from its own env vars", () => {
    process.env.DEMO_TARGET = "prod";
    process.env.FLY_DEV_SUPERSET_APP = "dev-superset";
    process.env.FLY_DEV_SUPERSET_MACHINE_ID = "machine-abc";
    process.env.FLY_DEV_SUPERSET_API_TOKEN = "fo1_superset-token";
    expect(getSupersetRestartTarget("coreops-dev-superset")).toEqual({
      kind: "fly",
      appName: "dev-superset",
      machineId: "machine-abc",
      apiToken: "fo1_superset-token",
    });
  });

  it("prod Postgres restart target: resolves app/machine/token from its own, distinct env vars", () => {
    process.env.DEMO_TARGET = "prod";
    process.env.FLY_DEV_POSTGRES_APP = "dev-postgres";
    process.env.FLY_DEV_POSTGRES_MACHINE_ID = "machine-xyz";
    process.env.FLY_DEV_POSTGRES_API_TOKEN = "fo1_postgres-token";
    expect(getPostgresRestartTarget("coreops-dev-postgres")).toEqual({
      kind: "fly",
      appName: "dev-postgres",
      machineId: "machine-xyz",
      apiToken: "fo1_postgres-token",
    });
  });

  it("Postgres's token env var never satisfies Superset's requirement, or vice versa", () => {
    process.env.DEMO_TARGET = "prod";
    process.env.FLY_DEV_SUPERSET_APP = "dev-superset";
    process.env.FLY_DEV_SUPERSET_MACHINE_ID = "machine-abc";
    process.env.FLY_DEV_POSTGRES_API_TOKEN = "fo1_postgres-token"; // wrong service's token
    expect(() => getSupersetRestartTarget("coreops-dev-superset")).toThrow(
      "FLY_DEV_SUPERSET_API_TOKEN is required when DEMO_TARGET=prod"
    );
  });
});
