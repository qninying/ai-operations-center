import "./loadEnv.js";
import pg from "pg";

// Demo/dev tooling only — deliberately creates real Postgres blocking scenarios
// against dev-postgres/'s orders-db, so the ADR-013 remediation flow has real
// blocked backends to detect and fix instead of an idle database. Mirrors
// seedBlockingScenario.ts's SQL Server shape, translated to Postgres. Not part of
// the app — run by hand: `npx tsx src/seedPostgresBlockingScenario.ts [holdSeconds]`.
//
// Seeds 2 independent blocking pairs (on order rows id=1 and id=2), matching the
// "2 incidents per source" shape SQL/SSRS's fixture data now also uses. Each pair
// is its own real lock: Session A opens a transaction and holds a row lock, Session
// B concurrently tries to touch the same row and genuinely blocks on it in
// Postgres's own lock manager — no fixture data involved, and the two pairs don't
// interact (different rows), so both blocks are real and simultaneous.
//
// No env-var gating like seedBlockingScenario.ts's SQL Server connection — these
// are dev-postgres/docker-compose.yml's own fixed, non-secret local credentials,
// not a real external system's secrets.
const PG_HOST = process.env.PG_DEMO_HOST ?? "localhost";
const PG_PORT = Number(process.env.PG_DEMO_PORT ?? 5434);
const PG_DATABASE = process.env.PG_DEMO_DATABASE ?? "orders";
const PG_USER = process.env.PG_DEMO_USER ?? "app";
const PG_PASSWORD = process.env.PG_DEMO_PASSWORD ?? "app";

const ROW_IDS = [1, 2];

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
  for (const id of ROW_IDS) {
    await client.query(`INSERT INTO orders (id, status) VALUES ($1, 'pending') ON CONFLICT (id) DO NOTHING;`, [id]);
  }
}

async function holdLock(client: pg.Client, rowId: number, holdMs: number): Promise<void> {
  await client.query("BEGIN");
  console.log(`[Session A${rowId}] Opening a transaction, taking a row lock on orders id=${rowId}...`);
  await client.query(`UPDATE orders SET status = 'processing' WHERE id = $1;`, [rowId]);
  console.log(
    `[Session A${rowId}] Lock held for ${holdMs / 1000}s. Query pg_stat_activity now (or run the demo) to see the block.`
  );
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await client.query("COMMIT");
  console.log(`[Session A${rowId}] Transaction committed, lock released.`);
}

async function attemptBlockedWrite(client: pg.Client, rowId: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2_000)); // let Session A take its lock first
  console.log(`[Session B${rowId}] Attempting to update the same row — this will block until Session A${rowId} commits...`);
  const start = Date.now();
  await client.query(`UPDATE orders SET status = 'shipped' WHERE id = $1;`, [rowId]);
  console.log(`[Session B${rowId}] Unblocked after ${Date.now() - start}ms.`);
}

async function main(): Promise<void> {
  const holdSeconds = Number(process.argv[2]) || 20;
  const config = readConfig();

  const clients = await Promise.all(ROW_IDS.map(() => [new pg.Client(config), new pg.Client(config)] as const));
  await Promise.all(clients.flat().map((client) => client.connect()));

  try {
    await ensureDemoTable(clients[0][0]);
    await Promise.all(
      ROW_IDS.flatMap((rowId, i) => {
        const [clientA, clientB] = clients[i];
        return [holdLock(clientA, rowId, holdSeconds * 1000), attemptBlockedWrite(clientB, rowId)];
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
