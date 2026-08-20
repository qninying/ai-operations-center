import { describe, it, expect, vi, afterEach } from "vitest";
import { evaluateEscalation, InvalidConfidenceScoreError } from "./escalationService.js";
import * as logger from "./observability/logger.js";

describe("evaluateEscalation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("REQ-011: escalates and notifies a human operator when confidence is below 60", () => {
    const logSpy = vi.spyOn(logger, "logEvent");

    const record = evaluateEscalation("incident-1", 42, "Blocking chain on session 61");

    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      incidentId: "incident-1",
      confidence: 42,
      rootCause: "Blocking chain on session 61",
    });
    expect(record!.escalatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "escalation_triggered",
        context: expect.objectContaining({
          incidentId: "incident-1",
          confidence: 42,
          notifiedOperator: true,
        }),
      })
    );
  });

  it("failure path — escalation not triggered: confidence at or above 60 does not escalate", () => {
    const logSpy = vi.spyOn(logger, "logEvent");

    expect(evaluateEscalation("incident-2", 60, "No incident indicated")).toBeNull();
    expect(evaluateEscalation("incident-3", 85, "High confidence result")).toBeNull();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("boundary — 59 escalates, 60 does not", () => {
    expect(evaluateEscalation("incident-4", 59, "borderline")).not.toBeNull();
    expect(evaluateEscalation("incident-5", 60, "borderline")).toBeNull();
  });

  it("failure path — incorrect confidence score: a malformed score is rejected, not silently escalated or ignored", () => {
    const logSpy = vi.spyOn(logger, "logEvent");

    for (const bad of [NaN, -1, 101, Infinity, -Infinity]) {
      expect(() => evaluateEscalation("incident-6", bad, "desc")).toThrow(
        InvalidConfidenceScoreError
      );
    }
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("Trust — the escalation log includes the confidence score and a timestamp", () => {
    const logSpy = vi.spyOn(logger, "logEvent");

    evaluateEscalation("incident-7", 10, "Session 68 blocked");

    const call = logSpy.mock.calls[0][0];
    expect(call.context).toMatchObject({ confidence: 10 });
    expect(call.context?.escalatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("STORY-010: dispatches a real operator notification when it escalates", async () => {
    const notifyFn = vi.fn().mockResolvedValue(undefined);

    const record = evaluateEscalation("incident-9", 30, "Session 90 blocked", { notifyFn });

    expect(record).not.toBeNull();
    expect(notifyFn).toHaveBeenCalledWith({
      actionType: "escalation",
      incidentId: "incident-9",
      summary: "Session 90 blocked",
    });
    await notifyFn.mock.results[0].value;
  });

  it("does not dispatch a notification when confidence does not escalate", () => {
    const notifyFn = vi.fn();

    expect(evaluateEscalation("incident-10", 75, "fine", { notifyFn })).toBeNull();
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("failure path — a rejected notification dispatch is logged, not thrown, and the escalation record is still returned", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const notifyFn = vi.fn().mockRejectedValue(new Error("OPERATOR_CONTACTS not configured"));

    const record = evaluateEscalation("incident-11", 20, "desc", { notifyFn });
    expect(record).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "operator_notification_dispatch_failed",
        context: expect.objectContaining({ incidentId: "incident-11", errorClass: "Error" }),
      })
    );
  });

  it("failure path — escalation log failure: a logging failure is guarded and the escalation record is still returned", () => {
    vi.spyOn(logger, "logEvent").mockImplementationOnce(() => {
      throw new Error("stdout write failed");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const record = evaluateEscalation("incident-8", 5, "desc");

    expect(record).not.toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "escalationService: logEvent failed",
      expect.any(Error)
    );
  });
});
