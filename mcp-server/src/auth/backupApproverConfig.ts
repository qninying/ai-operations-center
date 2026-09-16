// AI Trust and Risk Review, 2026-09-15: httpServer.ts's backupApproverConfigured
// check is Boolean(username && passwordHash && totpSecret) -- all-or-nothing, so a
// fully-unset backup approver correctly and silently stays single-operator, exactly
// as documented. What that check can't distinguish is a deployment that SET SOME of
// the three vars (a copy-paste mistake, a partial .env edit) from one that set
// none on purpose: both collapse to the same "not configured" fallback, with
// nothing telling the operator their attempted second-approver setup silently did
// nothing. This module names that state so httpServer.ts can log it loudly instead
// of staying silent about it -- a warning, not a fail-fast throw, since an
// unconfigured backup approver is a legitimate, supported deployment shape and
// startup must not become fatal for an optional feature.

export type BackupApproverConfigStatus = "unconfigured" | "partial" | "configured";

export interface BackupApproverConfigCheck {
  status: BackupApproverConfigStatus;
  missingVars: string[];
}

const REQUIRED_VARS = ["BACKUP_APPROVER_USERNAME", "BACKUP_APPROVER_PASSWORD_HASH", "BACKUP_APPROVER_TOTP_SECRET"] as const;

export function checkBackupApproverConfig(env: {
  username: string | undefined;
  passwordHash: string | undefined;
  totpSecret: string | undefined;
}): BackupApproverConfigCheck {
  const values = [env.username, env.passwordHash, env.totpSecret];
  const setCount = values.filter((v) => Boolean(v)).length;

  if (setCount === 0) {
    return { status: "unconfigured", missingVars: [] };
  }
  if (setCount === REQUIRED_VARS.length) {
    return { status: "configured", missingVars: [] };
  }

  const missingVars = REQUIRED_VARS.filter((_, i) => !values[i]);
  return { status: "partial", missingVars };
}
