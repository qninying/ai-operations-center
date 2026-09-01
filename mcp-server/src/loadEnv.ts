import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Nothing in this codebase previously loaded mcp-server/.env into process.env — a
// filled-in .env was silently inert; every process.env.* read (dmvLiveSource.ts,
// rootCauseAgent.ts) only ever saw real values if the shell exported them manually.
// Uses Node's built-in loadEnvFile (no new dependency).
//
// Finds .env by walking up to this package's own package.json, not a fixed
// relative path — tsconfig.json's rootDir: ".." mirrors this file one directory
// deeper when built (dist/mcp-server/src/loadEnv.js) than in dev mode
// (src/loadEnv.ts), so a hardcoded "../.env" is only ever correct for one of the
// two. Found live: the built server was silently resolving to
// dist/mcp-server/.env, which never exists, so every real SQLSERVER_*/SSRS_*
// value in .env was invisible whenever this ran from dist/ instead of via tsx.
export function findPackageRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
}

const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

if (packageRoot) {
  const envPath = join(packageRoot, ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}
