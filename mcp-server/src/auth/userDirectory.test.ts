import { describe, it, expect } from "vitest";
import { hashPassword } from "./credentials.js";
import { findAuthenticatedUser, DirectoryUser } from "./userDirectory.js";

const primaryHash = hashPassword("primary-password");
const backupHash = hashPassword("backup-password");

// Fake verifiers, not real TotpVerifier instances — real TOTP correctness is
// totp.test.ts's job. Each user's fake only accepts its own designated code, so a
// mismatch is structurally impossible to fake-pass across users.
function fakeVerifier(acceptedCode: string): { verify(code: string): boolean } {
  return { verify: (code) => code === acceptedCode };
}

function directory(includeBackup: boolean): DirectoryUser[] {
  const users: DirectoryUser[] = [
    { username: "primary-user", passwordHash: primaryHash, totpVerifier: fakeVerifier("111111"), kind: "primary" },
  ];
  if (includeBackup) {
    users.push({
      username: "backup-user",
      passwordHash: backupHash,
      totpVerifier: fakeVerifier("222222"),
      kind: "backup",
    });
  }
  return users;
}

describe("findAuthenticatedUser", () => {
  it("happy path: the correct primary user matches", () => {
    const match = findAuthenticatedUser(directory(true), "primary-user", "primary-password", "111111");
    expect(match?.kind).toBe("primary");
    expect(match?.username).toBe("primary-user");
  });

  it("happy path: the correct backup user matches when configured", () => {
    const match = findAuthenticatedUser(directory(true), "backup-user", "backup-password", "222222");
    expect(match?.kind).toBe("backup");
    expect(match?.username).toBe("backup-user");
  });

  it("failure path: wrong password for the primary user is rejected", () => {
    expect(findAuthenticatedUser(directory(true), "primary-user", "wrong-password", "111111")).toBeNull();
  });

  it("failure path: wrong password for the backup user is rejected", () => {
    expect(findAuthenticatedUser(directory(true), "backup-user", "wrong-password", "222222")).toBeNull();
  });

  it("failure path: wrong TOTP code for the primary user is rejected", () => {
    expect(findAuthenticatedUser(directory(true), "primary-user", "primary-password", "000000")).toBeNull();
  });

  it("failure path: wrong TOTP code for the backup user is rejected", () => {
    expect(findAuthenticatedUser(directory(true), "backup-user", "backup-password", "000000")).toBeNull();
  });

  it("boundary: an unconfigured backup user (absent from the directory) never matches", () => {
    expect(findAuthenticatedUser(directory(false), "backup-user", "backup-password", "222222")).toBeNull();
  });

  it("boundary: an unknown username matches neither entry", () => {
    expect(findAuthenticatedUser(directory(true), "nobody", "primary-password", "111111")).toBeNull();
  });

  it("boundary: cross-contamination — a code valid for the backup user's verifier does not authenticate the primary user, and vice versa", () => {
    // backup-user's real credentials, but the primary user's TOTP code — must not match.
    expect(findAuthenticatedUser(directory(true), "backup-user", "backup-password", "111111")).toBeNull();
    // primary-user's real credentials, but the backup user's TOTP code — must not match.
    expect(findAuthenticatedUser(directory(true), "primary-user", "primary-password", "222222")).toBeNull();
  });
});
