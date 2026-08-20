import { withReliability } from "./reliability/withReliability.js";
import { safeLogEvent } from "./observability/safeLogEvent.js";

// STORY-010 / REQ-012: notify operators of autonomous actions the system takes on its
// own initiative. This system currently takes exactly two kinds of autonomous action —
// STORY-008's incident alert and STORY-009's escalation — both wired to this module
// rather than a third invented action; that's what "reuse, don't rebuild" means here.
//
// No real notification channel exists (no email/Slack/paging credentials anywhere in
// this repo). Rather than fabricate one, `channel` is an injectable function — same
// dependency-injection pattern this repo already uses for queryFn/analyzeFn — defaulting
// to the same real, distinct log event STORY-008/009 used for "alert"/"escalation".
// What's new here, and why this story isn't redundant with those: real retry logic
// around delivery, not just a single guarded log write.
//
// "Retries the notification until successful" is read as capped retry, not literal
// infinite retry — this repo's own rules explicitly prohibit unbounded retry loops.
// Reuses withReliability (the same timeout+capped-retry+backoff wrapper already
// powering the SQL, Blob, and Anthropic calls) rather than building new retry logic.
// If retries are exhausted, the failure is itself logged — Trust holds even when
// delivery ultimately fails — but this function does not re-throw in that case: a
// notification that couldn't be delivered should not crash the autonomous action that
// triggered it (same resilience rule STORY-008's monitoring loop follows).

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;

export interface AutonomousAction {
  actionType: string;
  incidentId: string;
  summary: string;
}

export type NotificationChannel = (action: AutonomousAction, operators: string[]) => Promise<void>;

export class OperatorContactMissingError extends Error {
  readonly errorClass = "OperatorContactMissingError" as const;

  constructor() {
    super(
      "No operator contact information configured (OPERATOR_CONTACTS env var is unset or empty)."
    );
    this.name = "OperatorContactMissingError";
  }
}

export interface NotifyOperatorsOptions {
  channel?: NotificationChannel;
}

function readOperators(): string[] {
  const raw = process.env.OPERATOR_CONTACTS;
  const operators = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (operators.length === 0) {
    throw new OperatorContactMissingError();
  }
  return operators;
}

// Walking-skeleton delivery: succeeding here means only "logged," since no real
// channel exists yet — this is the swap point for a real email/Slack/paging
// integration later. Deliberately does no logging of its own: the Trust log (below)
// applies uniformly to whichever channel actually ran, default or caller-supplied,
// rather than being buried inside one specific channel implementation.
const defaultChannel: NotificationChannel = async () => {};

// Throws OperatorContactMissingError immediately, before any delivery attempt —
// missing config won't fix itself on retry, same rule as this repo's other
// missing-config errors (LiveSourceUnavailableError, CloudSourceUnavailableError).
// Otherwise never throws: a capped-retry delivery failure is logged
// (operator_notification_failed) and swallowed, not propagated to the caller — see
// header comment for why.
export async function notifyOperators(
  action: AutonomousAction,
  options: NotifyOperatorsOptions = {}
): Promise<void> {
  const operators = readOperators();
  const channel = options.channel ?? defaultChannel;

  try {
    await withReliability(() => channel(action, operators), {
      timeoutMs: TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
      baseDelayMs: BASE_DELAY_MS,
      maxDelayMs: MAX_DELAY_MS,
    });
    safeLogEvent("notificationService", {
      level: "info",
      event: "operator_notification_delivered",
      context: {
        actionType: action.actionType,
        incidentId: action.incidentId,
        summary: action.summary,
        operators,
      },
    });
  } catch (error) {
    safeLogEvent("notificationService", {
      level: "error",
      event: "operator_notification_failed",
      context: {
        actionType: action.actionType,
        incidentId: action.incidentId,
        errorClass: error instanceof Error ? error.name : "Error",
      },
    });
  }
}
