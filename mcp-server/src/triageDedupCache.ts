// Content-addressed dedup cache for triage_active_incidents (closes the "no
// dedup on triage calls" governance gap named in the AI Employee Charter,
// 2026-09-13). Pulled into its own module so the dedup mechanics -- building
// a stable key from evidence and expiring stale entries -- are unit-testable
// without standing up a full McpServer + MCP client handshake, which this
// codebase has no harness for yet (mcpServerFactory.ts itself has no test
// file). Keyed on the exact evidence snapshot, not on elapsed time alone, so
// two calls only share a cached judgment if the underlying incident
// genuinely hasn't changed -- a new blocked session or a cleared one
// produces a different key and a fresh sample.

export const TRIAGE_CACHE_TTL_MS = 15 * 60 * 1000;

export interface TriageCacheEntry {
  judgmentText: string;
  evidenceText: string;
  computedAt: number;
}

interface BlockedSessionRow {
  session_id: number;
  blocking_session_id: number;
  database_name: string;
}

interface FailedReportRow {
  report_path: string;
  status: string;
  time_start: string;
}

// Sorted independently of the two arrays' own (unguaranteed) query order, so
// the exact same underlying incident always produces the exact same key even
// if SQL Server or SSRS happen to return their rows in a different order
// between two calls.
export function buildTriageKey(blocked: BlockedSessionRow[], failedReports: FailedReportRow[]): string {
  return [
    ...blocked.map((row) => `sql:${row.session_id}:${row.blocking_session_id}:${row.database_name}`),
    ...failedReports.map((row) => `ssrs:${row.report_path}:${row.status}:${row.time_start}`),
  ]
    .sort()
    .join("|");
}

export class TriageJudgmentCache {
  private readonly entries = new Map<string, TriageCacheEntry>();

  constructor(private readonly ttlMs: number = TRIAGE_CACHE_TTL_MS) {}

  private pruneExpired(now: number): void {
    const cutoff = now - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.computedAt < cutoff) this.entries.delete(key);
    }
  }

  get(key: string, now: number = Date.now()): TriageCacheEntry | undefined {
    this.pruneExpired(now);
    return this.entries.get(key);
  }

  set(key: string, entry: TriageCacheEntry): void {
    this.entries.set(key, entry);
  }

  get size(): number {
    return this.entries.size;
  }
}
