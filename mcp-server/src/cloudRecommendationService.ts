import { z } from "zod";
import { queryLiveCloudBlob } from "./cloudBlobSource.js";
import { analyzeIncidentRootCause } from "./rootCauseAgent.js";
import type { EvidenceItem, Incident, RootCauseResult } from "./rootCauseAgent.js";
import { checkEvidenceGrounding } from "./evidenceGroundingCheck.js";
import type { GroundingResult } from "./evidenceGroundingCheck.js";
import { logEvent } from "./observability/logger.js";
import { recordSystemEvent } from "./observability/auditWrite.js";
import type { AuditLog } from "../../guardrails/auditLog.js";

// STORY-007 / REQ-008 + REQ-013: wires real Azure Blob Storage cloud-service data
// into a real AI recommendation — the cloud-service counterpart to
// recommendationService.ts's SQL Server path. Deliberately its own module rather than
// a branch inside recommendationService.ts: the two evidence sources have unrelated
// failure modes and schemas, and recommendationService.ts already has a single,
// specific responsibility (SQL Server evidence -> recommendation).
//
// Calls queryLiveCloudBlob() directly — never falls back to fixture data and presents
// it as real. No live connection means no recommendation attempt, not a silent
// substitution, same rule the SQL Server path established.
//
// Reuses analyzeIncidentRootCause() from STORY-003 as-is — this module is the glue
// between real cloud evidence and the existing agent, not a new AI path.

export class CloudServiceUnavailableError extends Error {
  readonly errorClass = "CloudServiceUnavailableError" as const;
  constructor(cause: unknown) {
    super(
      `Cloud service is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "CloudServiceUnavailableError";
    this.cause = cause;
  }
}

export class InvalidCloudDataFormatError extends Error {
  readonly errorClass = "InvalidCloudDataFormatError" as const;
  constructor(cause: unknown) {
    super(
      `Cloud service returned data that didn't match the expected diagnostic record shape: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "InvalidCloudDataFormatError";
    this.cause = cause;
  }
}

// Validated before use, not just typed at compile time — same convention as
// recommendationService.ts's DmvExecRequestRowSchema: a live blob download is
// external I/O, so it's checked against its expected shape before being trusted as
// evidence, rather than assuming cloudBlobSource.ts's compile-time cast held true.
const CloudDiagnosticRecordSchema = z.object({
  timestamp: z.string(),
  service: z.string(),
  severity: z.string(),
  message: z.string(),
});

function recordsToEvidence(records: unknown[]): EvidenceItem[] {
  return records.map((record, index) => {
    const parsed = CloudDiagnosticRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new InvalidCloudDataFormatError(parsed.error);
    }
    return {
      id: `cloud:${parsed.data.service}:${parsed.data.timestamp}:${index}`,
      source: "cloud-blob-diagnostics",
      data: parsed.data,
    };
  });
}

export interface GenerateCloudRecommendationOptions {
  // Injection points for tests — mirrors the pattern already used in
  // recommendationService.ts / rootCauseAgent.ts.
  queryFn?: typeof queryLiveCloudBlob;
  analyzeFn?: typeof analyzeIncidentRootCause;
  // ADR-002 step 3 — see recommendationService.ts's identical field for the full
  // rationale.
  auditLog?: AuditLog;
}

// Throws CloudServiceUnavailableError for ANY live-source failure (unreachable,
// timeout, circuit open — queryLiveCloudBlob()'s own reliability wrapper already
// distinguishes these; this collapses them into one outcome, since "connection
// failure" and "data retrieval timeout" get the same honest response: no
// recommendation, a clear notification instead) or InvalidCloudDataFormatError for a
// malformed record. Never falls back to fixture data and calls the result real.
export async function generateCloudRecommendation(
  incidentId: string,
  incidentDescription: string,
  options: GenerateCloudRecommendationOptions = {}
): Promise<RootCauseResult & { grounding: GroundingResult }> {
  const queryFn = options.queryFn ?? queryLiveCloudBlob;
  const analyzeFn = options.analyzeFn ?? analyzeIncidentRootCause;

  let rawRecords: unknown[];
  try {
    rawRecords = await queryFn();
  } catch (error) {
    const errorClass = error instanceof Error ? error.name : "Error";
    logEvent({
      level: "error",
      event: "cloud_recommendation_data_access",
      context: { incidentId, outcome: "failure", errorClass },
    });
    recordSystemEvent(options.auditLog, "cloudRecommendationService", "cloud_recommendation_data_access", "failure", { errorClass }, incidentId);
    throw new CloudServiceUnavailableError(error);
  }

  let evidence: EvidenceItem[];
  try {
    evidence = recordsToEvidence(rawRecords);
  } catch (error) {
    const errorClass = error instanceof Error ? error.name : "Error";
    logEvent({
      level: "error",
      event: "cloud_recommendation_data_access",
      context: { incidentId, outcome: "failure", errorClass },
    });
    recordSystemEvent(options.auditLog, "cloudRecommendationService", "cloud_recommendation_data_access", "failure", { errorClass }, incidentId);
    throw error;
  }

  logEvent({
    level: "info",
    event: "cloud_recommendation_data_access",
    context: { incidentId, outcome: "success", recordCount: evidence.length },
  });
  recordSystemEvent(options.auditLog, "cloudRecommendationService", "cloud_recommendation_data_access", "success", { recordCount: evidence.length }, incidentId);

  const incident: Incident = { id: incidentId, description: incidentDescription, evidence };
  const result = await analyzeFn(incident);
  const grounding = checkEvidenceGrounding(evidence, result.evidenceIdsUsed);
  return { ...result, grounding };
}
