import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startMonitoring } from "./monitoringService.js";
import * as logger from "./observability/logger.js";
import { AuditLog } from "../../guardrails/auditLog.js";

const quietRow = {
  session_id: 52,
  status: "running",
  command: "SELECT",
  wait_type: null,
  blocking_session_id: 0,
  cpu_time_ms: 1200,
  total_elapsed_time_ms: 1450,
  database_name: "OpsWarehouse",
};

const blockedRow = {
  ...quietRow,
  session_id: 61,
  status: "suspended",
  blocking_session_id: 52,
};

describe("startMonitoring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs a cycle immediately, detects an incident, and triggers an alert", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const queryFn = vi.fn().mockResolvedValue([quietRow, blockedRow]);

    const handle = startMonitoring({ queryFn });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "monitoring_cycle",
        context: expect.objectContaining({ outcome: "success", incidentDetected: true }),
      })
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "incident_alert",
        context: expect.objectContaining({ sessionId: 61, blockingSessionId: 52 }),
      })
    );
  });

  it("logs a quiet cycle with no incident, without raising an alert", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const queryFn = vi.fn().mockResolvedValue([quietRow]);

    const handle = startMonitoring({ queryFn });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "monitoring_cycle",
        context: expect.objectContaining({ outcome: "success", incidentDetected: false }),
      })
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "incident_alert" })
    );
  });

  it("failure path — a failed cycle is logged and the loop continues on the next interval, rather than dying", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce([quietRow]);

    const handle = startMonitoring({ intervalMs: 1000, queryFn });
    await vi.advanceTimersByTimeAsync(0);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "monitoring_cycle",
        context: expect.objectContaining({ outcome: "failure", errorClass: "Error" }),
      })
    );

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        event: "monitoring_cycle",
        context: expect.objectContaining({ outcome: "success" }),
      })
    );
  });

  it("runs continuously on the configured interval until stop() is called", async () => {
    const queryFn = vi.fn().mockResolvedValue([quietRow]);

    const handle = startMonitoring({ intervalMs: 500, queryFn });
    await vi.advanceTimersByTimeAsync(500 * 3);
    expect(queryFn).toHaveBeenCalledTimes(4); // immediate + 3 interval ticks

    handle.stop();
    await vi.advanceTimersByTimeAsync(500 * 3);
    expect(queryFn).toHaveBeenCalledTimes(4); // no further calls after stop()
  });

  it("failure path — a logging failure is guarded and never stops the monitoring loop", async () => {
    const logSpy = vi.spyOn(logger, "logEvent").mockImplementationOnce(() => {
      throw new Error("stdout write failed");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const queryFn = vi.fn().mockResolvedValue([quietRow]);

    const handle = startMonitoring({ intervalMs: 1000, queryFn });
    await vi.advanceTimersByTimeAsync(0); // logEvent throws here, guarded

    await vi.advanceTimersByTimeAsync(1000); // loop must still be alive
    handle.stop();

    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "monitoringService: logEvent failed",
      expect.any(Error)
    );
  });

  // Live-discovered regression: a cold-starting Azure SQL free-tier instance took
  // ~30s to respond against a 10s default interval. Without this guard, each
  // interval tick fired a new, overlapping queryLiveDmv() call regardless of whether
  // the previous one had finished, and the resulting pile of concurrent connection
  // attempts tripped the shared circuit breaker on a false alarm — the server would
  // have come up fine on a single retry sequence.
  it("regression: does not start a new cycle while the previous one is still in flight", async () => {
    let resolveQuery!: (rows: typeof quietRow[]) => void;
    const queryFn = vi.fn(() => new Promise<(typeof quietRow)[]>((resolve) => {
      resolveQuery = resolve;
    }));

    const handle = startMonitoring({ intervalMs: 100, queryFn });
    await vi.advanceTimersByTimeAsync(0); // immediate cycle begins, stays pending
    await vi.advanceTimersByTimeAsync(350); // several ticks occur while busy — all skipped
    expect(queryFn).toHaveBeenCalledTimes(1);

    resolveQuery([quietRow]); // let the in-flight cycle finish
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(100); // next tick, now idle, actually runs
    handle.stop();

    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("STORY-010: notifies operators when an incident is detected", async () => {
    const notifyFn = vi.fn().mockResolvedValue(undefined);
    const queryFn = vi.fn().mockResolvedValue([quietRow, blockedRow]);

    const handle = startMonitoring({ queryFn, notifyFn });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(notifyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "incident_alert",
        incidentId: "sql:sys.dm_exec_requests:61",
        correlationId: expect.any(String),
        summary: expect.stringContaining("Session 61"),
      }),
      expect.anything()
    );
  });

  it("ADR-002: records a system_event audit entry for a detected incident, retrievable by its correlation ID", async () => {
    const notifyFn = vi.fn().mockResolvedValue(undefined);
    const queryFn = vi.fn().mockResolvedValue([quietRow, blockedRow]);
    const auditLog = new AuditLog();

    const handle = startMonitoring({ queryFn, notifyFn, auditLog });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    const [, options] = notifyFn.mock.calls[0];
    expect(options.auditLog).toBe(auditLog);

    const [action] = notifyFn.mock.calls[0];
    const entries = auditLog.forCorrelationId(action.correlationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "system_event",
      event: "incident_alert",
      outcome: "success",
      actor: "monitoringService",
      correlationId: action.correlationId,
    });
  });

  it("ADR-002: a monitoring cycle failure still gets its own auditable correlation ID", async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error("connection refused"));
    const auditLog = new AuditLog();

    const handle = startMonitoring({ queryFn, auditLog });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    const entries = auditLog.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "system_event",
      event: "monitoring_cycle",
      outcome: "failure",
      actor: "monitoringService",
    });
    expect(entries[0].correlationId).toBeTruthy();
  });

  it("does not notify operators on a quiet cycle with no incident", async () => {
    const notifyFn = vi.fn().mockResolvedValue(undefined);
    const queryFn = vi.fn().mockResolvedValue([quietRow]);

    const handle = startMonitoring({ queryFn, notifyFn });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("failure path — a rejected notification dispatch is logged and does not crash the monitoring loop", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const notifyFn = vi.fn().mockRejectedValue(new Error("OPERATOR_CONTACTS not configured"));
    const queryFn = vi.fn().mockResolvedValue([quietRow, blockedRow]);

    const handle = startMonitoring({ intervalMs: 1000, queryFn, notifyFn });
    await vi.advanceTimersByTimeAsync(0);
    // The notifyFn promise rejection is caught asynchronously — give its .catch()
    // handler a microtask/tick to run before asserting.
    await vi.advanceTimersByTimeAsync(0);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "operator_notification_dispatch_failed",
        context: expect.objectContaining({ errorClass: "Error" }),
      })
    );

    // Loop must still be alive after the rejection.
    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("invokes onCycle with a structured result after every cycle, success and failure alike", async () => {
    const onCycle = vi.fn();
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce([quietRow, blockedRow])
      .mockRejectedValueOnce(new Error("timed out"));

    const handle = startMonitoring({ intervalMs: 1000, queryFn, onCycle });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(onCycle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outcome: "success",
        incidentDetected: true,
        alert: expect.objectContaining({ sessionId: 61, blockingSessionId: 52 }),
      })
    );
    expect(onCycle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ outcome: "failure", errorClass: "Error" })
    );
  });
});
