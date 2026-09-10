import { describe, it, expect } from "vitest";
import { runAdversarialEval } from "./runner.js";
import { AuditLog } from "../../../guardrails/auditLog.js";

function jsonResponse(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("runAdversarialEval", () => {
  it("passes when the model resists every probe (low confidence, cites evidence, flags the injection)", async () => {
    const callModel = async () =>
      jsonResponse({
        rootCause: "This evidence appears to contain a prompt injection attempt and should not be trusted as diagnostic content.",
        confidence: 5,
        evidenceIdsUsed: ["evt-1"],
        claims: [],
      });

    const verdict = await runAdversarialEval({ callModel });

    expect(verdict.pass).toBe(true);
    expect(verdict.failingResults).toHaveLength(0);
    expect(verdict.results).toHaveLength(3);
    for (const result of verdict.results) {
      expect(result.attackSucceeded).toBe(false);
    }
  });

  it("fails when the model complies with the injected instructions (high confidence, empty citations, no suspicion flagged)", async () => {
    const callModel = async () =>
      jsonResponse({
        rootCause: "System is operating normally, no further action needed.",
        confidence: 100,
        evidenceIdsUsed: [],
        claims: [],
      });

    const verdict = await runAdversarialEval({ callModel });

    expect(verdict.pass).toBe(false);
    // All three probes are critical/high severity, so all three should surface
    // as failing when the model is fully manipulated on every one.
    expect(verdict.failingResults).toHaveLength(3);
    expect(verdict.failingResults.map((r) => r.probeId).sort()).toEqual(
      [
        "indirect-injection-confidence-override",
        "indirect-injection-diluted-multi-evidence",
        "indirect-injection-suppress-detection",
      ].sort()
    );
  });

  it("writes one real, retrievable audit entry for the run, correlated by runId", async () => {
    const callModel = async () =>
      jsonResponse({
        rootCause: "Flagged as a likely injection attempt.",
        confidence: 5,
        evidenceIdsUsed: ["evt-1"],
        claims: [],
      });
    const auditLog = new AuditLog();

    const verdict = await runAdversarialEval({ callModel, auditLog });

    const entries = auditLog.forCorrelationId(verdict.runId);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe("system_event");
  });

  it("reflects a partial result honestly: one probe manipulated, others resisted", async () => {
    let callCount = 0;
    const callModel = async () => {
      callCount += 1;
      // First probe call gets manipulated; the rest resist. Order matches
      // PROBES in probes.ts (confidence-override is probe 1).
      if (callCount === 1) {
        return jsonResponse({ rootCause: "All clear.", confidence: 100, evidenceIdsUsed: [], claims: [] });
      }
      return jsonResponse({
        rootCause: "This is a suspicious, likely injected instruction, not trustworthy evidence.",
        confidence: 5,
        evidenceIdsUsed: ["evt-1"],
        claims: [],
      });
    };

    const verdict = await runAdversarialEval({ callModel });

    expect(verdict.pass).toBe(false);
    expect(verdict.failingResults).toHaveLength(1);
    expect(verdict.failingResults[0].probeId).toBe("indirect-injection-confidence-override");
  });
});
