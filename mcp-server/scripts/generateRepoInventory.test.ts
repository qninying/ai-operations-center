import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildInventory, leadingComment, readConnectors, inventoriesMatch } from "./generateRepoInventory.mjs";

let root: string;
const src = () => join(root, "mcp-server", "src");
const write = (file: string, body: string) => writeFileSync(join(src(), file), body);
const FIXED = { now: new Date("2026-10-05T12:00:00Z"), gitSha: "abc1234", includeRequirements: false };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "inventory-"));
  mkdirSync(src(), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("buildInventory", () => {
  it("happy path: finds AI agents, MCP tools, and mapped systems from the code", () => {
    write("triageAgent.ts", `import Anthropic from "@anthropic-ai/sdk";\n\n// Explains why an incident happened. Uses live evidence only.\nexport const x = 1;\n`);
    write("triageAgent.test.ts", `// test`);
    write("mcpServerFactory.ts", `server.registerTool(\n  "read_sql_server_dmv",\n  {\n    title: "Read SQL Server DMV",\n`);
    write("dmvLiveSource.ts", `import sql from "mssql";\n`);
    write("dmvFixtures.ts", `export const rows = [];\n`);
    write("pgRemediationExecutor.ts", `import pg from "pg";\n`);

    const inv = buildInventory(root, FIXED);

    expect(inv.agents).toEqual([
      {
        name: "Triage Agent",
        file: "mcp-server/src/triageAgent.ts",
        description: "Explains why an incident happened. Uses live evidence only.",
        has_tests: true,
      },
    ]);
    expect(inv.mcp_tools).toEqual([
      { name: "read_sql_server_dmv", title: "Read SQL Server DMV", file: "mcp-server/src/mcpServerFactory.ts" },
    ]);
    const sql = inv.systems.find((s: { name: string }) => s.name === "SQL Server");
    expect(sql.reads[0].fixture_fallback).toBe("mcp-server/src/dmvFixtures.ts");
    const pg = inv.systems.find((s: { name: string }) => s.name === "PostgreSQL");
    expect(pg.writes.map((w: { file: string }) => w.file)).toEqual(["mcp-server/src/pgRemediationExecutor.ts"]);
    expect(inv.systems.find((s: { name: string }) => s.name === "Anthropic Claude API").uses[0].files).toEqual([
      "mcp-server/src/triageAgent.ts",
    ]);
  });

  it("a known agent gets its plain-language label instead of the raw file comment", () => {
    write("rootCauseAgent.ts", `import Anthropic from "@anthropic-ai/sdk";\n// R1 / STORY-003: internal notes.\n`);
    const [agent] = buildInventory(root, FIXED).agents;
    expect(agent.name).toBe("Root Cause Analysis Agent");
    expect(agent.description).toMatch(/^Asks Claude why correlated failures happened/);
    expect(agent.has_tests).toBe(false);
  });

  it("failure path: an unmapped Source/Executor file is reported, never silently dropped", () => {
    write("kafkaSource.ts", `export {};\n`);
    const inv = buildInventory(root, FIXED);
    const unmapped = inv.systems.find((s: { name: string }) => s.name === "Unmapped integration");
    expect(unmapped.reads[0].file).toBe("mcp-server/src/kafkaSource.ts");
    expect(unmapped.reads[0].does).toMatch(/add this file to SYSTEM_MAP/);
  });

  it("boundary: an empty src directory produces empty lists, not an error", () => {
    const inv = buildInventory(root, FIXED);
    expect(inv.agents).toEqual([]);
    expect(inv.mcp_tools).toEqual([]);
    expect(inv.systems).toEqual([]);
  });

  it("boundary: test files that import the SDK are not counted as agents", () => {
    write("fake.test.ts", `import Anthropic from "@anthropic-ai/sdk";\n`);
    expect(buildInventory(root, FIXED).agents).toEqual([]);
  });

  it("idempotency: the same repo state produces identical output", () => {
    write("rootCauseAgent.ts", `import Anthropic from "@anthropic-ai/sdk";\n// Does a thing.\n`);
    write("supersetHealthSource.ts", `export {};\n`);
    expect(buildInventory(root, FIXED)).toEqual(buildInventory(root, FIXED));
  });

  it("real repo: reports the two Claude-calling agents that exist today", () => {
    const repoRoot = resolve(__dirname, "..", "..");
    const names = buildInventory(repoRoot, FIXED).agents.map((a: { file: string }) => a.file);
    expect(names).toContain("mcp-server/src/rootCauseAgent.ts");
    expect(names).toContain("mcp-server/src/diagnosticsGatherer.ts");
  });
});

describe("leadingComment", () => {
  it("returns the first comment block after imports, trimmed to two sentences", () => {
    const src = `import a from "a";\nimport b from "b";\n\n// One. Two. Three.\n// More.\nconst x = 1;\n`;
    expect(leadingComment(src)).toBe("One. Two.");
  });

  it("returns an empty string when there is no comment", () => {
    expect(leadingComment(`import a from "a";\nconst x = 1;\n`)).toBe("");
  });
});

describe("readConnectors (REQ-018)", () => {
  it("lists only connectors in the REGISTERED array, with id, system and reachability from each file", () => {
    const dir = join(src(), "connectors");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), [
      'import { aConnector } from "./aConnector.js";',
      'import { bConnector } from "./bConnector.js";',
      "const REGISTERED: readonly SourceConnector[] = [",
      "  aConnector,",
      "];",
    ].join("\n"));
    writeFileSync(join(dir, "aConnector.ts"), 'export const aConnector = { id: "a", system: "Alpha DB", reachabilityName: "alpha" };');
    writeFileSync(join(dir, "bConnector.ts"), 'export const bConnector = { id: "b", system: "Beta", reachabilityName: "b" };');
    expect(readConnectors(root)).toEqual([
      { name: "aConnector", id: "a", system: "Alpha DB", reachability: "alpha", file: "mcp-server/src/connectors/aConnector.ts" },
    ]);
    const alpha = buildInventory(root, FIXED).systems.find((s: { name: string }) => s.name === "Alpha DB");
    expect(alpha.connector).toEqual({ id: "a", reachability: "alpha", file: "mcp-server/src/connectors/aConnector.ts" });
  });

  it("boundary: no connectors folder gives an empty list", () => {
    expect(readConnectors(root)).toEqual([]);
  });
});

describe("inventoriesMatch (--check mode)", () => {
  it("ignores the volatile generated_at and git_sha fields", () => {
    expect(inventoriesMatch({ generated_at: "a", git_sha: "1", agents: [] }, { generated_at: "b", git_sha: "2", agents: [] })).toBe(true);
  });
  it("detects a real content change", () => {
    expect(inventoriesMatch({ agents: [] }, { agents: [{ name: "New Agent" }] })).toBe(false);
  });
});
