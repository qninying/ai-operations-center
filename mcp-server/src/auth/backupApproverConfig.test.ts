import { describe, it, expect } from "vitest";
import { checkBackupApproverConfig } from "./backupApproverConfig.js";

describe("checkBackupApproverConfig", () => {
  it("reports unconfigured when none of the three vars are set (happy path: deliberate single-operator mode)", () => {
    const result = checkBackupApproverConfig({ username: undefined, passwordHash: undefined, totpSecret: undefined });
    expect(result).toEqual({ status: "unconfigured", missingVars: [] });
  });

  it("reports configured when all three vars are set (happy path: real second approver)", () => {
    const result = checkBackupApproverConfig({ username: "sre-oncall", passwordHash: "hash", totpSecret: "secret" });
    expect(result).toEqual({ status: "configured", missingVars: [] });
  });

  it("reports partial and names the missing var when only username and passwordHash are set", () => {
    const result = checkBackupApproverConfig({ username: "sre-oncall", passwordHash: "hash", totpSecret: undefined });
    expect(result.status).toBe("partial");
    expect(result.missingVars).toEqual(["BACKUP_APPROVER_TOTP_SECRET"]);
  });

  it("reports partial and names both missing vars when only totpSecret is set", () => {
    const result = checkBackupApproverConfig({ username: undefined, passwordHash: undefined, totpSecret: "secret" });
    expect(result.status).toBe("partial");
    expect(result.missingVars).toEqual(["BACKUP_APPROVER_USERNAME", "BACKUP_APPROVER_PASSWORD_HASH"]);
  });

  it("treats an empty string the same as unset (boundary case)", () => {
    const result = checkBackupApproverConfig({ username: "", passwordHash: "hash", totpSecret: "secret" });
    expect(result.status).toBe("partial");
    expect(result.missingVars).toEqual(["BACKUP_APPROVER_USERNAME"]);
  });
});
