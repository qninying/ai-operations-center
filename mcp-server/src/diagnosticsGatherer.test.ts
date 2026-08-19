import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  gatherAdditionalDiagnostics,
  MalformedResponseError,
  MissingApiKeyError,
} from "./diagnosticsGatherer.js";
import { UpstreamCallFailedError } from "./reliability/withReliability.js";
import * as logger from "./observability/logger.js";
import type { Incident, RootCauseResult } from "./rootCauseAgent.js";

function baseIncident(): Incident {
  return {
    id: "incident-1",
    description: "Session 61 blocked, high CPU on prod-db-01",
    evidence: [
      { id: "evt-1", source: "sys.dm_exec_requests", data: { session_id: 61, blocking_session_id: 52 } },
    ],
  };
}

function lowConfidenceRootCause(confidence = 55): RootCauseResult {
  return {
    rootCause: "Likely a blocking chain, but session 52's own activity is unknown.",
    confidence,
    evidenceIdsUsed: ["evt-1"],
    insufficientEvidence: false,
  };
}

function jsonDiagnostics(items: Array<{ description: string; possibleCause: string }>): string {
  return JSON.stringify({ diagnostics: items });
}

describe("gatherAdditionalDiagnostics", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("REQ-010: does nothing when confidence is already >= 80 — no model call, gathered: false", async () => {
    const callModel = vi.fn();

    const result = await gatherAdditionalDiagnostics(baseIncident(), lowConfidenceRootCause(80), {
      callModel,
    });

    expect(result).toEqual({ gathered: false, diagnostics: [] });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("gathers additional diagnostics when confidence is below 80", async () => {
    const callModel = vi.fn().mockResolvedValue(
      jsonDiagnostics([
        { description: "Lock contention from session 52", possibleCause: "session 52 holding an exclusive lock" },
        { description: "Long-running transaction", possibleCause: "an uncommitted transaction on session 52" },
      ])
    );

    const result = await gatherAdditionalDiagnostics(baseIncident(), lowConfidenceRootCause(55), {
      callModel,
    });

    expect(result.gathered).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("the prompt includes the original low-confidence root cause and the real evidence, not just a description", async () => {
    const callModel = vi.fn().mockResolvedValue(
      jsonDiagnostics([{ description: "A", possibleCause: "B" }])
    );

    await gatherAdditionalDiagnostics(baseIncident(), lowConfidenceRootCause(55), { callModel });

    const prompt = callModel.mock.calls[0][0] as string;
    expect(prompt).toContain("55%");
    expect(prompt).toContain("evt-1");
    expect(prompt).toContain("session_id");
  });

  it("multiple diagnostics each include a possible cause", async () => {
    const callModel = vi.fn().mockResolvedValue(
      jsonDiagnostics([
        { description: "Lock contention", possibleCause: "session 52 exclusive lock" },
        { description: "Long-running transaction", possibleCause: "uncommitted transaction on session 52" },
      ])
    );

    const result = await gatherAdditionalDiagnostics(baseIncident(), lowConfidenceRootCause(55), {
      callModel,
    });

    expect(result.diagnostics.length).toBe(2);
    for (const item of result.diagnostics) {
      expect(item.possibleCause.length).toBeGreaterThan(0);
    }
  });

  it("failure path — incorrect diagnostics presented: rejects a response missing possibleCause", async () => {
    const callModel = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ diagnostics: [{ description: "A" }] }));

    await expect(
      gatherAdditionalDiagnostics(baseIncident(), lowConfidenceRootCause(55), { callModel })
    ).rejects.toThrow(MalformedResponseError);
  });

  it("failure path — incorrect diagnostics presented: rejects an empty diagnostics list", async () => {
    const callModel = vi.fn().mockResolvedValue(jsonDiagnostics([]));

    await expect(
      gatherAdditionalDiagnostics(baseIncident(), lowConfidenceRootCause(55), { callModel })
    ).rejects.toThrow(MalformedResponseError);
  });

  it("failure path — incorrect diagnostics presented: rejects non-JSON output", async () => {
    const callModel = vi.fn().mockResolvedValue("Probably locking, not sure though.");

    await expect(
      gatherAdditionalDiagnostics(baseIncident(), lowConfidenceRootCause(55), { callModel })
    ).rejects.toThrow(MalformedResponseError);
  });

  it("throws MissingApiKeyError when confidence is low, no key is configured, and no callModel is injected", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(
      gatherAdditionalDiagnostics(baseIncident(), lowConfidenceRootCause(55))
    ).rejects.toThrow(MissingApiKeyError);
  });

  it("failure path — diagnostics not gathered: retries then throws UpstreamCallFailedError on persistent failure", async () => {
    const callModel = vi.fn().mockRejectedValue(new Error("upstream 503"));

    const resultPromise = gatherAdditionalDiagnostics(baseIncident(), lowConfidenceRootCause(55), {
      callModel,
    });
    const assertion = expect(resultPromise).rejects.toThrow(UpstreamCallFailedError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(callModel).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("Trust — every successful gather is logged exactly once", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const callModel = vi.fn().mockResolvedValue(
      jsonDiagnostics([{ description: "A", possibleCause: "B" }])
    );

    await gatherAdditionalDiagnostics(baseIncident(), lowConfidenceRootCause(55), { callModel });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatchObject({ event: "additional_diagnostics_gathered" });
  });

  it("Trust — a skipped gather (confidence already sufficient) is also logged, not silently skipped", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");

    await gatherAdditionalDiagnostics(baseIncident(), lowConfidenceRootCause(80), {
      callModel: vi.fn(),
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatchObject({ event: "additional_diagnostics_not_needed" });
  });
});
