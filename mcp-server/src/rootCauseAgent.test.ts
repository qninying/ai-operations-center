import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  analyzeIncidentRootCause,
  MalformedResponseError,
  MissingApiKeyError,
  type Incident,
} from "./rootCauseAgent.js";
import { UpstreamCallFailedError } from "./reliability/withReliability.js";

function baseIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "incident-1",
    description: "Session 61 blocked, high CPU on prod-db-01",
    evidence: [
      { id: "evt-1", source: "sys.dm_exec_requests", data: { session_id: 61, blocking_session_id: 52 } },
    ],
    ...overrides,
  };
}

function jsonResponse(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("analyzeIncidentRootCause", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is evidence-grounded: the prompt sent to the model includes the actual evidence data, not just a description", async () => {
    const callModel = vi.fn().mockResolvedValue(
      jsonResponse({ rootCause: "Blocking chain on session 61", confidence: 90, evidenceIdsUsed: ["evt-1"] })
    );

    await analyzeIncidentRootCause(baseIncident(), { callModel });

    const promptSent = callModel.mock.calls[0][0] as string;
    expect(promptSent).toContain("evt-1");
    expect(promptSent).toContain("session_id");
    expect(promptSent).toContain("61");
  });

  it("returns attributed output: cites the evidence IDs the model says it used", async () => {
    const callModel = vi.fn().mockResolvedValue(
      jsonResponse({ rootCause: "Blocking chain", confidence: 85, evidenceIdsUsed: ["evt-1"] })
    );

    const result = await analyzeIncidentRootCause(baseIncident(), { callModel });

    expect(result.evidenceIdsUsed).toEqual(["evt-1"]);
    expect(result.rootCause).toBe("Blocking chain");
    expect(result.insufficientEvidence).toBe(false);
  });

  it("is non-fabricated when evidence is empty: returns a deterministic low-confidence result WITHOUT calling the model", async () => {
    const callModel = vi.fn();

    const result = await analyzeIncidentRootCause(baseIncident({ evidence: [] }), { callModel });

    expect(result.insufficientEvidence).toBe(true);
    expect(result.confidence).toBe(0);
    expect(result.evidenceIdsUsed).toEqual([]);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("marks insufficientEvidence when the model itself reports low confidence, even with evidence present", async () => {
    const callModel = vi.fn().mockResolvedValue(
      jsonResponse({ rootCause: "Evidence doesn't clearly explain the failure", confidence: 15, evidenceIdsUsed: [] })
    );

    const result = await analyzeIncidentRootCause(baseIncident(), { callModel });

    expect(result.insufficientEvidence).toBe(true);
    expect(result.confidence).toBe(15);
  });

  it("failure path — confidence score incorrect: rejects a response with confidence out of the 0-100 range", async () => {
    const callModel = vi.fn().mockResolvedValue(
      jsonResponse({ rootCause: "Whatever", confidence: 150, evidenceIdsUsed: [] })
    );

    await expect(analyzeIncidentRootCause(baseIncident(), { callModel })).rejects.toThrow(
      MalformedResponseError
    );
  });

  it("failure path — recommendation lacks evidence field: rejects a response missing evidenceIdsUsed", async () => {
    const callModel = vi.fn().mockResolvedValue(JSON.stringify({ rootCause: "Whatever", confidence: 80 }));

    await expect(analyzeIncidentRootCause(baseIncident(), { callModel })).rejects.toThrow(
      MalformedResponseError
    );
  });

  it("failure path — rejects non-JSON output rather than guessing at a result", async () => {
    const callModel = vi.fn().mockResolvedValue("Sure, I think it's probably a locking issue.");

    await expect(analyzeIncidentRootCause(baseIncident(), { callModel })).rejects.toThrow(
      MalformedResponseError
    );
  });

  it("throws MissingApiKeyError when no key is configured and no callModel is injected, without attempting a call", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(analyzeIncidentRootCause(baseIncident())).rejects.toThrow(MissingApiKeyError);
  });

  it("failure path — AI fails to diagnose: retries then throws UpstreamCallFailedError on persistent failure, never returning a fabricated result", async () => {
    const callModel = vi.fn().mockRejectedValue(new Error("upstream 503"));

    const resultPromise = analyzeIncidentRootCause(baseIncident(), { callModel });
    const assertion = expect(resultPromise).rejects.toThrow(UpstreamCallFailedError);
    await vi.advanceTimersByTimeAsync(10_000); // comfortably more than the 2-retry backoff window
    await assertion;

    expect(callModel).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("is repeatable: the same incident and the same model response produce the same result twice", async () => {
    const callModel = vi.fn().mockResolvedValue(
      jsonResponse({ rootCause: "Blocking chain", confidence: 90, evidenceIdsUsed: ["evt-1"] })
    );

    const first = await analyzeIncidentRootCause(baseIncident(), { callModel });
    const second = await analyzeIncidentRootCause(baseIncident(), { callModel });

    expect(first).toEqual(second);
  });
});
