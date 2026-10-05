// Requirements and stories as the REPO records them, so the Command Center can
// show every requirement that exists, including ones added after the
// platform's plan, and say what evidence of it is in the code. Used by
// generateRepoInventory.mjs. Everything is derived on each run:
//   - requirements  <- docs/REQUIREMENTS.md headings ("### REQ-019 — Safety · should")
//   - repo stories  <- docs/stories/STORY-*.md (title, REQ ids it satisfies,
//                      and progress from its own "- [x]" / "- [ ]" criteria)
//   - evidence      <- which code, test and doc files mention each REQ id
//
// Evidence is a reference, not proof: a file mentioning REQ-014 shows where the
// work lives, it doesn't verify the work. The status words below say so.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const REQ_HEADING = /^###\s+(REQ-\d{3})\s*[—:-]\s*([A-Za-z-]+)(?:\s*·\s*([a-z]+))?/;

export function parseRequirementsDoc(md) {
  const lines = md.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(REQ_HEADING);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    const para = [];
    for (; j < lines.length && lines[j].trim() !== "" && !lines[j].startsWith("#"); j++) para.push(lines[j].trim());
    let fulfillment = null;
    for (let k = j; k < lines.length && !lines[k].startsWith("### ") && !lines[k].startsWith("## "); k++) {
      if (/^Fulfilled\b/.test(lines[k].trim())) { fulfillment = lines[k].trim(); break; }
    }
    out.push({ id: m[1], kind: m[2], priority: m[3] || null, statement: para.join(" "), fulfillment });
  }
  return out;
}

export function parseStoryDoc(md, file) {
  const title = md.match(/^#\s+(STORY-\d{3})\s*[:—-]\s*(.+)$/m);
  if (!title) return null;
  const done = (md.match(/^\s*- \[x\]/gim) || []).length;
  const open = (md.match(/^\s*- \[ \]/gm) || []).length;
  // Only the ids listed under "## The requirement this satisfies": the rest of
  // a story file mentions other requirements as context (STORY-000 mentions all
  // of them while explicitly satisfying none).
  const section = md.match(/^## The requirement(?:s)? this satisf(?:ies|y)\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  const satisfies = [...new Set(((section ? section[1] : "").match(/REQ-\d{3}/g)) || [])].sort();
  const status = md.match(/^\*\*Status:\*\*\s*(.+)$/m);
  return {
    id: title[1],
    title: title[2].trim(),
    file,
    satisfies,
    criteria_done: done,
    criteria_total: done + open,
    status: status ? status[1].trim() : null,
  };
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "data"]);
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|yml|yaml|md)$/.test(name)) out.push(full);
  }
  return out;
}

// Which files mention each REQ id, split into code / tests / docs. The three
// requirements-tracking docs themselves are excluded: they mention every id.
const TRACKING_DOCS = new Set(["docs/REQUIREMENTS.md", "docs/TRACEABILITY.md", "docs/STORIES.md"]);
const CODE_ROOTS = ["mcp-server/src", "mcp-server/scripts", "guardrails", "frontend/src", ".github/workflows"];
const SELF_FILES = /^mcp-server\/scripts\/(repoRequirements|generateRepoInventory)\./;
export function requirementEvidence(repoRoot) {
  const roots = ["mcp-server/src", "mcp-server/scripts", "guardrails", "frontend/src", ".github/workflows", "docs"];
  const evidence = {};
  for (const root of roots) {
    for (const full of walk(join(repoRoot, root))) {
      const rel = relative(repoRoot, full);
      if (TRACKING_DOCS.has(rel) || rel.startsWith("docs/stories/")) continue;
      // The inventory generator's own files mention REQ ids as test fixtures;
      // counting them would make every requirement look tested.
      if (SELF_FILES.test(rel)) continue;
      const ids = new Set(readFileSync(full, "utf8").match(/REQ-\d{3}/g) || []);
      const bucket = rel.startsWith("docs/") ? "docs" : /\.test\.(ts|tsx|mjs|js)$/.test(rel) ? "tests" : "code";
      for (const id of ids) {
        evidence[id] ??= { code: [], tests: [], docs: [] };
        evidence[id][bucket].push(rel);
      }
    }
  }
  // A code file's own test file (foo.ts -> foo.test.ts) tests that code, even
  // when the test never mentions the requirement id. Without this, a real,
  // tested feature (e.g. REQ-019's evidenceGroundingCheck.ts) looked untested.
  for (const e of Object.values(evidence)) {
    for (const file of e.code) {
      const sibling = file.replace(/\.(ts|tsx|mjs|js)$/, ".test.$1");
      if (sibling !== file && existsSync(join(repoRoot, sibling)) && !e.tests.includes(sibling)) e.tests.push(sibling);
    }
  }
  for (const e of Object.values(evidence)) for (const k of ["code", "tests", "docs"]) e[k].sort();
  return evidence;
}

// Commits whose subject names a REQ id: real evidence that work landed, even
// when the code itself never mentions the id. Each commit block starts with an
// "@@<sha> <subject>" line, followed by the files it changed (git log
// --name-only). The files tell us where that requirement's code and tests live.
export function commitEvidence(gitLogText) {
  const out = {};
  let current = null;
  for (const line of gitLogText.split("\n")) {
    const head = line.match(/^@@([0-9a-f]{7,})\s+(.*)$/);
    if (head) {
      current = { sha: head[1], subject: head[2], files: [], ids: [...new Set(head[2].match(/REQ-\d{3}/g) || [])] };
      for (const id of current.ids) (out[id] ??= []).push(current);
      continue;
    }
    if (current && line.trim()) current.files.push(line.trim());
  }
  for (const list of Object.values(out)) for (const c of list) delete c.ids;
  return out;
}

function readGitLog(repoRoot) {
  try {
    return execFileSync("git", ["log", "--format=@@%h %s", "--name-only"], { cwd: repoRoot, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch (error) {
    console.warn(`repoRequirements: git log unavailable (${error instanceof Error ? error.message : String(error)}); commit evidence omitted`);
    return "";
  }
}

// One plain status per requirement, from repo evidence only. The Command Center
// uses this when the platform's plan has no story for a requirement.
export function repoStatus(evidence, stories, kind = "") {
  const e = { code: [], tests: [], docs: [], commits: [], ...(evidence || {}) };
  // Platform-tracked stories record progress in .colaberry/progress.json, not in
  // their markdown checkboxes, so only self-scoped stories count here.
  stories = stories.filter((s) => !s.tracked_by_platform);
  const done = stories.filter((s) => s.criteria_total > 0 && s.criteria_done === s.criteria_total);
  const started = stories.filter((s) => s.criteria_done > 0 && s.criteria_done < s.criteria_total);
  const planned = stories.filter((s) => s.criteria_total > 0 && s.criteria_done === 0);
  const built = (e.code.length && e.tests.length) || done.length;
  const someWork = built || e.code.length || e.commits.length || started.length;
  // A non-functional requirement is a target (e.g. "reduce correlation by
  // 50-70%"). Code existing never proves the target was met, so it stops here.
  if (/non-functional/i.test(kind) && someWork) return "built_target_unmeasured";
  if (built) return "built_and_tested";
  if (someWork) return "built_partly";
  if (planned.length) return "planned";
  if (e.docs.length) return "documented_only";
  return "no_evidence";
}

// Stories the platform tracks: listed in plan.json or progress.json (STORY-000,
// the Command Center itself, is only in progress.json).
function platformStoryIds(repoRoot) {
  const ids = new Set();
  for (const file of ["plan.json", "progress.json"]) {
    try {
      const data = JSON.parse(readFileSync(join(repoRoot, ".colaberry", file), "utf8"));
      for (const s of data.stories || []) ids.add(s.id);
    } catch {
      // Missing or unreadable: treat its stories as self-scoped rather than
      // failing the whole inventory.
    }
  }
  return ids;
}

export function buildRequirements(repoRoot) {
  const tracked = platformStoryIds(repoRoot);
  const reqPath = join(repoRoot, "docs", "REQUIREMENTS.md");
  const requirements = existsSync(reqPath) ? parseRequirementsDoc(readFileSync(reqPath, "utf8")) : [];
  const storiesDir = join(repoRoot, "docs", "stories");
  const stories = existsSync(storiesDir)
    ? readdirSync(storiesDir)
        .filter((f) => /^STORY-\d{3}\.md$/.test(f))
        .sort()
        .map((f) => parseStoryDoc(readFileSync(join(storiesDir, f), "utf8"), `docs/stories/${f}`))
        .filter(Boolean)
        .map((s) => ({ ...s, tracked_by_platform: tracked.has(s.id) }))
    : [];
  const evidence = requirementEvidence(repoRoot);
  const commits = commitEvidence(readGitLog(repoRoot));
  const withEvidence = requirements.map((r) => {
    const satisfiedBy = stories.filter((s) => s.satisfies.includes(r.id));
    const base = evidence[r.id] || { code: [], tests: [], docs: [] };
    const ev = { code: [...base.code], tests: [...base.tests], docs: [...base.docs], commits: (commits[r.id] || []).map(({ sha, subject }) => ({ sha, subject })) };
    // Files changed by the commits that delivered this requirement, if they
    // still exist: code and tests only (not PROGRESS.md and the like).
    for (const c of commits[r.id] || []) {
      for (const f of c.files) {
        if (!CODE_ROOTS.some((root) => f.startsWith(root + "/")) || !existsSync(join(repoRoot, f))) continue;
        const bucket = /\.test\.(ts|tsx|mjs|js)$/.test(f) ? "tests" : /\.(ts|tsx|mjs|js|yml|yaml)$/.test(f) ? "code" : null;
        if (bucket && !SELF_FILES.test(f) && !ev[bucket].includes(f)) ev[bucket].push(f);
      }
    }
    for (const f of [...ev.code]) {
      const sibling = f.replace(/\.(ts|tsx|mjs|js)$/, ".test.$1");
      if (sibling !== f && existsSync(join(repoRoot, sibling)) && !ev.tests.includes(sibling)) ev.tests.push(sibling);
    }
    ev.code.sort(); ev.tests.sort();
    return {
      ...r,
      evidence: ev,
      repo_stories: satisfiedBy.map((s) => s.id),
      repo_status: repoStatus(ev, satisfiedBy, r.kind),
    };
  });
  return { requirements: withEvidence, stories };
}
