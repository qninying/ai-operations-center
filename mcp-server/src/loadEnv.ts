import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Nothing in this codebase previously loaded mcp-server/.env into process.env — a
// filled-in .env was silently inert; every process.env.* read (dmvLiveSource.ts,
// rootCauseAgent.ts) only ever saw real values if the shell exported them manually.
// Uses Node's built-in loadEnvFile (no new dependency). A missing .env is not an
// error here, matching every consumer's own "missing config -> fall back / explicit
// typed error" behavior, not a hard crash at startup.

const envPath = fileURLToPath(new URL("../.env", import.meta.url));

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
