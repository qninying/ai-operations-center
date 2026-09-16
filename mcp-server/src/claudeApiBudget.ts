// AI Trust and Risk Review, 2026-09-15: no budget cap or per-incident call-count
// limit existed anywhere in this codebase. General HTTP rate limiting (120
// req/min) and the triage dedup caches reduce, but don't cap, total Claude API
// spend -- a scripted or looping caller hitting the human-triggered
// recommendation endpoints, or the MCP triage tool, in sequence had no
// code-level ceiling stopping it. This module is that ceiling: a rolling-window
// call counter shared across every real Claude API call site in this repo
// (rootCauseAgent.ts's and diagnosticsGatherer.ts's defaultCallModel), so
// aggregate spend across both call types is what's actually bounded, not one
// path in isolation.
//
// Deliberately not a per-incident limit -- an incident can legitimately need
// both a root-cause call and a differential-gathering call, and a real outage
// can legitimately produce many distinct incidents in a short window. What
// this catches is the shape a bug or a scripted caller produces: far more
// calls than any real incident volume would ever need, sustained.

export class ClaudeApiBudgetExceededError extends Error {
  readonly errorClass = "ClaudeApiBudgetExceededError" as const;

  constructor(
    readonly maxCalls: number,
    readonly windowMs: number
  ) {
    super(
      `Claude API call budget exceeded: ${maxCalls} calls already made in the last ${windowMs}ms. ` +
        `This protects against runaway spend from a scripted or looping caller, not normal incident volume. ` +
        `Raise CLAUDE_API_CALL_BUDGET if this is a genuine traffic increase.`
    );
    this.name = "ClaudeApiBudgetExceededError";
  }
}

export class InvalidApiBudgetConfigError extends Error {
  readonly errorClass = "InvalidApiBudgetConfigError" as const;

  constructor(
    readonly envVarName: string,
    readonly rawValue: string
  ) {
    super(`${envVarName} is set to "${rawValue}", which is not a positive integer. Unset it to use the default.`);
    this.name = "InvalidApiBudgetConfigError";
  }
}

// Same fail-fast-on-malformed-value convention as confidenceThresholds.ts's
// readConfidenceThreshold(): a bad config here should be an obvious startup-time
// error, not a silently-ignored budget that never actually limits anything.
export function readPositiveIntEnv(envVarName: string, defaultValue: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidApiBudgetConfigError(envVarName, raw);
  }
  return parsed;
}

export class ApiCallBudget {
  private callTimestamps: number[] = [];

  constructor(
    private readonly maxCalls: number,
    private readonly windowMs: number
  ) {}

  // Throws ClaudeApiBudgetExceededError if this call would exceed the budget;
  // otherwise records the call and returns normally. Call immediately before
  // the real API call, not after -- a call that's about to be refused should
  // never be counted as having happened.
  checkAndRecord(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    this.callTimestamps = this.callTimestamps.filter((t) => t > cutoff);
    if (this.callTimestamps.length >= this.maxCalls) {
      throw new ClaudeApiBudgetExceededError(this.maxCalls, this.windowMs);
    }
    this.callTimestamps.push(now);
  }
}

// Module-level singleton, deliberately shared across every real call site
// (rootCauseAgent.ts, diagnosticsGatherer.ts) rather than one budget per
// module -- the risk being mitigated is aggregate spend, and a per-module
// budget would let a caller alternate between the two call types to double
// its effective ceiling. Defaults: 100 calls per 10-minute rolling window --
// generous relative to real incident volume (each incident needs at most one
// root-cause call plus, only when confidence is genuinely low, one
// differential-gathering call), tight enough to catch a scripted loop.
const MAX_CALLS = readPositiveIntEnv("CLAUDE_API_CALL_BUDGET", 100);
const WINDOW_MS = readPositiveIntEnv("CLAUDE_API_CALL_BUDGET_WINDOW_MS", 10 * 60_000);

export const claudeApiBudget = new ApiCallBudget(MAX_CALLS, WINDOW_MS);
