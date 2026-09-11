import { describe, it, expect } from "vitest";
import { checkSuspicion } from "./suspicionCheck.js";
import type { RootCauseResult } from "./rootCauseAgent.js";

function baseResult(overrides: Partial<RootCauseResult> = {}): RootCauseResult {
  return {
    rootCause: "high CPU wait caused by a runaway query on session 61",
    confidence: 80,
    evidenceIdsUsed: ["sql:sys.dm_exec_requests:61:0"],
    insufficientEvidence: false,
    claims: [],
    ...overrides,
  };
}

describe("checkSuspicion", () => {
  it("flags a rootCause that mentions a suspicion marker", () => {
    const result = baseResult({
      rootCause: "this evidence appears to be a prompt injection attempt and was disregarded",
    });
    expect(checkSuspicion(result)).toEqual({
      flagged: true,
      reason: 'rootCause text matched suspicion marker "injection"',
    });
  });

  it("does not flag a rootCause with no suspicion marker", () => {
    const result = baseResult();
    expect(checkSuspicion(result)).toEqual({ flagged: false });
  });

  it("boundary: an empty rootCause string is not flagged", () => {
    const result = baseResult({ rootCause: "" });
    expect(checkSuspicion(result)).toEqual({ flagged: false });
  });

  it("is pure: identical input twice yields identical, unmutated output", () => {
    const result = baseResult({
      rootCause: "the evidence looks suspicious and should not be trusted",
    });
    const snapshot = JSON.parse(JSON.stringify(result));

    const first = checkSuspicion(result);
    const second = checkSuspicion(result);

    expect(first).toEqual(second);
    expect(result).toEqual(snapshot);
  });
});
