import { withReliability } from "./reliability/withReliability.js";
import { safeLogEvent } from "./observability/safeLogEvent.js";
import { recordSystemEvent } from "./observability/auditWrite.js";
import type { AuditLog } from "../../guardrails/auditLog.js";

// STORY-010 / REQ-012: notify operators of autonomous actions the system takes on its
// own initiative. This system currently takes exactly two kinds of autonomous action —
// STORY-008's incident alert and STORY-009's escalation — both wired to this module
// rather than a third invented action; that's what "reuse, don't rebuild" means here.
//
// Default delivery is a real ntfy.sh push notification (free, no signup, no API key —
// a plain HTTP POST to a topic name; see https://ntfy.sh/docs/). `channel` stays
// injectable — same dependency-injection pattern this repo already uses for
// queryFn/analyzeFn — so tests and any future real channel (Slack, email, paging) can
// swap it out without touching notifyOperators() itself.
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
  // ADR-002 step 2: optional — most callers' incidentId already IS the correlation
  // ID (generated once, at the true entry point). monitoringService.ts is the one
  // caller where incidentId stays a human-readable identifier for the notification
  // body text while a separate real correlation ID is threaded here for audit
  // purposes. Falls back to incidentId below when unset, so existing callers need
  // no change.
  correlationId?: string;
  summary: string;
  // Optional per-call override of the ntfy Priority/Tags headers, so different
  // autonomous-action types can look visibly distinct in the ntfy app (a real
  // incident vs. an escalation vs. a delivered credential) instead of every
  // notification looking identical. ntfy has no literal color header — Priority
  // (min/low/default/high/urgent) is what actually drives an accent/icon color
  // in the app, Tags drives an emoji glyph prefix; combining both is the honest
  // mechanism, not an assumed one. Defaults preserve today's exact behavior
  // (high/rotating_light) for every existing call site that doesn't set these.
  priority?: "min" | "low" | "default" | "high" | "urgent";
  tags?: string;
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

export class NotificationChannelUnconfiguredError extends Error {
  readonly errorClass = "NotificationChannelUnconfiguredError" as const;

  constructor() {
    super("No ntfy topic configured (NTFY_TOPIC env var is unset or empty).");
    this.name = "NotificationChannelUnconfiguredError";
  }
}

export interface NotifyOperatorsOptions {
  channel?: NotificationChannel;
  // ADR-002 step 3.
  auditLog?: AuditLog;
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

const NTFY_SERVER = process.env.NTFY_SERVER ?? "https://ntfy.sh";

// Real delivery via ntfy.sh — a public POST-to-a-topic push service; the topic name
// is the only "credential," so NTFY_TOPIC should be an unguessable value, not
// something like "coreops-alerts" (anyone who knows the topic can publish or
// subscribe to it). Deliberately does no logging of its own: the Trust log in
// notifyOperators() below applies uniformly to whichever channel actually ran,
// default or caller-supplied, rather than being buried in one specific
// implementation. A missing topic throws before any network call — same "don't
// retry a config problem" rule as this repo's other missing-config errors, though
// here the check runs inside the retried function itself (a local, no-network check
// is cheap enough that a few pointless retries before that surfaces cost nothing
// real, unlike retrying an actual failed connection attempt).
const defaultChannel: NotificationChannel = async (action, operators) => {
  const topic = (process.env.NTFY_TOPIC ?? "").trim();
  if (!topic) {
    throw new NotificationChannelUnconfiguredError();
  }

  const response = await fetch(`${NTFY_SERVER}/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      Title: `CoreOps: ${action.actionType}`,
      Priority: action.priority ?? "high",
      Tags: action.tags ?? "rotating_light",
    },
    body: `${action.summary}\n\nIncident: ${action.incidentId}\nFor: ${operators.join(", ")}`,
  });

  if (!response.ok) {
    throw new Error(`ntfy responded with HTTP ${response.status}`);
  }
};

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
  const correlationId = action.correlationId ?? action.incidentId;

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
    recordSystemEvent(
      options.auditLog,
      "notificationService",
      "operator_notification_delivered",
      "success",
      { actionType: action.actionType, incidentId: action.incidentId, summary: action.summary, operators },
      correlationId
    );
  } catch (error) {
    const errorClass = error instanceof Error ? error.name : "Error";
    safeLogEvent("notificationService", {
      level: "error",
      event: "operator_notification_failed",
      context: {
        actionType: action.actionType,
        incidentId: action.incidentId,
        errorClass,
      },
    });
    recordSystemEvent(
      options.auditLog,
      "notificationService",
      "operator_notification_failed",
      "failure",
      { actionType: action.actionType, incidentId: action.incidentId, errorClass },
      correlationId
    );
  }
}
