import { randomBytes } from "node:crypto";

// In-memory session store for the one real, password-verified login this app has.
// Same shape as this repo's other bounded, expiring state (guardrails/hitlQueue.ts's
// decision window, reliability/circuitBreaker.ts's cooldown) — module-level Map,
// lost on process restart, which is the already-accepted pattern here, not a gap to
// fix. Lazy expiry-check-on-access (no cleanup timer), same as
// CircuitBreaker.checkAvailability()/HitlQueue.checkForTimeout() — appropriate for a
// single-operator system where the Map never grows unboundedly.

export interface Session {
  username: string;
  expiresAt: number;
}

export interface SessionStoreOptions {
  ttlMs?: number;
  now?: () => number;
  generateId?: () => string;
}

const DEFAULT_TTL_MS = 60 * 60_000; // 60 minutes — longer than HitlQueue's 15-minute
// decision window on purpose: a login should outlive a single approve/reject, not
// force a re-login mid-demo.

export class SessionStore {
  private sessions = new Map<string, Session>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.generateId = options.generateId ?? (() => randomBytes(32).toString("hex"));
  }

  create(username: string): { sessionId: string; expiresAt: number } {
    const sessionId = this.generateId();
    const expiresAt = this.now() + this.ttlMs;
    this.sessions.set(sessionId, { username, expiresAt });
    return { sessionId, expiresAt };
  }

  // Returns null for an unknown or expired session id. A valid session's expiry
  // slides forward on each successful verify — an operator actively using the
  // dashboard should never be logged out mid-session just because the clock ran out.
  verify(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (this.now() >= session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }
    session.expiresAt = this.now() + this.ttlMs;
    return session;
  }

  // Idempotent — destroying an already-absent session id is a safe no-op, matching
  // this repo's idempotency rule (POST /api/logout can call this unconditionally).
  destroy(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
