import { queryPgActivity } from "../pgActivitySource.js";
import { recordCheckSuccess, recordCheckFailure } from "./sourceCheck.js";
import type { SourceConnector } from "./types.js";
import { getDemoTarget } from "../demoTargetConfig.js";

// PostgreSQL blocking queries via pg_stat_activity / pg_blocking_pids().
export const postgresConnector: SourceConnector = {
  id: "postgres",
  system: "PostgreSQL",
  reachabilityName: "postgres",
  async discoverIncidents() {
    try {
      const rows = await queryPgActivity();
      recordCheckSuccess(postgresConnector, { rowCount: rows.length });
      return rows
        .filter((row) => row.blocked_by.length > 0)
        .map((row) => ({
          id: `postgres:pid:${row.pid}`,
          source: "postgres",
          title: `Backend ${row.pid} blocked by ${row.blocked_by[0]}`,
          detail: `${row.query} on ${row.datname} — ${row.state}${row.wait_event_type ? " · " + row.wait_event_type : ""}`,
          severity: "error" as const,
          occurredAt: new Date().toISOString(),
          sourceMode: "live" as const,
        }));
    } catch (error) {
      // dev-postgres is a fully controlled demo database (no fixture fallback,
      // see pgActivitySource.ts), so unreachable IS a real incident, mirroring
      // the Superset connector. Deliberately fulfilled, not re-thrown: a check
      // that found the database down is real information, and this fixed id
      // correctly replaces any blocking-query incident active when it went down.
      recordCheckFailure(postgresConnector, error, "warn");
      return [
        {
          id: "postgres:unreachable",
          source: "postgres",
          title: "Postgres (dev-postgres) unreachable",
          // Production runs dev-postgres as a Fly.io machine, not Docker Desktop.
          detail: getDemoTarget() === "prod"
            ? "The dev-postgres demo machine on Fly.io isn't reachable. It's stopped when not in use; approving Fix restarts it and confirms it's back."
            : "Verify Docker Desktop is running and the dev-postgres container is up (mcp-server/dev-postgres/).",
          severity: "warning",
          occurredAt: new Date().toISOString(),
          sourceMode: "live",
        },
      ];
    }
  },
};
