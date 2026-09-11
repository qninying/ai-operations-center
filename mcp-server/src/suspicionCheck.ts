import type { RootCauseResult } from "./rootCauseAgent.js";

// Detects whether a rootCause's own text flagged the evidence it was given as
// suspicious/manipulated — a keyword-substring heuristic, not a semantic check.
// Pure and deterministic — no I/O, safe to call on every recommendation, same
// convention as evidenceGroundingCheck.ts and guardrails/remediationGuardrail.ts.
//
// Detection/logging signal only, not a blocking gate — ADR-008/ADR-009 already
// considered and rejected keyword-scanning as a live gate on evidence content
// (false-positive risk on legitimate diagnostic text is too high to block on).
// This exists to record and surface the signal, not to refuse a recommendation
// because of it.

const SUSPICION_MARKERS = [
  "injection",
  "suspicious",
  "not legitimate",
  "not a legitimate",
  "should not be trusted",
  "attempt to manipulate",
  "manipulation",
  "instruction embedded",
  "embedded instruction",
  "untrusted",
  "disregard",
  "not a directive",
  "not an instruction",
  "attempting to",
  "ignore",
];

export function mentionsSuspicion(text: string): boolean {
  const lower = text.toLowerCase();
  return SUSPICION_MARKERS.some((marker) => lower.includes(marker));
}

export interface SuspicionResult {
  flagged: boolean;
  reason?: string;
}

export function checkSuspicion(result: RootCauseResult): SuspicionResult {
  const lower = result.rootCause.toLowerCase();
  const matched = SUSPICION_MARKERS.find((marker) => lower.includes(marker));
  if (!matched) {
    return { flagged: false };
  }
  return { flagged: true, reason: `rootCause text matched suspicion marker "${matched}"` };
}
