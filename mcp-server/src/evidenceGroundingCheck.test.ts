import { describe, it, expect } from "vitest";
import { checkEvidenceGrounding } from "./evidenceGroundingCheck.js";
import type { EvidenceItem } from "./rootCauseAgent.js";

function baseEvidence(overrides: Partial<EvidenceItem>[] = []): EvidenceItem[] {
  const defaults: EvidenceItem[] = [
    { id: "sql:sys.dm_exec_requests:61:0", source: "sys.dm_exec_requests", data: { session_id: 61 } },
    { id: "sql:sys.dm_exec_requests:52:1", source: "sys.dm_exec_requests", data: { session_id: 52 } },
  ];
  return overrides.length > 0 ? (overrides as EvidenceItem[]) : defaults;
}

describe("checkEvidenceGrounding", () => {
  it("happy path: every cited id exists in the evidence given — grounded, no violations", () => {
    const evidence = baseEvidence();
    const result = checkEvidenceGrounding(evidence, ["sql:sys.dm_exec_requests:61:0"]);
    expect(result).toEqual({ grounded: true, violations: [] });
  });

  it("CITED_EVIDENCE_NOT_FOUND: a cited id that doesn't exist in the evidence is flagged", () => {
    const evidence = baseEvidence();
    const result = checkEvidenceGrounding(evidence, ["evt-does-not-exist"]);
    expect(result.grounded).toBe(false);
    expect(result.violations).toContain("CITED_EVIDENCE_NOT_FOUND");
  });

  it("NO_EVIDENCE_CITED: evidence was available but nothing was cited", () => {
    const evidence = baseEvidence();
    const result = checkEvidenceGrounding(evidence, []);
    expect(result.grounded).toBe(false);
    expect(result.violations).toContain("NO_EVIDENCE_CITED");
  });

  it("boundary: no evidence and no citation is grounded — nothing to cite, nothing wrongly cited", () => {
    const result = checkEvidenceGrounding([], []);
    expect(result).toEqual({ grounded: true, violations: [] });
  });

  it("reports both violations simultaneously, not just the first", () => {
    const evidence = baseEvidence();
    const result = checkEvidenceGrounding(evidence, ["evt-does-not-exist"]);
    // NO_EVIDENCE_CITED does not apply here (something was cited, just not real) —
    // this proves CITED_EVIDENCE_NOT_FOUND alone doesn't also trip NO_EVIDENCE_CITED.
    expect(result.violations).toEqual(["CITED_EVIDENCE_NOT_FOUND"]);
  });

  it("a mix of real and fabricated citations is still flagged", () => {
    const evidence = baseEvidence();
    const result = checkEvidenceGrounding(evidence, [
      "sql:sys.dm_exec_requests:61:0",
      "evt-does-not-exist",
    ]);
    expect(result.grounded).toBe(false);
    expect(result.violations).toEqual(["CITED_EVIDENCE_NOT_FOUND"]);
  });

  it("is pure: identical input twice yields identical, unmutated output", () => {
    const evidence = baseEvidence();
    const evidenceIdsUsed = ["sql:sys.dm_exec_requests:61:0"];
    const evidenceSnapshot = JSON.parse(JSON.stringify(evidence));
    const idsSnapshot = JSON.parse(JSON.stringify(evidenceIdsUsed));

    const first = checkEvidenceGrounding(evidence, evidenceIdsUsed);
    const second = checkEvidenceGrounding(evidence, evidenceIdsUsed);

    expect(first).toEqual(second);
    expect(evidence).toEqual(evidenceSnapshot);
    expect(evidenceIdsUsed).toEqual(idsSnapshot);
  });
});
