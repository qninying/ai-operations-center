// INCIDENT-003 recommendation: healthCheck.ts's "anthropic.configured" only ever
// checked that ANTHROPIC_API_KEY is a non-empty string — exactly the gap that let
// a genuinely invalid production key go unnoticed (the key was "configured" the
// entire time it was rejecting every real call). A dedicated reachability probe on
// every health-check poll was deliberately rejected (see healthCheck.ts's own
// comment) — that would mean real Anthropic spend on every poll, against
// CLAUDE_API_CALL_BUDGET, just to answer a question this app already answers for
// free every time a real call happens anyway.
//
// This module is that free answer: rootCauseAgent.ts and diagnosticsGatherer.ts
// (the only two real call sites — see claudeApiBudget.ts's own comment) record the
// outcome of every real call they make here, and healthCheck.ts reads the last one
// back. No new API call, no new spend — just remembering what already happened.

export type AnthropicCallOutcome = "success" | "failure";

export interface AnthropicReachabilityState {
  outcome: AnthropicCallOutcome;
  at: string;
  errorClass?: string;
}

let lastOutcome: AnthropicReachabilityState | null = null;

export function recordAnthropicCallOutcome(
  outcome: AnthropicCallOutcome,
  errorClass?: string,
  now: () => number = Date.now
): void {
  lastOutcome = { outcome, at: new Date(now()).toISOString(), ...(errorClass ? { errorClass } : {}) };
}

export function getLastAnthropicCallOutcome(): AnthropicReachabilityState | null {
  return lastOutcome;
}

// Test-only escape hatch, matching healthCheck.ts's own __resetHealthCacheForTests
// convention — without it, test order would leak this module-level state the same
// way it would for that cache.
export function __resetAnthropicReachabilityForTests(): void {
  lastOutcome = null;
}
