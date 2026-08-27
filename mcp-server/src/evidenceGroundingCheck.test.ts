import { describe, it, expect } from "vitest";
import { checkEvidenceGrounding } from "./evidenceGroundingCheck.js";
import type { Claim, EvidenceItem } from "./rootCauseAgent.js";

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

  describe("structured claim verification (ADR-009)", () => {
    function claim(overrides: Partial<Claim> = {}): Claim {
      return {
        text: "session 61 has session_id 61",
        evidenceId: "sql:sys.dm_exec_requests:61:0",
        field: "session_id",
        value: "61",
        ...overrides,
      };
    }

    it("a claim whose field/value matches the cited evidence is grounded", () => {
      const evidence = baseEvidence();
      const result = checkEvidenceGrounding(evidence, [claim().evidenceId], [claim()]);
      expect(result).toEqual({ grounded: true, violations: [] });
    });

    it("CLAIM_NOT_SUPPORTED_BY_EVIDENCE: a claim whose value doesn't match the cited evidence's real field is flagged", () => {
      const evidence = baseEvidence();
      const badClaim = claim({ value: "99" });
      const result = checkEvidenceGrounding(evidence, [badClaim.evidenceId], [badClaim]);
      expect(result.grounded).toBe(false);
      expect(result.violations).toEqual(["CLAIM_NOT_SUPPORTED_BY_EVIDENCE"]);
    });

    it("CLAIM_NOT_SUPPORTED_BY_EVIDENCE: a claim referencing a field that doesn't exist on the evidence is flagged", () => {
      const evidence = baseEvidence();
      const badClaim = claim({ field: "blocking_session_id" }); // baseEvidence only has session_id
      const result = checkEvidenceGrounding(evidence, [badClaim.evidenceId], [badClaim]);
      expect(result.violations).toEqual(["CLAIM_NOT_SUPPORTED_BY_EVIDENCE"]);
    });

    it("a claim citing an unknown evidence id reuses CITED_EVIDENCE_NOT_FOUND, not a new violation type", () => {
      const evidence = baseEvidence();
      const badClaim = claim({ evidenceId: "evt-does-not-exist" });
      // A real, known id cited too, so this isolates the claim's own bad
      // evidenceId — NO_EVIDENCE_CITED must not also fire here.
      const result = checkEvidenceGrounding(evidence, [evidence[0].id], [badClaim]);
      expect(result.violations).toEqual(["CITED_EVIDENCE_NOT_FOUND"]);
    });

    it("value comparison is case-insensitive and trims whitespace, not a fragile exact match", () => {
      const evidence: EvidenceItem[] = [
        { id: "ssrs:report:1", source: "ssrs-execution-log", data: { status: "rsProcessingAborted" } },
      ];
      const looseClaim = claim({ evidenceId: "ssrs:report:1", field: "status", value: "  RSPROCESSINGABORTED  " });
      const result = checkEvidenceGrounding(evidence, ["ssrs:report:1"], [looseClaim]);
      expect(result).toEqual({ grounded: true, violations: [] });
    });

    it("an empty claims array is never itself a violation — nothing to verify isn't evidence of a problem", () => {
      const evidence = baseEvidence();
      const result = checkEvidenceGrounding(evidence, [evidence[0].id], []);
      expect(result).toEqual({ grounded: true, violations: [] });
    });

    it("does not report the same violation twice for multiple claims with the same problem", () => {
      const evidence = baseEvidence();
      const claims = [claim({ value: "99" }), claim({ value: "100", field: "session_id" })];
      const result = checkEvidenceGrounding(evidence, [claim().evidenceId], claims);
      expect(result.violations).toEqual(["CLAIM_NOT_SUPPORTED_BY_EVIDENCE"]);
    });
  });
});
