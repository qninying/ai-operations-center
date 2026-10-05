import { sqlServerConnector } from "./sqlServerConnector.js";
import { ssrsConnector } from "./ssrsConnector.js";
import { cloudConnector } from "./cloudConnector.js";
import { supersetConnector } from "./supersetConnector.js";
import { postgresConnector } from "./postgresConnector.js";
import type { DashboardIncident, SourceConnector } from "./types.js";

export type { DashboardIncident, IncidentSeverity, IncidentSource, SourceConnector } from "./types.js";

// REQ-018 / STORY-013: the connector registry. To add a data source, write a
// file exporting a SourceConnector (see ./types.ts) and add it to this list.
// That is the only edit outside the new file: the incident feed, the
// reachability record behind GET /health/dependencies, and the Command Center's
// repo inventory all read this registry. See ADR-016.
const REGISTERED: readonly SourceConnector[] = [
  sqlServerConnector,
  ssrsConnector,
  cloudConnector,
  supersetConnector,
  postgresConnector,
];

// A connector that never settles must not stall the whole feed. Each source
// module already has its own timeouts; this is the backstop, generous enough
// to sit above them (the slowest, SQL Server, retries within ~3s per attempt).
export const CONNECTOR_TIMEOUT_MS = 10_000;

export class DuplicateConnectorError extends Error {
  readonly errorClass = "DuplicateConnectorError" as const;
  constructor(field: "id" | "reachabilityName", value: string) {
    super(`Two connectors share the same ${field} "${value}". Each connector's id and reachabilityName must be unique.`);
    this.name = "DuplicateConnectorError";
  }
}

export class ConnectorTimeoutError extends Error {
  readonly errorClass = "ConnectorTimeoutError" as const;
  constructor(connectorId: string, timeoutMs: number) {
    super(`Connector "${connectorId}" did not finish within ${timeoutMs}ms`);
    this.name = "ConnectorTimeoutError";
  }
}

// Fails fast at startup rather than silently letting one connector shadow
// another's incidents or reachability record.
export function validateConnectors(connectors: readonly SourceConnector[]): readonly SourceConnector[] {
  for (const field of ["id", "reachabilityName"] as const) {
    const seen = new Set<string>();
    for (const c of connectors) {
      if (seen.has(c[field])) throw new DuplicateConnectorError(field, c[field]);
      seen.add(c[field]);
    }
  }
  return connectors;
}

let active: readonly SourceConnector[] = validateConnectors(REGISTERED);

export function getConnectors(): readonly SourceConnector[] {
  return active;
}

// Runs one connector with the backstop timeout. Rejects (never resolves to [])
// on timeout, so the feed treats a hung source as "couldn't check", not "clear".
export function discoverWithTimeout(
  connector: SourceConnector,
  timeoutMs: number = CONNECTOR_TIMEOUT_MS
): Promise<DashboardIncident[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConnectorTimeoutError(connector.id, timeoutMs)), timeoutMs);
  });
  return Promise.race([connector.discoverIncidents(), timeout]).finally(() => clearTimeout(timer));
}

// Test seam: swap the registry (validated the same way) and restore it.
export function __setConnectorsForTests(connectors: readonly SourceConnector[]): void {
  active = validateConnectors(connectors);
}
export function __resetConnectorsForTests(): void {
  active = validateConnectors(REGISTERED);
}
