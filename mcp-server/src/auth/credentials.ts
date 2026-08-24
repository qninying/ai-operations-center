import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Single-operator login credential verification. Hashed at rest, not plaintext —
// unlike SQLSERVER_PASSWORD (a read-only, least-privilege DB credential with a
// scoped blast radius), this password gates every route in httpServer.ts, including
// the one that actually executes a real remediation (POST /api/guardrail/decide).
// Hashing costs nothing extra: node:crypto's scrypt is already available, so this
// adds zero new dependencies, consistent with CLAUDE.md's "deliberate add" rule for
// new packages. AUTH_PASSWORD_HASH in .env stores "<saltHex>:<hashHex>", generated
// once via hashPassword.ts — see that file's header for the setup command.

const SCRYPT_KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

// Returns false for a wrong password AND for a malformed stored hash (e.g. .env
// misconfigured) — a verification function that throws on bad config would crash the
// login route instead of just rejecting the attempt, and "reject" is the correct,
// safe default either way.
export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 2) {
    return false;
  }
  const [saltHex, hashHex] = parts;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEY_LENGTH) {
    return false;
  }

  const actual = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  // timingSafeEqual, not ===, so a wrong-password check doesn't leak how many
  // leading bytes matched via response timing.
  return timingSafeEqual(actual, expected);
}
