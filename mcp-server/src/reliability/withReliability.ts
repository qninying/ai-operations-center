import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js";

// Generic timeout + capped-retry-with-backoff wrapper for R5, composable with an
// optional CircuitBreaker. Decoupled from any specific upstream (SQL Server, Claude
// API, or anything else) so it can wrap whatever async call needs this treatment.

export interface ReliabilityOptions {
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  circuitBreaker?: CircuitBreaker;
}

export class UpstreamTimeoutError extends Error {
  readonly errorClass = "UpstreamTimeoutError" as const;

  constructor(readonly timeoutMs: number) {
    super(`Upstream call timed out after ${timeoutMs}ms.`);
    this.name = "UpstreamTimeoutError";
  }
}

export class UpstreamCallFailedError extends Error {
  readonly errorClass = "UpstreamCallFailedError" as const;

  constructor(readonly attempts: number, cause: unknown) {
    super(
      `Upstream call failed after ${attempts} attempt(s): ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "UpstreamCallFailedError";
    this.cause = cause;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpstreamTimeoutError(timeoutMs)), timeoutMs);
    operation()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

// Exponential backoff: baseDelayMs * 2^(attempt-1), capped at maxDelayMs. attempt is
// 1-indexed (the delay is for the wait *after* this attempt failed, before the next).
function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

// Re-checks circuit availability before every attempt, not just once up front — if
// this call's own failures (or a concurrent call's, sharing the same breaker) push
// the circuit open mid-retry, remaining retries are abandoned in favor of failing
// fast rather than continuing to hammer a known-broken upstream.
export async function withReliability<T>(
  operation: () => Promise<T>,
  options: ReliabilityOptions
): Promise<T> {
  const { timeoutMs, maxRetries, baseDelayMs, maxDelayMs, circuitBreaker } = options;
  const maxAttempts = maxRetries + 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (circuitBreaker) {
      const retryAfterMs = circuitBreaker.checkAvailability();
      if (retryAfterMs !== null) {
        throw new CircuitOpenError(retryAfterMs);
      }
    }

    try {
      const result = await withTimeout(operation, timeoutMs);
      circuitBreaker?.recordSuccess();
      return result;
    } catch (error) {
      lastError = error;
      circuitBreaker?.recordFailure();
      if (attempt < maxAttempts) {
        await delay(backoffDelay(attempt, baseDelayMs, maxDelayMs));
      }
    }
  }

  throw new UpstreamCallFailedError(maxAttempts, lastError);
}
