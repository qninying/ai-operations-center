import type { EvidenceItem } from "./rootCauseAgent.js";

// See docs/ADR-008-evidence-grounding-check.md for the full decision record.
//
// Verifies an LLM's cited evidence IDs actually point at evidence it was given —
// catches a hallucinated/invented citation, and catches citing nothing when real
// evidence existed. Pure and deterministic — no I/O, safe to call on every
// recommendation, same convention as guardrails/remediationGuardrail.ts.
//
// Deliberately NOT a correctness check: it cannot tell you whether the rootCause
// text is causally right, only whether the citations backing it are real. That's a
// narrower claim on purpose — see the ADR for why semantic/per-source verification
// was considered and rejected for this version.

export type GroundingViolation = "CITED_EVIDENCE_NOT_FOUND" | "NO_EVIDENCE_CITED";

export interface GroundingResult {
  grounded: boolean;
  violations: GroundingViolation[];
}

export function checkEvidenceGrounding(
  evidence: EvidenceItem[],
  evidenceIdsUsed: string[]
): GroundingResult {
  const violations: GroundingViolation[] = [];
  const knownIds = new Set(evidence.map((e) => e.id));

  const citedUnknown = evidenceIdsUsed.some((id) => !knownIds.has(id));
  if (citedUnknown) {
    violations.push("CITED_EVIDENCE_NOT_FOUND");
  }

  if (evidence.length > 0 && evidenceIdsUsed.length === 0) {
    violations.push("NO_EVIDENCE_CITED");
  }

  return { grounded: violations.length === 0, violations };
}
