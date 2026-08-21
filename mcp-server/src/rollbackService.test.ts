import { describe, it, expect, vi, afterEach } from "vitest";
import {
  requestRollback,
  InsufficientPermissionsError,
  UnknownTaskTypeError,
  TaskNotReversibleError,
  RollbackDependencyError,
  type TaskRegistration,
} from "./rollbackService.js";
import * as logger from "./observability/logger.js";

const adminRequest = (overrides: Partial<{ taskId: string; taskType: string }> = {}) => ({
  taskId: overrides.taskId ?? "task-1",
  taskType: overrides.taskType ?? "start_monitoring",
  requestedBy: { actor: "quincy", role: "system_administrator" },
});

describe("requestRollback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("REQ-015: a low-risk, reversible task is successfully reverted", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const revert = vi.fn().mockResolvedValue(undefined);
    const registry: Record<string, TaskRegistration> = {
      start_monitoring: { reversible: true, revert },
    };

    const result = await requestRollback(adminRequest(), registry);

    expect(result).toMatchObject({ taskId: "task-1", taskType: "start_monitoring", outcome: "reverted" });
    expect(result.revertedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(revert).toHaveBeenCalledWith("task-1");
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        event: "rollback_completed",
        context: expect.objectContaining({ taskId: "task-1", taskType: "start_monitoring" }),
      })
    );
  });

  it("failure path — insufficient permissions for rollback: a non-admin role is rejected before any registry lookup", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const revert = vi.fn();
    const registry: Record<string, TaskRegistration> = { start_monitoring: { reversible: true, revert } };
    const request = { ...adminRequest(), requestedBy: { actor: "eve", role: "engineer" } };

    await expect(requestRollback(request, registry)).rejects.toThrow(InsufficientPermissionsError);

    expect(revert).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rollback_denied",
        context: expect.objectContaining({ reason: "insufficient_permissions", role: "engineer" }),
      })
    );
  });

  it("failure path — incorrect task identification for rollback: an unrecognized task type is rejected", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const registry: Record<string, TaskRegistration> = {};

    await expect(requestRollback(adminRequest({ taskType: "delete_database" }), registry)).rejects.toThrow(
      UnknownTaskTypeError
    );

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rollback_denied",
        context: expect.objectContaining({ reason: "unknown_task_type", taskType: "delete_database" }),
      })
    );
  });

  it("REQ-015 failure path — a non-reversible task is denied, not silently attempted", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const revert = vi.fn();
    const registry: Record<string, TaskRegistration> = {
      notify_operators: { reversible: false, reason: "a delivered push notification cannot be unsent" },
    };

    await expect(
      requestRollback(adminRequest({ taskType: "notify_operators" }), registry)
    ).rejects.toThrow(TaskNotReversibleError);

    expect(revert).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rollback_denied",
        context: expect.objectContaining({
          reason: "not_reversible",
          detail: expect.stringContaining("cannot be unsent"),
        }),
      })
    );
  });

  it("failure path — rollback failure due to task dependency: a blocking dependency denies the rollback", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const revert = vi.fn();
    const registry: Record<string, TaskRegistration> = { start_monitoring: { reversible: true, revert } };
    const checkDependencies = vi.fn().mockResolvedValue(["a live incident investigation is using this monitoring session"]);

    await expect(
      requestRollback(adminRequest(), registry, { checkDependencies })
    ).rejects.toThrow(RollbackDependencyError);

    expect(revert).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rollback_denied",
        context: expect.objectContaining({
          reason: "dependency_blocked",
          blockers: ["a live incident investigation is using this monitoring session"],
        }),
      })
    );
  });

  it("Trust — a successful rollback and a denied one are both logged, distinctly", async () => {
    const logSpy = vi.spyOn(logger, "logEvent");
    const registry: Record<string, TaskRegistration> = {
      start_monitoring: { reversible: true, revert: vi.fn().mockResolvedValue(undefined) },
    };

    await requestRollback(adminRequest({ taskId: "task-ok" }), registry);
    await expect(
      requestRollback(adminRequest({ taskId: "task-bad", taskType: "unknown_type" }), registry)
    ).rejects.toThrow(UnknownTaskTypeError);

    const events = logSpy.mock.calls.map((call) => call[0].event);
    expect(events).toContain("rollback_completed");
    expect(events).toContain("rollback_denied");
  });
});
