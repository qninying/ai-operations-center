import { queryLiveCloudBlob } from "../cloudBlobSource.js";
import { recordCheckSuccess, recordCheckFailure } from "./sourceCheck.js";
import type { IncidentSeverity, SourceConnector } from "./types.js";

function normalizeCloudSeverity(raw: string): IncidentSeverity {
  const lower = raw.toLowerCase();
  if (lower === "critical") return "critical";
  if (lower === "error") return "error";
  return "warning";
}

// SSIS package-run and cloud diagnostics from Azure Blob Storage.
export const cloudConnector: SourceConnector = {
  id: "cloud",
  system: "SSIS",
  reachabilityName: "cloud",
  async discoverIncidents() {
    try {
      const records = await queryLiveCloudBlob();
      recordCheckSuccess(cloudConnector, { recordCount: records.length });
      return records.map((record, index) => ({
        id: `cloud:${record.service}:${record.timestamp}:${index}`,
        source: "cloud",
        title: `${record.service}: ${record.severity}`,
        detail: record.message,
        severity: normalizeCloudSeverity(record.severity),
        occurredAt: record.timestamp,
        sourceMode: "live" as const,
      }));
    } catch (error) {
      // No fixture fallback here (never present fixture data as a real cloud
      // finding): an unreachable Blob container means "can't check this source",
      // same as SQL/SSRS's live-source failure path, not a finding of its own.
      recordCheckFailure(cloudConnector, error);
      throw error;
    }
  },
};
