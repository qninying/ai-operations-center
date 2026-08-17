import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Structural guard for R2's "read-only by construction" acceptance criterion: this
// isn't a policy comment, it's an automated check that the module has no dependency
// or code path capable of writing to SQL Server. If either check here ever fails, R2
// no longer satisfies its acceptance criterion and must not be marked PLANNED/BUILT.

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
const REVIEWED_SQL_DRIVERS = ["mssql"];

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
  it("package.json declares no unreviewed SQL write-capable driver as a dependency", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const unreviewed = KNOWN_SQL_DRIVERS.filter(
      (driver) => driver in allDeps && !REVIEWED_SQL_DRIVERS.includes(driver)
    );
    expect(unreviewed).toEqual([]);
  });

  it.each(["dmvReader.ts", "dmvLiveSource.ts", "index.ts", "httpServer.ts"])(
    "%s contains no SQL write-statement keywords",
    (fileName) => {
      const source = readFileSync(join(__dirname, fileName), "utf-8");
      const matches = FORBIDDEN_WRITE_KEYWORDS.filter((pattern) => pattern.test(source));
      expect(matches).toEqual([]);
    }
  );
});
