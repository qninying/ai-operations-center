import type { Claim, EvidenceItem } from "./rootCauseAgent.js";

// See docs/ADR-008-evidence-grounding-check.md and
// docs/ADR-009-structured-claim-verification.md for the full decision records.
//
// Verifies an LLM's cited evidence IDs actually point at evidence it was given —
// catches a hallucinated/invented citation, and catches citing nothing when real
// evidence existed. ADR-009 extends this one level deeper: for each structured
// claim the model makes about a specific evidence field, verifies the claimed
// value actually matches what that evidence contains — catches citing something
// real but misstating what it says. Pure and deterministic — no I/O, safe to call
// on every recommendation, same convention as guardrails/remediationGuardrail.ts.
//
// Deliberately NOT a correctness check: it cannot tell you whether the rootCause's
// overall conclusion is causally right, only whether the citations and specific
// factual claims backing it are real. That's a narrower claim on purpose — see the
// ADRs for why semantic/per-source verification of the *conclusion* itself was
// considered and rejected for this version.

export type GroundingViolation =
  | "CITED_EVIDENCE_NOT_FOUND"
  | "NO_EVIDENCE_CITED"
  | "CLAIM_NOT_SUPPORTED_BY_EVIDENCE";

export interface GroundingResult {
  grounded: boolean;
  violations: GroundingViolation[];
}

function claimMatches(evidence: EvidenceItem[], claim: Claim): boolean {
  const item = evidence.find((e) => e.id === claim.evidenceId);
  if (!item || typeof item.data !== "object" || item.data === null) {
    return false;
  }
  if (!(claim.field in item.data)) {
    return false;
  }
  const actual = (item.data as Record<string, unknown>)[claim.field];
  return String(actual).trim().toLowerCase() === claim.value.trim().toLowerCase();
}

export function checkEvidenceGrounding(
  evidence: EvidenceItem[],
  evidenceIdsUsed: string[],
  claims: Claim[] = []
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

  // Empty claims is never itself a violation — a response that's mostly
  // synthesis across evidence, with few or no single-field facts, is not
  // wrong for producing few or no claims. Only a present-but-wrong claim is
  // flagged.
  for (const claim of claims) {
    if (!knownIds.has(claim.evidenceId)) {
      if (!violations.includes("CITED_EVIDENCE_NOT_FOUND")) {
        violations.push("CITED_EVIDENCE_NOT_FOUND");
      }
      continue;
    }
    if (!claimMatches(evidence, claim) && !violations.includes("CLAIM_NOT_SUPPORTED_BY_EVIDENCE")) {
      violations.push("CLAIM_NOT_SUPPORTED_BY_EVIDENCE");
    }
  }

  return { grounded: violations.length === 0, violations };
}
