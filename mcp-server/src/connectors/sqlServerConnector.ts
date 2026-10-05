import { readDmv } from "../dmvReader.js";
import { recordCheckSuccess, recordCheckFailure } from "./sourceCheck.js";
import type { SourceConnector } from "./types.js";

// SQL Server blocking chains, read from the DMVs (dmvReader.ts, which falls back
// to clearly-tagged fixture data when the live server is unreachable).
export const sqlServerConnector: SourceConnector = {
  id: "sql",
  system: "SQL Server",
  reachabilityName: "sql",
  async discoverIncidents() {
    try {
      const result = await readDmv({ dmvName: "sys.dm_exec_requests" });
      recordCheckSuccess(sqlServerConnector, { sourceMode: result.source, rowCount: result.rows.length });
      return result.rows
        .filter((row) => row.blocking_session_id && row.blocking_session_id !== 0)
        .map((row) => ({
          id: `sql:session:${row.session_id}`,
          source: "sql",
          title: `Session ${row.session_id} blocked by session ${row.blocking_session_id}`,
          detail: `${row.command} on ${row.database_name} — ${row.status}${row.wait_type ? " · " + row.wait_type : ""}`,
          severity: "error" as const,
          occurredAt: new Date().toISOString(),
          sourceMode: result.source,
        }));
    } catch (error) {
      recordCheckFailure(sqlServerConnector, error);
      // Re-thrown, not swallowed into []: the feed's Promise.allSettled tells
      // "checked, genuinely clear" (fulfilled, []) apart from "couldn't check"
      // (rejected). Collapsing both into [] would make the feed's pruning treat a
      // transient SQL Server outage as proof every active session cleared.
      throw error;
    }
  },
};
