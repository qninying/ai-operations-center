import { readDmv, DmvReadResult, ReadDmvInput } from "./dmvReader.js";
import { getLastAnthropicCallOutcome, type AnthropicReachabilityState } from "./anthropicReachability.js";
import { getSourceChecks, NON_CONNECTOR_SOURCES, type SourceChecks } from "./sourceReachability.js";
import { getConnectors } from "./connectors/index.js";

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
  anthropic: {
    configured: boolean;
    // INCIDENT-003: "configured" alone already caused a real incident — a key
    // can be present and still be rejected by Anthropic's own API. These three
    // report the outcome of the most recent REAL call this process actually
    // made (rootCauseAgent.ts / diagnosticsGatherer.ts), not a synthetic probe
    // — see anthropicReachability.ts for why no new call is made here. null
    // means no real call has happened yet this process (e.g. right after a
    // fresh deploy, before any incident triggered one) — an honest "unknown,"
    // never presented as a false "ok".
    lastCallOutcome: "success" | "failure" | null;
    lastCallAt: string | null;
    lastCallErrorClass?: string;
  };
  // The last real check this process made against each source (the incident
  // feed polls every few seconds; ntfy and Fly's API record on real use). null
  // means no check yet since this process started. See sourceReachability.ts.
  sources: SourceChecks;
}

type ReadDmvFn = (input: ReadDmvInput) => Promise<DmvReadResult>;

export interface CheckDependencyHealthDeps {
  readDmvFn?: ReadDmvFn;
  now?: () => number;
  anthropicKeyPresent?: boolean;
  anthropicReachability?: AnthropicReachabilityState | null;
  sourceChecks?: SourceChecks;
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
  // "anthropicReachability" in deps, not `?? getLastAnthropicCallOutcome()` — a test
  // deliberately passing `null` (simulating "no real call made yet") must not fall
  // through to the real module-level function the way `??` would, since null is
  // itself a nullish value.
  const reachability: AnthropicReachabilityState | null =
    "anthropicReachability" in deps ? (deps.anthropicReachability ?? null) : getLastAnthropicCallOutcome();

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
    // "configured" alone is exactly the gap INCIDENT-003 found live: a key can be
    // present and still rejected by Anthropic's own API, and this field never
    // distinguished the two. No new API call is made here (that would mean real
    // spend against CLAUDE_API_BUDGET on every poll, for a signal this app
    // already produces for free) — lastCallOutcome instead reports the real
    // outcome of the most recent actual call, via anthropicReachability.ts.
    anthropic: {
      configured: anthropicConfigured,
      lastCallOutcome: reachability?.outcome ?? null,
      lastCallAt: reachability?.at ?? null,
      ...(reachability?.errorClass ? { lastCallErrorClass: reachability.errorClass } : {}),
    },
    // Every registered connector (REQ-018) plus ntfy and Fly's API, so a new
    // connector appears here with no edit to this file.
    sources: deps.sourceChecks ?? getSourceChecks([...getConnectors().map((c) => c.reachabilityName), ...NON_CONNECTOR_SOURCES]),
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
