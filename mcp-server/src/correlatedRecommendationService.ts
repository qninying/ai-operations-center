import { z } from "zod";
import { queryLiveDmv } from "./dmvLiveSource.js";
import { querySsrsExecutionLog } from "./ssrsLiveSource.js";
import { analyzeIncidentRootCause } from "./rootCauseAgent.js";
import type { EvidenceItem, Incident, RootCauseResult } from "./rootCauseAgent.js";
import { InvalidDataFormatError } from "./recommendationService.js";
import { checkEvidenceGrounding } from "./evidenceGroundingCheck.js";
import type { GroundingResult } from "./evidenceGroundingCheck.js";
import { logEvent } from "./observability/logger.js";
import { recordSystemEvent } from "./observability/auditWrite.js";
import type { AuditLog } from "../../guardrails/auditLog.js";

// REQ-017: "reduce manual incident correlation across systems by 50-70%."
// recommendationService.ts (SQL Server DMVs) and cloudRecommendationService.ts
// (Azure Blob) each analyze exactly one system's evidence per incident — nothing
// in this repo ever combined evidence from more than one system before this file.
// SSRS's own live reader (ssrsLiveSource.ts) existed but was wired into nothing
// except the MCP tool gateway and a demo script.
//
// This gathers evidence from SQL Server DMVs AND SSRS ExecutionLog3 for one
// incident and hands it ALL to a single analyzeIncidentRootCause() call —
// correlation happens at the LLM reasoning layer, not via a fabricated join key.
// DmvExecRequestRow carries no timestamp (DMVs show live current state, not
// history); SsrsExecutionLogRow carries no database-name-equivalent field. There
// is no real shared key between the two row shapes anywhere in this codebase, so
// a SQL-style join was deliberately rejected — it would mean inventing a
// relationship the data doesn't actually contain, the same class of fabrication
// rootCauseAgent.ts's "non-fabricated when thin" principle already refuses at
// the single-source level. This is the real replacement for the manual work
// REQ-017 names: today a human separately queries SQL Server, separately
// queries SSRS, and manually cross-references both outputs by hand.
//
// Honest scope: this closes the functional gap (cross-system evidence gathering
// now genuinely exists). It does not, and cannot, demonstrate the requirement's
// literal 50-70% figure from a single change — that's a measured production
// outcome with no usage history yet to compute it against. See
// docs/REQUIREMENTS.md's REQ-017 entry.

export class AllEvidenceSourcesUnavailableError extends Error {
  readonly errorClass = "AllEvidenceSourcesUnavailableError" as const;
  constructor(
    readonly dmvCause: unknown,
    readonly ssrsCause: unknown
  ) {
    super(
      `Both evidence sources are unavailable — SQL Server: ${
        dmvCause instanceof Error ? dmvCause.message : String(dmvCause)
      }; SSRS: ${ssrsCause instanceof Error ? ssrsCause.message : String(ssrsCause)}`
    );
    this.name = "AllEvidenceSourcesUnavailableError";
  }
}

export class InvalidSsrsDataFormatError extends Error {
  readonly errorClass = "InvalidSsrsDataFormatError" as const;
  constructor(cause: unknown) {
    super(
      `SSRS returned data that didn't match the expected execution-log row shape: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "InvalidSsrsDataFormatError";
    this.cause = cause;
  }
}

// Same DMV row schema recommendationService.ts validates against — kept as its
// own local copy here (matching the established "each file owns its own
// transform" convention between recommendationService.ts and
// cloudRecommendationService.ts) rather than importing a private schema. Only
// the thrown error class (InvalidDataFormatError) is shared, so a malformed DMV
// row means the same thing and is caught the same way on either route.
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

function dmvRowsToEvidence(rows: unknown[]): EvidenceItem[] {
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

const SsrsExecutionLogRowSchema = z.object({
  instance_name: z.string(),
  report_path: z.string(),
  user_name: z.string(),
  status: z.string(),
  time_start: z.string(),
  time_end: z.string().nullable(),
  time_data_retrieval_ms: z.number(),
  time_processing_ms: z.number(),
  time_rendering_ms: z.number(),
});

function ssrsRowsToEvidence(rows: unknown[]): EvidenceItem[] {
  return rows.map((row, index) => {
    const parsed = SsrsExecutionLogRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new InvalidSsrsDataFormatError(parsed.error);
    }
    return {
      id: `ssrs:${parsed.data.report_path}:${parsed.data.time_start}:${index}`,
      source: "ssrs-execution-log",
      data: parsed.data,
    };
  });
}

export type EvidenceSourceName = "sql-server" | "ssrs";

export interface CorrelatedRecommendationResult extends RootCauseResult {
  // false only when both sources contributed evidence — a plain, checkable
  // signal that this was a genuine two-system correlation, not a silent
  // single-source fallback dressed up as one.
  partialCorrelation: boolean;
  unavailableSources: EvidenceSourceName[];
  grounding: GroundingResult;
}

export interface GenerateCorrelatedRecommendationOptions {
  // Injection points for tests — mirrors the queryFn/analyzeFn pattern already
  // used in recommendationService.ts/cloudRecommendationService.ts.
  dmvQueryFn?: typeof queryLiveDmv;
  ssrsQueryFn?: typeof querySsrsExecutionLog;
  analyzeFn?: typeof analyzeIncidentRootCause;
  // Optional passthrough filter, same as the MCP tool's own reportPath param.
  reportPath?: string;
  // ADR-002 step 3.
  auditLog?: AuditLog;
}

// Throws AllEvidenceSourcesUnavailableError only when BOTH sources fail — never
// falls back to fixture data on either side. Throws InvalidDataFormatError or
// InvalidSsrsDataFormatError for a malformed row from either source, regardless
// of whether the other source succeeded: unreachable and reached-but-malformed
// are different failure classes, and a malformed row is never silently dropped
// from evidence just because the other system's data looked fine. When exactly
// one source fails to connect, this does NOT throw — it proceeds with the
// evidence that did come back and reports partialCorrelation/unavailableSources
// honestly, the same "never refuse thin evidence, only refuse zero evidence"
// precedent rootCauseAgent.ts already follows for a single source.
export async function generateCorrelatedRecommendation(
  incidentId: string,
  incidentDescription: string,
  options: GenerateCorrelatedRecommendationOptions = {}
): Promise<CorrelatedRecommendationResult> {
  const dmvQueryFn = options.dmvQueryFn ?? queryLiveDmv;
  const ssrsQueryFn = options.ssrsQueryFn ?? querySsrsExecutionLog;
  const analyzeFn = options.analyzeFn ?? analyzeIncidentRootCause;

  const [dmvSettled, ssrsSettled] = await Promise.allSettled([
    dmvQueryFn({ dmvName: "sys.dm_exec_requests" }),
    ssrsQueryFn({ queryName: "ExecutionLog3", reportPath: options.reportPath }),
  ]);

  function record(source: EvidenceSourceName, outcome: "success" | "failure", context: Record<string, unknown>): void {
    logEvent({
      level: outcome === "success" ? "info" : "error",
      event: "correlated_recommendation_data_access",
      context: { incidentId, source, outcome, ...context },
    });
    recordSystemEvent(
      options.auditLog,
      "correlatedRecommendationService",
      "correlated_recommendation_data_access",
      outcome,
      { source, ...context },
      incidentId
    );
  }

  const unavailableSources: EvidenceSourceName[] = [];
  let dmvEvidence: EvidenceItem[] = [];
  let ssrsEvidence: EvidenceItem[] = [];
  // A malformed row is a hard stop, but both sources still get evaluated and
  // logged before it's thrown — Trust: every data access attempt is logged,
  // regardless of whether the overall call ultimately succeeds. Captured here
  // rather than thrown immediately so the second source's attempt isn't skipped.
  let hardStopError: unknown;

  if (dmvSettled.status === "fulfilled") {
    try {
      dmvEvidence = dmvRowsToEvidence(dmvSettled.value);
      record("sql-server", "success", { rowCount: dmvEvidence.length });
    } catch (error) {
      record("sql-server", "failure", { errorClass: error instanceof Error ? error.name : "Error" });
      hardStopError = error;
    }
  } else {
    unavailableSources.push("sql-server");
    record("sql-server", "failure", {
      errorClass: dmvSettled.reason instanceof Error ? dmvSettled.reason.name : "Error",
    });
  }

  if (ssrsSettled.status === "fulfilled") {
    try {
      ssrsEvidence = ssrsRowsToEvidence(ssrsSettled.value);
      record("ssrs", "success", { rowCount: ssrsEvidence.length });
    } catch (error) {
      record("ssrs", "failure", { errorClass: error instanceof Error ? error.name : "Error" });
      hardStopError = hardStopError ?? error;
    }
  } else {
    unavailableSources.push("ssrs");
    record("ssrs", "failure", {
      errorClass: ssrsSettled.reason instanceof Error ? ssrsSettled.reason.name : "Error",
    });
  }

  if (hardStopError) {
    throw hardStopError;
  }

  if (unavailableSources.length === 2) {
    throw new AllEvidenceSourcesUnavailableError(
      dmvSettled.status === "rejected" ? dmvSettled.reason : undefined,
      ssrsSettled.status === "rejected" ? ssrsSettled.reason : undefined
    );
  }

  const incident: Incident = {
    id: incidentId,
    description: incidentDescription,
    evidence: [...dmvEvidence, ...ssrsEvidence],
  };
  const result = await analyzeFn(incident);
  const grounding = checkEvidenceGrounding(incident.evidence, result.evidenceIdsUsed, result.claims);
  return { ...result, partialCorrelation: unavailableSources.length > 0, unavailableSources, grounding };
}
