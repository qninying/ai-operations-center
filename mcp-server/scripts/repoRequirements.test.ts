import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseRequirementsDoc,
  parseStoryDoc,
  commitEvidence,
  repoStatus,
  buildRequirements,
} from "./repoRequirements.mjs";

const empty = { code: [] as string[], tests: [] as string[], docs: [] as string[], commits: [] as unknown[] };

describe("parseRequirementsDoc", () => {
  it("happy path: reads id, kind, priority, statement and fulfillment line, in both heading styles", () => {
    const md = [
      "### REQ-014 — Functional · should",
      "",
      "The system must allow configuration of confidence thresholds.",
      "",
      "Fulfilled directly, not through a platform story.",
      "",
      "### REQ-025: Constraint · must",
      "",
      "The system must run in production,",
      "not on a laptop.",
      "",
      "### REQ-018 — Constraint",
      "",
      "Plug-in connectors.",
    ].join("\n");
    expect(parseRequirementsDoc(md)).toEqual([
      { id: "REQ-014", kind: "Functional", priority: "should", statement: "The system must allow configuration of confidence thresholds.", fulfillment: "Fulfilled directly, not through a platform story." },
      { id: "REQ-025", kind: "Constraint", priority: "must", statement: "The system must run in production, not on a laptop.", fulfillment: null },
      { id: "REQ-018", kind: "Constraint", priority: null, statement: "Plug-in connectors.", fulfillment: null },
    ]);
  });

  it("boundary: an empty document yields no requirements", () => {
    expect(parseRequirementsDoc("")).toEqual([]);
  });
});

describe("parseStoryDoc", () => {
  it("reads only the REQ ids under 'The requirement this satisfies', and counts its own criteria", () => {
    const md = [
      "# STORY-013: Plug-in connectors",
      "",
      "**Status:** Planned",
      "",
      "## The requirement this satisfies",
      "",
      "- **REQ-018** (Constraint, must)",
      "",
      "## How to build it",
      "",
      "Unlike REQ-007, this is about extensibility.",
      "",
      "## Acceptance",
      "",
      "- [x] one done",
      "- [ ] one open",
    ].join("\n");
    expect(parseStoryDoc(md, "docs/stories/STORY-013.md")).toEqual({
      id: "STORY-013",
      title: "Plug-in connectors",
      file: "docs/stories/STORY-013.md",
      satisfies: ["REQ-018"],
      criteria_done: 1,
      criteria_total: 2,
      status: "Planned",
    });
  });

  it("failure path: a file with no STORY heading is skipped, not guessed", () => {
    expect(parseStoryDoc("just notes", "docs/stories/STORY-099.md")).toBeNull();
  });
});

describe("commitEvidence", () => {
  it("maps REQ ids named in commit subjects to those commits", () => {
    const log = "f073083 REQ-024: live suspicion-check signal\nabc1234 unrelated change\n1de5458 Add REQ-021 and REQ-021 harness\n";
    expect(commitEvidence(log)).toEqual({
      "REQ-024": [{ sha: "f073083", subject: "REQ-024: live suspicion-check signal" }],
      "REQ-021": [{ sha: "1de5458", subject: "Add REQ-021 and REQ-021 harness" }],
    });
  });

  it("boundary: empty git log (git unavailable) gives no evidence rather than throwing", () => {
    expect(commitEvidence("")).toEqual({});
  });
});

describe("repoStatus", () => {
  it("code plus a test naming the requirement = built and tested", () => {
    expect(repoStatus({ ...empty, code: ["a.ts"], tests: ["a.test.ts"] }, [], "Functional")).toBe("built_and_tested");
  });

  it("a non-functional target never counts as met just because code exists", () => {
    expect(repoStatus({ ...empty, code: ["a.ts"], tests: ["a.test.ts"] }, [], "Non-functional")).toBe("built_target_unmeasured");
  });

  it("a self-scoped story with no ticked criteria = planned", () => {
    const story = { criteria_done: 0, criteria_total: 4, tracked_by_platform: false };
    expect(repoStatus(empty, [story], "Constraint")).toBe("planned");
  });

  it("platform-tracked stories' unticked markdown boxes are ignored (progress.json owns their status)", () => {
    const story = { criteria_done: 0, criteria_total: 3, tracked_by_platform: true };
    expect(repoStatus(empty, [story], "Functional")).toBe("no_evidence");
  });

  it("a commit naming the requirement is evidence of work even when no file mentions it", () => {
    expect(repoStatus({ ...empty, commits: [{ sha: "f073083", subject: "REQ-024" }] }, [], "Safety")).toBe("built_partly");
  });
});

describe("buildRequirements", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reqs-"));
    mkdirSync(join(root, "docs", "stories"), { recursive: true });
    mkdirSync(join(root, "mcp-server", "src"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("idempotency: the same repo state produces identical output", () => {
    writeFileSync(join(root, "docs", "REQUIREMENTS.md"), "### REQ-001 — Safety · must\n\nApproval required.\n");
    writeFileSync(join(root, "mcp-server", "src", "guard.ts"), "// REQ-001\n");
    expect(buildRequirements(root)).toEqual(buildRequirements(root));
    expect(buildRequirements(root).requirements[0].evidence.code).toEqual(["mcp-server/src/guard.ts"]);
  });

  it("boundary: no REQUIREMENTS.md and no plan still returns empty lists, not an error", () => {
    expect(buildRequirements(root)).toEqual({ requirements: [], stories: [] });
  });

  it("real repo: every requirement the plan names also exists in docs/REQUIREMENTS.md", () => {
    const repoRoot = resolve(__dirname, "..", "..");
    const ids = buildRequirements(repoRoot).requirements.map((r: { id: string }) => r.id);
    for (let n = 1; n <= 18; n++) expect(ids).toContain(`REQ-${String(n).padStart(3, "0")}`);
  });
});

describe("requirementEvidence: never counts the generator's own fixtures", () => {
  it("REQ-018 has no evidence from this test file or the generator", () => {
    const repoRoot = resolve(__dirname, "..", "..");
    const req018 = buildRequirements(repoRoot).requirements.find((r: { id: string }) => r.id === "REQ-018");
    const all = [...req018.evidence.code, ...req018.evidence.tests, ...req018.evidence.docs];
    expect(all.filter((f: string) => /scripts\/(repoRequirements|generateRepoInventory)\./.test(f))).toEqual([]);
  });
});
