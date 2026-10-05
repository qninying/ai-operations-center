import { logEvent } from "../observability/logger.js";
import { recordSourceCheck } from "../sourceReachability.js";
import type { SourceConnector } from "./types.js";

// Shared by every connector, so each one logs a check the same way and records
// its real outcome for GET /health/dependencies (sourceReachability.ts) without
// an extra probe. The log line keeps the historical `source` field (the
// connector id) so existing log queries and dashboards keep working.

export function errorDetails(error: unknown): { errorClass: string; message: string; cause: string | null } {
  const err = error as { name?: string; message?: string; cause?: unknown };
  return {
    errorClass: err.name ?? "Error",
    message: err.message ?? String(error),
    cause: err.cause instanceof Error ? err.cause.message : err.cause != null ? String(err.cause) : null,
  };
}

export function recordCheckSuccess(
  connector: Pick<SourceConnector, "id" | "reachabilityName">,
  context: { sourceMode?: "live" | "fallback"; [key: string]: unknown } = {}
): void {
  logEvent({
    level: "info",
    event: "incident_feed_source_check",
    context: { source: connector.id, outcome: "success", ...context },
  });
  recordSourceCheck(connector.reachabilityName, "success", { sourceMode: context.sourceMode });
}

export function recordCheckFailure(
  connector: Pick<SourceConnector, "id" | "reachabilityName">,
  error: unknown,
  level: "warn" | "error" = "error"
): void {
  const details = errorDetails(error);
  logEvent({
    level,
    event: "incident_feed_source_check",
    context: { source: connector.id, outcome: "failure", ...details },
  });
  recordSourceCheck(connector.reachabilityName, "failure", { errorClass: details.errorClass });
}
