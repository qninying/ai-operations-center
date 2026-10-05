import { readSsrsExecutionLog } from "../ssrsReader.js";
import { recordCheckSuccess, recordCheckFailure } from "./sourceCheck.js";
import type { SourceConnector } from "./types.js";

// SSRS report runs from ExecutionLog3 (ssrsReader.ts, with a tagged fixture
// fallback when the live database is unreachable).
export const ssrsConnector: SourceConnector = {
  id: "ssrs",
  system: "SSRS",
  reachabilityName: "ssrs",
  async discoverIncidents() {
    try {
      const result = await readSsrsExecutionLog({ queryName: "ExecutionLog3" });
      recordCheckSuccess(ssrsConnector, { sourceMode: result.source, rowCount: result.rows.length });
      return result.rows.map((row, index) => ({
        id: `ssrs:${row.report_path}:${row.time_start}:${index}`,
        source: "ssrs",
        title: `SSRS report ${row.report_path} — ${row.status}`,
        detail: `Run by ${row.user_name}, started ${row.time_start}`,
        severity: "error" as const,
        occurredAt: row.time_start,
        sourceMode: result.source,
      }));
    } catch (error) {
      recordCheckFailure(ssrsConnector, error);
      throw error;
    }
  },
};
