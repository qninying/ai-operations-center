// Proves the "try a live query first, fall back to fixture data, tag the source
// honestly" pattern used by dmvReader.ts and ssrsReader.ts genuinely works against
// a real, running, external system — not just mocks. This is deliberately NOT part
// of mcp-server's shipped tool surface or its normal test suite: it talks to Apache
// Superset (see docker-compose.yml in this directory), which is NOT SSRS. What this
// proves and doesn't prove is written up in README.md — read that before drawing
// conclusions from a clean run of this script.
//
// Usage: ./setup.sh, then: npx tsx verify-live-pattern.ts

const SUPERSET_URL = "http://localhost:8088";

interface QueryHistoryRow {
  id: number;
  status: string;
  error_message: string | null;
  start_time: string;
  end_time: string | null;
}

interface ReadResult {
  source: "live" | "fallback";
  rows: QueryHistoryRow[];
  reason?: string;
}

// Fixture data, same role as dmvFixtures.ts/ssrsFixtures.ts — never contacts
// Superset, just what the reader falls back to if the live call fails.
const fixtureRows: QueryHistoryRow[] = [
  { id: -1, status: "failed", error_message: "fixture: connection refused", start_time: "0", end_time: null },
];

class LiveSourceUnavailableError extends Error {}

// A connection-level failure (Superset down, port unreachable) throws Node's raw
// fetch TypeError before any HTTP response exists at all — a real gap this script
// initially had: only non-ok HTTP responses were translated into
// LiveSourceUnavailableError, so ECONNREFUSED crashed the script uncaught instead
// of triggering the fallback it was supposed to test. Caught by actually stopping
// Superset and running this script, not by inspection.
async function fetchOrUnavailable(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    throw new LiveSourceUnavailableError(
      `Could not reach Superset at ${SUPERSET_URL}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function login(): Promise<string> {
  const res = await fetchOrUnavailable(`${SUPERSET_URL}/api/v1/security/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin", provider: "db", refresh: true }),
  });
  if (!res.ok) {
    throw new LiveSourceUnavailableError(`Superset login failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

async function queryLiveHistory(): Promise<QueryHistoryRow[]> {
  const token = await login();
  const res = await fetchOrUnavailable(
    `${SUPERSET_URL}/api/v1/query/?q=(order_column:start_time,order_direction:desc,page_size:10,columns:!(id,status,error_message,start_time,end_time))`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new LiveSourceUnavailableError(`Superset query-history call failed: ${res.status}`);
  }
  const body = (await res.json()) as { result: QueryHistoryRow[] };
  return body.result;
}

// The pattern itself — structurally identical to readDmv()/readSsrsExecutionLog():
// try live, tag it "live" on success; on a known live-source failure, fall back to
// fixture data and tag it "fallback", never silently presenting one as the other.
async function readReportingHistory(): Promise<ReadResult> {
  try {
    const rows = await queryLiveHistory();
    return { source: "live", rows };
  } catch (error) {
    if (!(error instanceof LiveSourceUnavailableError)) {
      throw error;
    }
    return { source: "fallback", rows: fixtureRows, reason: error.message };
  }
}

async function main() {
  const result = await readReportingHistory();
  console.log(`source: ${result.source}${result.reason ? ` (${result.reason})` : ""}`);
  console.log(JSON.stringify(result.rows, null, 2));

  if (result.source === "live") {
    const hasSuccess = result.rows.some((r) => r.status === "success");
    const hasFailure = result.rows.some((r) => r.status !== "success");
    console.log("");
    console.log(`Real success row present: ${hasSuccess}`);
    console.log(`Real non-success row present: ${hasFailure}`);
    console.log("");
    console.log(
      "This is real data from a real running Superset instance — proving the " +
        "live-query path of this pattern genuinely works against an external system, " +
        "not just against a mock. It does NOT prove ssrsLiveSource.ts's actual SQL " +
        "against ExecutionLog3 is correct — that needs real SSRS. See README.md."
    );
  }
}

main().catch((error) => {
  console.error("Unexpected error (not a known live-source failure):", error);
  process.exit(1);
});
