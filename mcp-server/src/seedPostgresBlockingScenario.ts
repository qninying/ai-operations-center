import "./loadEnv.js";
import pg from "pg";

// Demo/dev tooling only — deliberately creates a real Postgres blocking scenario
// against dev-postgres/'s orders-db, so the ADR-013 remediation flow has a real
// blocked backend to detect and fix instead of an idle database. Mirrors
// seedBlockingScenario.ts's SQL Server shape exactly, translated to Postgres. Not
// part of the app — run by hand: `npx tsx src/seedPostgresBlockingScenario.ts [holdSeconds]`.
//
// Session A opens a transaction and holds a row lock; Session B concurrently tries
// to touch the same row and genuinely blocks on it in Postgres's own lock manager —
// no fixture data involved.
//
// No env-var gating like seedBlockingScenario.ts's SQL Server connection — these
// are dev-postgres/docker-compose.yml's own fixed, non-secret local credentials,
// not a real external system's secrets.
const PG_HOST = process.env.PG_DEMO_HOST ?? "localhost";
const PG_PORT = Number(process.env.PG_DEMO_PORT ?? 5434);
const PG_DATABASE = process.env.PG_DEMO_DATABASE ?? "orders";
const PG_USER = process.env.PG_DEMO_USER ?? "app";
const PG_PASSWORD = process.env.PG_DEMO_PASSWORD ?? "app";

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

async function ensureDemoTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);
  await client.query(`
    INSERT INTO orders (id, status) VALUES (1, 'pending')
    ON CONFLICT (id) DO NOTHING;
  `);
}

async function holdLock(client: pg.Client, holdMs: number): Promise<void> {
  await client.query("BEGIN");
  console.log("[Session A] Opening a transaction, taking a row lock on orders id=1...");
  await client.query(`UPDATE orders SET status = 'processing' WHERE id = 1;`);
  console.log(
    `[Session A] Lock held for ${holdMs / 1000}s. Query pg_stat_activity now (or run the demo) to see the block.`
  );
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await client.query("COMMIT");
  console.log("[Session A] Transaction committed, lock released.");
}

async function attemptBlockedWrite(client: pg.Client): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2_000)); // let Session A take its lock first
  console.log("[Session B] Attempting to update the same row — this will block until Session A commits...");
  const start = Date.now();
  await client.query(`UPDATE orders SET status = 'shipped' WHERE id = 1;`);
  console.log(`[Session B] Unblocked after ${Date.now() - start}ms.`);
}

async function main(): Promise<void> {
  const holdSeconds = Number(process.argv[2]) || 20;
  const config = readConfig();

  const clientA = new pg.Client(config);
  const clientB = new pg.Client(config);
  await clientA.connect();
  await clientB.connect();

  try {
    await ensureDemoTable(clientA);
    await Promise.all([holdLock(clientA, holdSeconds * 1000), attemptBlockedWrite(clientB)]);
  } finally {
    await clientA.end();
    await clientB.end();
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
