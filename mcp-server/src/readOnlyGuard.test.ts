import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Structural guard for R2's "read-only by construction" acceptance criterion: this
// isn't a policy comment, it's an automated check that the module has no dependency
// or code path capable of writing to SQL Server. If either check here ever fails, R2
// no longer satisfies its acceptance criterion and must not be marked PLANNED/BUILT.
// R2 is SQL-Server-specific — see the second describe block below for the parallel,
// honestly-different guard ADR-013's deliberately write-capable pg dependency gets.

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(__dirname, "..", "package.json");

// Every known Node SQL client capable of issuing writes. Any of these showing up in
// package.json requires deliberate review — see REVIEWED_SQL_DRIVERS below.
const KNOWN_SQL_DRIVERS = [
  "mssql",
  "tedious",
  "pg",
  "mysql",
  "mysql2",
  "sqlite3",
  "better-sqlite3",
];

// Drivers present in package.json that HAVE been reviewed: confirmed used only for
// parameterized, read-only queries (see dmvLiveSource.ts), with its own keyword scan
// below. Adding a driver here without adding it to the file list in the second test
// (or without it actually being read-only) defeats this guard — don't.
//
// pg is deliberately NOT listed here, even though it's a real dependency (added for
// ADR-013): REVIEWED_SQL_DRIVERS specifically means "confirmed read-only," and pg is
// not — it's the one deliberately write-capable driver in this codebase. Marking it
// "reviewed" here would misrepresent it. Its write capability is confined and
// structurally checked by the separate "pg write confinement" guard below instead —
// R2 governs SQL Server; pg was never in its scope.
const REVIEWED_SQL_DRIVERS = ["mssql"];

// Drivers that ARE write-capable, added deliberately, and confined by their own
// separate structural guard (see "pg write confinement" below) rather than being
// falsely marked read-only. Every entry here must have its own confinement test.
const DELIBERATELY_WRITE_CAPABLE_DRIVERS = ["pg"];

const FORBIDDEN_WRITE_KEYWORDS = [
  /\bINSERT\b/,
  /\bUPDATE\b/,
  /\bDELETE\b/,
  /\bEXEC\b/,
  /\bMERGE\b/,
  /\bTRUNCATE\b/,
  /\bDROP\b/,
];

describe("R2 read-only guard", () => {
  it("package.json declares no unreviewed, unexplained SQL write-capable driver as a dependency", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const unexplained = KNOWN_SQL_DRIVERS.filter(
      (driver) =>
        driver in allDeps &&
        !REVIEWED_SQL_DRIVERS.includes(driver) &&
        !DELIBERATELY_WRITE_CAPABLE_DRIVERS.includes(driver)
    );
    expect(unexplained).toEqual([]);
  });

  it.each(["dmvReader.ts", "dmvLiveSource.ts", "ssrsReader.ts", "ssrsLiveSource.ts", "index.ts", "httpServer.ts"])(
    "%s contains no SQL write-statement keywords",
    (fileName) => {
      const source = readFileSync(join(__dirname, fileName), "utf-8");
      const matches = FORBIDDEN_WRITE_KEYWORDS.filter((pattern) => pattern.test(source));
      expect(matches).toEqual([]);
    }
  );
});

// See docs/ADR-013-real-postgres-remediation.md. pg is deliberately write-capable —
// this guard doesn't pretend otherwise, it structurally confines that one write to
// exactly one file, the same "provably narrow blast radius" discipline the R2 guard
// above applies to "no write at all."
describe("pg write confinement", () => {
  const ALLOWED_FILE = "pgRemediationExecutor.ts";
  const PG_WRITE_KEYWORDS = [/pg_terminate_backend/];

  it(`pg_terminate_backend appears only in ${ALLOWED_FILE}, nowhere else in src/`, () => {
    const srcFiles = readdirSync(__dirname).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== ALLOWED_FILE
    );
    const offenders = srcFiles.filter((fileName) => {
      const source = readFileSync(join(__dirname, fileName), "utf-8");
      return PG_WRITE_KEYWORDS.some((pattern) => pattern.test(source));
    });
    expect(offenders).toEqual([]);
  });

  it(`${ALLOWED_FILE} genuinely contains the write it's confined to (guards against a silent rename making the test above vacuous)`, () => {
    const source = readFileSync(join(__dirname, ALLOWED_FILE), "utf-8");
    expect(PG_WRITE_KEYWORDS.some((pattern) => pattern.test(source))).toBe(true);
  });
});
