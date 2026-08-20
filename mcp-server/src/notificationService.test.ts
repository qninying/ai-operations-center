import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyOperators, OperatorContactMissingError } from "./notificationService.js";
import * as logger from "./observability/logger.js";

const action = {
  actionType: "incident_alert",
  incidentId: "incident-1",
  summary: "Session 79 blocked by session 77",
};

function setOperators() {
  process.env.OPERATOR_CONTACTS = "ops-oncall@example.com, ops-lead@example.com";
}

function clearOperators() {
  delete process.env.OPERATOR_CONTACTS;
}

// Same reliability budget as the SQL/Blob/Anthropic call sites: 10s timeout, 3
// retries (4 attempts total), exponential backoff. Fake timers throughout so backoff
// costs no real wall-clock time.
describe("notifyOperators", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("REQ-012: delivers on the first attempt and notifies operators immediately", async () => {
    setOperators();
    const logSpy = vi.spyOn(logger, "logEvent");
    const channel = vi.fn().mockResolvedValue(undefined);

    await notifyOperators(action, { channel });

    expect(channel).toHaveBeenCalledTimes(1);
    expect(channel).toHaveBeenCalledWith(
      action,
      ["ops-oncall@example.com", "ops-lead@example.com"]
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "operator_notification_delivered",
        context: expect.objectContaining({
          actionType: "incident_alert",
          incidentId: "incident-1",
          summary: action.summary,
        }),
      })
    );
  });

  it("retries the notification and succeeds once the channel recovers", async () => {
    setOperators();
    const channel = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(undefined);

    const resultPromise = notifyOperators(action, { channel });
    await vi.advanceTimersByTimeAsync(10_000);
    await resultPromise;

    expect(channel).toHaveBeenCalledTimes(3);
  });

  it("failure path — notification service failure / network issues: retries are capped, the failure is logged, and the caller is never thrown at", async () => {
    setOperators();
    const logSpy = vi.spyOn(logger, "logEvent");
    const channel = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const resultPromise = notifyOperators(action, { channel });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(resultPromise).resolves.toBeUndefined();

    expect(channel).toHaveBeenCalledTimes(4); // 1 + 3 capped retries, not infinite
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "operator_notification_failed",
        context: expect.objectContaining({
          incidentId: "incident-1",
          errorClass: "UpstreamCallFailedError",
        }),
      })
    );
  });

  it("failure path — operator contact information missing: rejects immediately, the channel is never called", async () => {
    clearOperators();
    const channel = vi.fn();

    await expect(notifyOperators(action, { channel })).rejects.toThrow(
      OperatorContactMissingError
    );
    expect(channel).not.toHaveBeenCalled();
  });

  it("failure path — operator contact information missing: blank/whitespace-only config is also rejected", async () => {
    process.env.OPERATOR_CONTACTS = "  ,  ,";
    const channel = vi.fn();

    await expect(notifyOperators(action, { channel })).rejects.toThrow(
      OperatorContactMissingError
    );
    expect(channel).not.toHaveBeenCalled();
  });

  it("Trust — a fully-exhausted delivery failure is still logged with its error class", async () => {
    setOperators();
    const logSpy = vi.spyOn(logger, "logEvent");
    const channel = vi.fn().mockRejectedValue(new Error("down"));

    const resultPromise = notifyOperators(action, { channel });
    await vi.advanceTimersByTimeAsync(10_000);
    await resultPromise;

    const failureCall = logSpy.mock.calls.find(
      (call) => call[0].event === "operator_notification_failed"
    );
    expect(failureCall).toBeDefined();
    expect(failureCall![0].context?.errorClass).toBe("UpstreamCallFailedError");
  });
});
