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

// A connector that never settles must not stall the whole feed. This is only a
// backstop for a source that hangs forever. It MUST sit above every source's
// own worst-case failure time, or a source that is genuinely down (which a
// connector like PostgreSQL reports as an "unreachable" incident) gets cut off
// first and misread as "couldn't check". Each source module retries up to 3
// times with a 10s per-attempt timeout and up to 4s backoff: 4 x 10s + 0.5s +
// 1s + 2s = about 44s worst case. Found in production on 2026-10-05, when an
// earlier 10s value hid the stopped demo machines' "unreachable" incidents.
export const SOURCE_WORST_CASE_MS = 4 * 10_000 + 500 + 1_000 + 2_000;
export const CONNECTOR_TIMEOUT_MS = 60_000;

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
