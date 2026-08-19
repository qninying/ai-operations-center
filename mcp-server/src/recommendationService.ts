import { z } from "zod";
import { queryLiveDmv } from "./dmvLiveSource.js";
import { analyzeIncidentRootCause } from "./rootCauseAgent.js";
import type { EvidenceItem, Incident, RootCauseResult } from "./rootCauseAgent.js";
import { logEvent } from "./observability/logger.js";

// STORY-006 / REQ-007 + REQ-013: wires real SQL Server data into a real AI
// recommendation. Deliberately calls queryLiveDmv() directly rather than going
// through dmvReader.ts's readDmv() orchestrator — readDmv() falls back to fixture
// data on any live-source failure, which is the right behavior for the general-
// purpose DMV read tool, but wrong here: presenting an "AI-driven recommendation
// using SQL Server data" that was actually generated from fixture data would be
// exactly the kind of fabrication rootCauseAgent.ts was built to refuse. No live
// connection means no recommendation attempt, not a silent substitution.
//
// Reuses analyzeIncidentRootCause() from STORY-003 as-is — this module is the glue
// between real evidence and the existing agent, not a new AI path.

export class SqlServerUnavailableError extends Error {
  readonly errorClass = "SqlServerUnavailableError" as const;
  constructor(cause: unknown) {
    super(
      `SQL Server is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "SqlServerUnavailableError";
    this.cause = cause;
  }
}

export class InvalidDataFormatError extends Error {
  readonly errorClass = "InvalidDataFormatError" as const;
  constructor(cause: unknown) {
    super(
      `SQL Server returned data that didn't match the expected DMV row shape: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "InvalidDataFormatError";
    this.cause = cause;
  }
}

// Validated before use, not just typed at compile time — a live query is external
// I/O, and this repo's own convention (rootCauseAgent.ts, diagnosticsGatherer.ts) is
// to validate anything crossing a real external boundary before trusting it, not
// just assume the TypeScript type describes what actually comes back.
const DmvExecRequestRowSchema = z.object({
  session_id: z.number(),
  status: z.string(),
  command: z.string(),
  wait_type: z.string().nullable(),
  blocking_session_id: z.number(),
  cpu_time_ms: z.number(),
  total_elapsed_time_ms: z.number(),
  database_name: z.string(),
});

function rowsToEvidence(rows: unknown[]): EvidenceItem[] {
  return rows.map((row, index) => {
    const parsed = DmvExecRequestRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new InvalidDataFormatError(parsed.error);
    }
    return {
      id: `sql:sys.dm_exec_requests:${parsed.data.session_id}:${index}`,
      source: "sys.dm_exec_requests",
      data: parsed.data,
    };
  });
}

export interface GenerateRecommendationOptions {
  // Injection points for tests — mirrors the callModel pattern already used in
  // rootCauseAgent.ts/diagnosticsGatherer.ts.
  queryFn?: typeof queryLiveDmv;
  analyzeFn?: typeof analyzeIncidentRootCause;
}

// Throws SqlServerUnavailableError for ANY live-source failure (unreachable,
// timeout, circuit open — queryLiveDmv()'s own reliability wrapper already
// distinguishes these; this collapses them into one outcome, since "connection
// failure" and "data retrieval timeout" get the same honest response: no
// recommendation, a clear notification instead) or InvalidDataFormatError for a
// malformed row. Never falls back to fixture data and calls the result real.
export async function generateRecommendation(
  incidentId: string,
  incidentDescription: string,
  options: GenerateRecommendationOptions = {}
): Promise<RootCauseResult> {
  const queryFn = options.queryFn ?? queryLiveDmv;
  const analyzeFn = options.analyzeFn ?? analyzeIncidentRootCause;

  let rawRows: unknown[];
  try {
    rawRows = await queryFn({ dmvName: "sys.dm_exec_requests" });
  } catch (error) {
    logEvent({
      level: "error",
      event: "recommendation_data_access",
      context: {
        incidentId,
        outcome: "failure",
        errorClass: error instanceof Error ? error.name : "Error",
      },
    });
    throw new SqlServerUnavailableError(error);
  }

  let evidence: EvidenceItem[];
  try {
    evidence = rowsToEvidence(rawRows);
  } catch (error) {
    logEvent({
      level: "error",
      event: "recommendation_data_access",
      context: {
        incidentId,
        outcome: "failure",
        errorClass: error instanceof Error ? error.name : "Error",
      },
    });
    throw error;
  }

  logEvent({
    level: "info",
    event: "recommendation_data_access",
    context: { incidentId, outcome: "success", rowCount: evidence.length },
  });

  const incident: Incident = { id: incidentId, description: incidentDescription, evidence };
  return analyzeFn(incident);
}
