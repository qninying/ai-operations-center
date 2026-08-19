import type { DmvReadResult } from "./dmvReader.js";

// STORY-005 / REQ-006 + REQ-009: role-specific dashboard views. Kept separate from
// httpServer.ts (which has no test coverage of its own, by design — it's a thin
// transport wrapper) so this logic is directly unit-testable, matching how
// dmvReader.ts already separates real logic from index.ts/httpServer.ts's routing.
//
// Only "it-manager" is implemented, even though this release's own goal mentions a
// DBA view too — that's REQ-006/009 and this story's acceptance criteria, which are
// IT-Manager-only. A "dba" role request currently throws UnknownRoleError, honestly,
// rather than a fabricated view nobody asked this story to build. The role registry
// below is written to extend cleanly when that story lands.

export type DashboardRole = "it-manager";

const SUPPORTED_ROLES: readonly DashboardRole[] = ["it-manager"];

export class UnknownRoleError extends Error {
  readonly errorClass = "UnknownRoleError" as const;
  constructor(readonly role: string) {
    super(`Unknown dashboard role "${role}". Supported: ${SUPPORTED_ROLES.join(", ")}.`);
    this.name = "UnknownRoleError";
  }
}

// REQ-009: "operational summaries" — counts and status, not raw per-session
// technical fields (that's the DBA-role view this story doesn't build). Same
// underlying real DMV data as the existing dashboard, reshaped for this audience.
export interface ItManagerSummary {
  role: "it-manager";
  incidentCount: number;
  blockedSessionCount: number;
  dataSource: "live" | "fallback";
  message?: string;
}

export type DashboardSummary = ItManagerSummary;

function isSupportedRole(role: string): role is DashboardRole {
  return (SUPPORTED_ROLES as readonly string[]).includes(role);
}

function buildItManagerSummary(dmvResult: DmvReadResult): ItManagerSummary {
  const blockedSessionCount = dmvResult.rows.filter((row) => row.blocking_session_id > 0).length;
  return {
    role: "it-manager",
    incidentCount: dmvResult.rows.length,
    blockedSessionCount,
    dataSource: dmvResult.source,
    ...(dmvResult.message ? { message: dmvResult.message } : {}),
  };
}

// Throws UnknownRoleError for any role outside SUPPORTED_ROLES — the caller (the new
// httpServer.ts route) is responsible for turning that into a 400, not a 500 or a
// silently-wrong rendering. Pure function: no I/O, no logging — access logging is the
// caller's responsibility too, same split R4's guardrail already established between
// a pure decision function and the audit trail around it.
export function buildDashboardSummary(role: string, dmvResult: DmvReadResult): DashboardSummary {
  if (!isSupportedRole(role)) {
    throw new UnknownRoleError(role);
  }
  return buildItManagerSummary(dmvResult);
}
