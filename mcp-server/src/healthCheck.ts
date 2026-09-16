import { readDmv, DmvReadResult, ReadDmvInput } from "./dmvReader.js";

// REQ-025/026 (STORY-012): a readiness check for the real production deploy,
// distinct from GET /health's plain liveness ping (httpServer.ts), which stays
// synchronous and dependency-free on purpose so a fast, frequent poller never
// blocks on a slow or down upstream. This route answers a different question:
// "what can this instance actually reach right now," honestly, using the same
// live/fallback tagging convention every other real data path in this repo
// already uses (dmvReader.ts, ssrsReader.ts), never a separate,
// health-specific notion of truth invented just for this route.

export interface DependencyHealthReport {
  status: "ok";
  timestamp: string;
  uptimeSeconds: number;
  sqlServer: { source: "live" | "fallback" };
  anthropic: { configured: boolean };
}

type ReadDmvFn = (input: ReadDmvInput) => Promise<DmvReadResult>;

export interface CheckDependencyHealthDeps {
  readDmvFn?: ReadDmvFn;
  now?: () => number;
  anthropicKeyPresent?: boolean;
}

// A deploy platform's health-check poller hits this route far more often than a
// human ever would (Fly's default interval is well under a minute). Without a
// cache, every poll would re-run the SQL Server probe below, turning a health
// check into a recurring load-test of the database and a source of noise on the
// probe's own circuit breaker. 15s keeps the reported state fresh enough to
// matter for an incident drill while keeping the actual query rate bounded.
const CACHE_TTL_MS = 15_000;

let cached: { report: DependencyHealthReport; expiresAt: number } | null = null;

export async function checkDependencyHealth(
  deps: CheckDependencyHealthDeps = {}
): Promise<DependencyHealthReport> {
  const now = deps.now ?? Date.now;
  const nowMs = now();

  if (cached && cached.expiresAt > nowMs) {
    return cached.report;
  }

  const readDmvFn = deps.readDmvFn ?? readDmv;
  const anthropicConfigured = deps.anthropicKeyPresent ?? Boolean(process.env.ANTHROPIC_API_KEY);

  // Reuses the exact same read-only, capped, circuit-breaker-guarded DMV read
  // the dashboard already calls: a real reachability probe against the live
  // connection this app actually uses, not a synthetic ping against something
  // else. dmvReader.ts already falls back to fixture data (tagged "fallback")
  // on any known live-source failure instead of throwing, so this call itself
  // can't turn an unreachable SQL Server into a broken health route.
  const dmvResult = await readDmvFn({ dmvName: "sys.dm_exec_requests" });

  const report: DependencyHealthReport = {
    status: "ok",
    timestamp: new Date(nowMs).toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    sqlServer: { source: dmvResult.source },
    // Deliberately reports configuration, not live reachability: unlike the SQL
    // Server probe above (a normal read against an existing least-privilege
    // connection with its own circuit breaker), a real reachability check here
    // would mean a genuine Anthropic API call on every health-check poll:
    // recurring spend against CLAUDE_API_CALL_BUDGET for a signal this app
    // already surfaces honestly, per-request, through the recommendation
    // routes' own real failure paths (SqlServerUnavailableError and friends).
    anthropic: { configured: anthropicConfigured },
  };

  cached = { report, expiresAt: nowMs + CACHE_TTL_MS };
  return report;
}

// Test-only escape hatch for the module-level cache above; without it, test
// order would leak state between cases the way no other test file in this repo
// has to worry about, since nothing else here caches at module scope.
export function __resetHealthCacheForTests(): void {
  cached = null;
}
