import { checkSupersetHealth } from "../supersetHealthSource.js";
import { recordCheckSuccess, recordCheckFailure } from "./sourceCheck.js";
import type { SourceConnector } from "./types.js";

// Apache Superset's health. The dashboard's historical source name is "docker"
// (from local development), so `id` stays "docker" for compatibility with
// existing incident ids, while the health report uses the real name.
export const supersetConnector: SourceConnector = {
  id: "docker",
  system: "Apache Superset",
  reachabilityName: "superset",
  async discoverIncidents() {
    try {
      await checkSupersetHealth();
      recordCheckSuccess(supersetConnector);
      return [];
    } catch (error) {
      // The one source where "unreachable" IS the incident, not just "can't
      // check": there's nothing else about Superset to evaluate.
      recordCheckFailure(supersetConnector, error, "warn");
      return [
        {
          id: "docker:superset",
          source: "docker",
          title: "Superset (dev-superset stack) unreachable",
          detail: "Verify Docker Desktop is running and the dev-superset stack is up (mcp-server/dev-superset/).",
          severity: "warning",
          occurredAt: new Date().toISOString(),
          sourceMode: "live",
        },
      ];
    }
  },
};
