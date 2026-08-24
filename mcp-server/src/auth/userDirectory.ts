import { verifyPassword } from "./credentials.js";

// Closes a real trust-scorecard gap: guardrails/hitlQueue.ts's escalation mechanism
// (primary approver misses the decision window -> activeApprover switches to
// backupApprover) has always existed, but httpServer.ts's GUARDRAIL_BACKUP_APPROVER
// was a hardcoded "sre-oncall" string with no real login behind it. This module lets
// POST /api/login authenticate against 1 or 2 real configured users transparently.
//
// Extracted out of httpServer.ts's route handler specifically so the matching logic
// gets real unit tests — this file has no dedicated test file precedent otherwise.

// Structurally typed (not TotpVerifier directly) so tests can stub it without
// needing a real secret — real TOTP correctness is totp.test.ts's job.
export interface DirectoryUser {
  username: string;
  passwordHash: string;
  totpVerifier: { verify(code: string): boolean };
  kind: "primary" | "backup";
}

// Loop order mirrors the exact short-circuit property httpServer.ts's single-user
// check already had: a wrong password for a given user never calls that user's
// totpVerifier.verify(), so a mistyped password can't burn or replay-block that
// user's currently-valid code. One generic null on no match, regardless of how
// many users are configured or which one(s) partially matched — the caller (the
// login route) turns this into the same one generic 401 either way, preserving
// the anti-enumeration property across 1 or 2 possible users.
export function findAuthenticatedUser(
  users: DirectoryUser[],
  username: string,
  password: string,
  totpCode: string
): DirectoryUser | null {
  for (const user of users) {
    if (user.username === username && verifyPassword(password, user.passwordHash) && user.totpVerifier.verify(totpCode)) {
      return user;
    }
  }
  return null;
}
