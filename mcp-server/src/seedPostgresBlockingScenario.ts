import "./loadEnv.js";
import pg from "pg";

// Demo/dev tooling only — deliberately creates real Postgres blocking scenarios
// against dev-postgres/'s orders-db, so the ADR-013 remediation flow has real
// blocked backends to detect and fix instead of an idle database. Mirrors
// seedBlockingScenario.ts's SQL Server shape, translated to Postgres. Not part of
// the app — run by hand: `npx tsx src/seedPostgresBlockingScenario.ts [holdSeconds]`.
//
// Seeds 2 independent, genuinely different-looking blocking scenarios — a stuck
// order update and a stuck payment update — not the same query on two ids. The
// first version of this script used one `orders` table with a parameterized
// `WHERE id = $1`, so pg_stat_activity's `query` column (which shows the literal
// SQL text sent over the wire, not the bound value) rendered byte-identical for
// both incidents — confirmed live 2026-08-27: a real demo confusion, not a fixture
// artifact. Fixed two ways: a second, distinctly-named table, and literal (not
// parameterized) ids in the UPDATE text so the real query shown on each incident
// card actually differs and is readable. Safe here specifically because the ids
// come from this file's own hardcoded SCENARIOS array, never from user input —
// this reasoning does not extend to anything taking real input.
//
// Both scenarios are the same safe, short-lived (per pgRemediationSafety.ts's own
// definition of "short-lived" — well under its 5-minute threshold, real elapsed
// time notwithstanding) single-row-lock case (both real, both killable by
// kill_postgres_backend) — this script isn't meant to also cover
// pgRemediationSafety.ts's other rules (long-running, system backend, chained
// blocker); those are covered by that module's own unit tests and ADR-013's live
// break test.
//
// Holds effectively indefinitely by default (see main()) — a fixed short hold
// raced a real presenter twice (90s, then 180s, both confirmed live 2026-08-27 to
// self-resolve mid-demo) before this was fixed to hold until acted upon instead.
const PG_HOST = process.env.PG_DEMO_HOST ?? "localhost";
const PG_PORT = Number(process.env.PG_DEMO_PORT ?? 5434);
const PG_DATABASE = process.env.PG_DEMO_DATABASE ?? "orders";
const PG_USER = process.env.PG_DEMO_USER ?? "app";
const PG_PASSWORD = process.env.PG_DEMO_PASSWORD ?? "app";

interface Scenario {
  label: string;
  table: string;
  id: number;
  fromStatus: string;
  holdStatus: string;
  blockStatus: string;
}

const SCENARIOS: Scenario[] = [
  { label: "order", table: "orders", id: 1, fromStatus: "pending", holdStatus: "processing", blockStatus: "shipped" },
  { label: "payment", table: "payments", id: 1, fromStatus: "pending", holdStatus: "authorizing", blockStatus: "failed" },
];

function readConfig(): pg.ClientConfig {
  return {
    host: PG_HOST,
    port: PG_PORT,
    database: PG_DATABASE,
    user: PG_USER,
    password: PG_PASSWORD,
    connectionTimeoutMillis: 10_000,
  };
}

async function ensureDemoTables(client: pg.Client): Promise<void> {
  for (const scenario of SCENARIOS) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${scenario.table} (
        id INT PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    await client.query(
      `INSERT INTO ${scenario.table} (id, status) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING;`,
      [scenario.id, scenario.fromStatus]
    );
  }
}

async function holdLock(client: pg.Client, scenario: Scenario, holdMs: number): Promise<void> {
  await client.query("BEGIN");
  console.log(`[Session A/${scenario.label}] Opening a transaction, taking a row lock on ${scenario.table} id=${scenario.id}...`);
  // Literal id, not parameterized — see the file-level comment on why that's safe
  // here (a fixed internal constant, never user input) and why it matters (the
  // real query text shown on the incident card needs to actually be readable).
  await client.query(`UPDATE ${scenario.table} SET status = '${scenario.holdStatus}' WHERE id = ${scenario.id};`);
  console.log(
    `[Session A/${scenario.label}] Lock held for ${holdMs / 1000}s. Query pg_stat_activity now (or run the demo) to see the block.`
  );
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await client.query("COMMIT");
  console.log(`[Session A/${scenario.label}] Transaction committed, lock released.`);
}

async function attemptBlockedWrite(client: pg.Client, scenario: Scenario): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2_000)); // let Session A take its lock first
  console.log(`[Session B/${scenario.label}] Attempting to update the same row — this will block until Session A/${scenario.label} commits...`);
  const start = Date.now();
  await client.query(`UPDATE ${scenario.table} SET status = '${scenario.blockStatus}' WHERE id = ${scenario.id};`);
  console.log(`[Session B/${scenario.label}] Unblocked after ${Date.now() - start}ms.`);
}

async function main(): Promise<void> {
  // 1800s (30 min) default — a fixed hold is fundamentally fragile for a live demo:
  // 90s, then 180s, both confirmed live 2026-08-27 to self-resolve mid-demo (a
  // presenter reading two Troubleshoot messages and clicking two Fix/Approve flows
  // easily eats more time than any specific guess). This is meant to hold
  // effectively indefinitely — until a real Approve kills it (the intended ending)
  // or demo-postgres-incident's "cancel early" pkill path ends it — not to time out
  // mid-demo. 30 minutes is a safety net against a genuinely forgotten process, not
  // a number to budget the demo against. Pass a shorter number as this script's
  // argument if a specific timed demonstration is actually wanted.
  const holdSeconds = Number(process.argv[2]) || 1800;
  const config = readConfig();

  const clients = await Promise.all(SCENARIOS.map(() => [new pg.Client(config), new pg.Client(config)] as const));
  await Promise.all(clients.flat().map((client) => client.connect()));

  try {
    await ensureDemoTables(clients[0][0]);
    await Promise.all(
      SCENARIOS.flatMap((scenario, i) => {
        const [clientA, clientB] = clients[i];
        return [holdLock(clientA, scenario, holdSeconds * 1000), attemptBlockedWrite(clientB, scenario)];
      })
    );
  } finally {
    await Promise.all(clients.flat().map((client) => client.end()));
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
