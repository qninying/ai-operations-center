import { describe, it, expect } from "vitest";
import { SessionStore } from "./sessionStore.js";

describe("SessionStore", () => {
  it("happy path: create then verify returns the username", () => {
    const store = new SessionStore();
    const { sessionId } = store.create("quincy");

    const session = store.verify(sessionId);
    expect(session).not.toBeNull();
    expect(session!.username).toBe("quincy");
  });

  it("failure path: verify on an unknown session id returns null", () => {
    const store = new SessionStore();
    expect(store.verify("not-a-real-session-id")).toBeNull();
  });

  it("boundary: a session verified at or after its TTL is expired and removed", () => {
    let now = 1_000_000;
    const store = new SessionStore({ ttlMs: 60_000, now: () => now });
    const { sessionId } = store.create("quincy");

    now += 59_000;
    expect(store.verify(sessionId)).not.toBeNull(); // still valid, just before TTL
    // that verify slid expiresAt to 1_059_000 + 60_000 = 1_119_000

    now += 30_000; // well within the slid window
    expect(store.verify(sessionId)).not.toBeNull(); // sliding kept it alive
    // that verify slid expiresAt again, to 1_089_000 + 60_000 = 1_149_000

    now += 61_000; // now genuinely idle past the TTL with no further verify calls
    expect(store.verify(sessionId)).toBeNull();

    // Once expired, it's gone for good — verifying again doesn't resurrect it.
    expect(store.verify(sessionId)).toBeNull();
  });

  it("boundary: verifying before expiry slides expiresAt forward", () => {
    let now = 0;
    const store = new SessionStore({ ttlMs: 60_000, now: () => now });
    const { sessionId, expiresAt: initialExpiry } = store.create("quincy");
    expect(initialExpiry).toBe(60_000);

    now = 50_000;
    store.verify(sessionId);

    now = 100_000; // 50s after the slid expiry (110_000), still within the new TTL
    const session = store.verify(sessionId);
    expect(session).not.toBeNull();
    expect(session!.expiresAt).toBe(160_000); // 100_000 + 60_000
  });

  it("destroy makes a subsequent verify return null and is idempotent", () => {
    const store = new SessionStore();
    const { sessionId } = store.create("quincy");

    store.destroy(sessionId);
    expect(store.verify(sessionId)).toBeNull();

    // Destroying an already-absent session is a safe no-op, not an error.
    expect(() => store.destroy(sessionId)).not.toThrow();
    expect(() => store.destroy("never-existed")).not.toThrow();
  });

  it("each create() produces a distinct, unguessable session id", () => {
    const store = new SessionStore();
    const a = store.create("quincy").sessionId;
    const b = store.create("quincy").sessionId;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32); // 256-bit id, hex-encoded
  });
});
