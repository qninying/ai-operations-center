import { safeLogEvent } from "./observability/safeLogEvent.js";

// STORY-011 / REQ-015: rollback capabilities for low-risk, reversible tasks. No real
// Execution Service exists yet in this codebase (nothing performs a real production
// write), so "roll back a low-risk task" can't honestly mean "revert a real
// production change" — there is nothing real to revert from. The one genuinely real,
// already-idempotent, low-risk reversible action already built is
// monitoringService.ts's startMonitoring()/stop() (STORY-008); this is the concrete
// "low-risk task" this story targets, flagged and confirmed with the user before
// building, rather than inventing a fake revert for an action nothing can actually
// execute yet. Wiring the real monitoring revert is a separate step — this file is
// the decision layer only, tested against an injected registry.
//
// `registry` is deliberately a required parameter, not a default with a built-in
// entry: any default registry here would either be empty (misleading — implies
// nothing is reversible) or would have to fabricate a revert function ahead of the
// real wiring existing. The caller supplies the real registry once real tasks exist
// to revert.

export interface TaskRegistrationReversible {
  reversible: true;
  revert: (taskId: string) => Promise<void>;
}

export interface TaskRegistrationNotReversible {
  reversible: false;
  reason: string;
}

export type TaskRegistration = TaskRegistrationReversible | TaskRegistrationNotReversible;

export interface RollbackRequest {
  taskId: string;
  taskType: string;
  requestedBy: { actor: string; role: string };
}

export interface RollbackResult {
  taskId: string;
  taskType: string;
  outcome: "reverted";
  revertedAt: string;
}

export interface RollbackOptions {
  hasPermission?: (role: string) => boolean;
  // No dependency-tracking system exists in this codebase yet, so the honest default
  // is "no known blockers" — not a fabricated check, an accurate one. Injectable so
  // tests can simulate a real blocking scenario.
  checkDependencies?: (taskId: string, taskType: string) => Promise<string[]>;
}

export class InsufficientPermissionsError extends Error {
  readonly errorClass = "InsufficientPermissionsError" as const;
  constructor(readonly role: string) {
    super(`Role "${role}" is not permitted to request a rollback.`);
    this.name = "InsufficientPermissionsError";
  }
}

export class UnknownTaskTypeError extends Error {
  readonly errorClass = "UnknownTaskTypeError" as const;
  constructor(readonly taskType: string) {
    super(`Task type "${taskType}" is not recognized — cannot identify what to roll back.`);
    this.name = "UnknownTaskTypeError";
  }
}

export class TaskNotReversibleError extends Error {
  readonly errorClass = "TaskNotReversibleError" as const;
  constructor(readonly taskType: string, readonly reason: string) {
    super(`Task type "${taskType}" is not reversible: ${reason}`);
    this.name = "TaskNotReversibleError";
  }
}

export class RollbackDependencyError extends Error {
  readonly errorClass = "RollbackDependencyError" as const;
  constructor(readonly taskId: string, readonly blockers: string[]) {
    super(`Cannot roll back task "${taskId}": ${blockers.join("; ")}`);
    this.name = "RollbackDependencyError";
  }
}

// System administrator is this story's own persona ("As a system administrator, I
// want to be able to roll back low-risk tasks"); no other role is granted this by
// default.
function defaultHasPermission(role: string): boolean {
  return role === "system_administrator";
}

async function defaultCheckDependencies(): Promise<string[]> {
  return [];
}

// Throws InsufficientPermissionsError, UnknownTaskTypeError, TaskNotReversibleError,
// or RollbackDependencyError — each a distinct, named failure path, checked in that
// order so the caller learns the *first* real reason a rollback can't proceed rather
// than a generic denial. Every outcome, allowed or denied, is logged (Trust: all
// rollback actions are logged for audit purposes) before the function returns or
// throws.
export async function requestRollback(
  request: RollbackRequest,
  registry: Record<string, TaskRegistration>,
  options: RollbackOptions = {}
): Promise<RollbackResult> {
  const hasPermission = options.hasPermission ?? defaultHasPermission;
  const checkDependencies = options.checkDependencies ?? defaultCheckDependencies;

  const logDenied = (reason: string, extra: Record<string, unknown> = {}) => {
    safeLogEvent("rollbackService", {
      level: "warn",
      event: "rollback_denied",
      context: { taskId: request.taskId, taskType: request.taskType, actor: request.requestedBy.actor, reason, ...extra },
    });
  };

  if (!hasPermission(request.requestedBy.role)) {
    logDenied("insufficient_permissions", { role: request.requestedBy.role });
    throw new InsufficientPermissionsError(request.requestedBy.role);
  }

  const registration = registry[request.taskType];
  if (!registration) {
    logDenied("unknown_task_type");
    throw new UnknownTaskTypeError(request.taskType);
  }

  if (!registration.reversible) {
    // Named `detail`, not `reason` — logDenied's own `reason` param is the
    // categorical denial code ("not_reversible"); a second `reason` key here would
    // silently overwrite it in the logged context.
    logDenied("not_reversible", { detail: registration.reason });
    throw new TaskNotReversibleError(request.taskType, registration.reason);
  }

  const blockers = await checkDependencies(request.taskId, request.taskType);
  if (blockers.length > 0) {
    logDenied("dependency_blocked", { blockers });
    throw new RollbackDependencyError(request.taskId, blockers);
  }

  await registration.revert(request.taskId);

  const result: RollbackResult = {
    taskId: request.taskId,
    taskType: request.taskType,
    outcome: "reverted",
    revertedAt: new Date().toISOString(),
  };

  safeLogEvent("rollbackService", {
    level: "info",
    event: "rollback_completed",
    context: { taskId: request.taskId, taskType: request.taskType, actor: request.requestedBy.actor },
  });

  return result;
}
