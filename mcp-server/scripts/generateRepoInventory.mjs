// Generates command-center/data/repo-inventory.json: what this repo's code
// actually contains, so the Command Center's AI Agents and Systems tabs report
// the build rather than only what .colaberry/plan.json names.
//
// Why a generator and not a hand-written list: a hand-maintained roster drifts
// the moment someone adds a source or an agent. Everything below is derived
// from the code on every run:
//   - AI agents   = non-test files in mcp-server/src that import @anthropic-ai/sdk
//   - MCP tools   = every server.registerTool("name", { title: ... }) call
//   - Systems     = every *Source.ts (reads) and *Executor.ts (writes) file,
//                   mapped to the system it talks to by SYSTEM_MAP below.
// A Source/Executor file with no SYSTEM_MAP entry is still reported, under
// "Unmapped integration", so a new integration can never be silently missing.
//
// Deliberately NOT reported: whether anything is live right now. That's a fact
// about the running system (see GET /health/dependencies), not this repo.
//
// Idempotent: same repo state => same JSON, except generated_at and git_sha.
// Run: `npm run inventory` from mcp-server/.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRequirements } from "./repoRequirements.mjs";

// File-name prefix -> the system(s) that file talks to. Labels only; whether a
// file exists, and whether it reads or writes, is always derived from the repo.
export const SYSTEM_MAP = {
  dmvLive: { systems: ["SQL Server"], does: "Reads SQL Server DMVs (blocking sessions, active requests)" },
  ssrsLive: { systems: ["SSRS"], does: "Reads the SSRS ExecutionLog3 report-run history" },
  cloudBlob: { systems: ["SSIS"], does: "Reads SSIS package-run and cloud diagnostic records from Azure Blob Storage" },
  pgActivity: { systems: ["PostgreSQL"], does: "Reads pg_stat_activity and pg_blocking_pids() to find blocked sessions" },
  pgBackendStatus: { systems: ["PostgreSQL"], does: "Reads whether one Postgres backend is blocked (MCP tool)" },
  pgRemediation: { systems: ["PostgreSQL"], does: "Ends one blocking Postgres session (pg_terminate_backend), after human approval" },
  supersetHealth: { systems: ["Apache Superset"], does: "Checks Apache Superset's health endpoint" },
  docker: { systems: ["PostgreSQL", "Apache Superset"], does: "Restarts the PostgreSQL or Apache Superset service, after human approval, then confirms it is back" },
  flyMachines: { systems: ["Fly.io Machines API"], does: "Restarts a Fly.io machine (the production path for the restarts above)" },
};

// Plain-language labels for agents the scan finds. Existence is still derived
// from the code (an SDK import); this only replaces the raw file comment with a
// readable summary. An agent with no entry here falls back to its comment.
export const AGENT_LABELS = {
  rootCauseAgent: {
    name: "Root Cause Analysis Agent",
    does: "Asks Claude why correlated failures happened, using live read-only evidence. Returns a root cause, a confidence score and the evidence IDs it cited. Every citation is checked against the evidence it was actually given.",
  },
  diagnosticsGatherer: {
    name: "Diagnostics Gatherer",
    does: "When the root-cause confidence is under 80%, gathers more diagnostics and asks Claude again. Under 60%, the incident escalates to a person.",
  },
};

// Fixture files that let a source fall back to clearly-tagged sample data when
// the real system is unreachable. Reported so the page can say so honestly.
const FIXTURE_FALLBACK = { dmvLive: "dmvFixtures.ts", ssrsLive: "ssrsFixtures.ts" };

// External services used by non-integration files, detected by import/URL.
const SERVICE_DETECTORS = [
  { system: "Anthropic Claude API", pattern: /from "@anthropic-ai\/sdk"/, does: "Root-cause reasoning and follow-up diagnostics (the two AI agents)" },
  { system: "ntfy push notifications", pattern: /ntfy\.sh|NTFY_TOPIC/, does: "Pages operators about new incidents and actions" },
];

const isCodeFile = (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts");

function humanize(fileBase) {
  return fileBase
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

// First comment block after the imports: the file's own description of itself.
export function leadingComment(source) {
  const lines = source.split("\n");
  let i = 0;
  while (i < lines.length && (/^\s*(import|export \{|\})/.test(lines[i]) || lines[i].trim() === "" || /^\s+\S/.test(lines[i]) && i < 15 && !/^\s*\/\//.test(lines[i]))) i++;
  const out = [];
  for (; i < lines.length && /^\s*\/\//.test(lines[i]); i++) out.push(lines[i].replace(/^\s*\/\/\s?/, ""));
  const text = out.join(" ").replace(/\s+/g, " ").trim();
  const firstSentences = text.match(/^(.+?[.!?])(\s|$)(.+?[.!?])?/);
  return firstSentences ? (firstSentences[1] + (firstSentences[3] ? " " + firstSentences[3] : "")).trim() : text.slice(0, 240);
}

export function buildInventory(repoRoot, { now = new Date(), gitSha = null, includeRequirements = true } = {}) {
  const srcDir = join(repoRoot, "mcp-server", "src");
  const files = readdirSync(srcDir).filter(isCodeFile).sort();
  const read = (f) => readFileSync(join(srcDir, f), "utf8");
  const rel = (f) => `mcp-server/src/${f}`;
  const hasTest = (f) => existsSync(join(srcDir, f.replace(/\.ts$/, ".test.ts")));

  const agents = files
    .filter((f) => /from "@anthropic-ai\/sdk"/.test(read(f)))
    .map((f) => {
      const label = AGENT_LABELS[f.replace(/\.ts$/, "")];
      return {
        name: label ? label.name : humanize(f.replace(/\.ts$/, "")),
        file: rel(f),
        description: label ? label.does : leadingComment(read(f)),
        has_tests: hasTest(f),
      };
    });

  const mcp_tools = [];
  const toolRe = /registerTool\(\s*"([^"]+)",\s*\{\s*title:\s*"([^"]+)"/g;
  for (const f of files) {
    for (const m of read(f).matchAll(toolRe)) mcp_tools.push({ name: m[1], title: m[2], file: rel(f) });
  }
  mcp_tools.sort((a, b) => a.name.localeCompare(b.name));

  const bySystem = new Map();
  const addTo = (system, entry) => {
    if (!bySystem.has(system)) bySystem.set(system, { name: system, reads: [], writes: [], uses: [] });
    const s = bySystem.get(system);
    s[entry.kind].push(entry);
  };
  for (const f of files) {
    const m = f.match(/^(.*)(Source|Executor)\.ts$/);
    if (!m) continue;
    const [, prefix, suffix] = m;
    const mapped = SYSTEM_MAP[prefix];
    const kind = suffix === "Source" ? "reads" : "writes";
    const entry = {
      kind,
      file: rel(f),
      does: mapped ? mapped.does : "Not described yet: add this file to SYSTEM_MAP in generateRepoInventory.mjs",
      has_tests: hasTest(f),
      fixture_fallback: FIXTURE_FALLBACK[prefix] && existsSync(join(srcDir, FIXTURE_FALLBACK[prefix])) ? rel(FIXTURE_FALLBACK[prefix]) : null,
    };
    for (const system of mapped ? mapped.systems : ["Unmapped integration"]) addTo(system, entry);
  }
  for (const d of SERVICE_DETECTORS) {
    const users = files.filter((f) => d.pattern.test(read(f)));
    if (users.length) addTo(d.system, { kind: "uses", files: users.map(rel), does: d.does });
  }
  const systems = [...bySystem.values()]
    .map((s) => {
      const clean = (arr) => arr.map(({ kind, ...rest }) => rest);
      return { name: s.name, reads: clean(s.reads), writes: clean(s.writes), uses: clean(s.uses) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    git_sha: gitSha,
    note: "Generated from the code by mcp-server/scripts/generateRepoInventory.mjs. Describes what the repo contains, not whether anything is live right now.",
    agents,
    mcp_tools,
    systems,
    // Every requirement in docs/REQUIREMENTS.md and every story in docs/stories/,
    // with repo evidence. See repoRequirements.mjs.
    ...(includeRequirements ? (() => {
      const { requirements, stories } = buildRequirements(repoRoot);
      return { requirements, repo_stories: stories };
    })() : {}),
  };
}

function currentGitSha(repoRoot) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, timeout: 5000 }).toString().trim();
  } catch (error) {
    console.warn(`generateRepoInventory: could not read git SHA (${error instanceof Error ? error.message : String(error)}); writing null`);
    return null;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const inventory = buildInventory(repoRoot, { gitSha: currentGitSha(repoRoot) });
  const outPath = join(repoRoot, "command-center", "data", "repo-inventory.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(inventory, null, 2) + "\n");
  console.log(
    `Wrote ${outPath}: ${inventory.agents.length} AI agents, ${inventory.mcp_tools.length} MCP tools, ${inventory.systems.length} systems, ` +
      `${(inventory.requirements || []).length} requirements, ${(inventory.repo_stories || []).length} repo stories`
  );
}
