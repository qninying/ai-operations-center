// CoreOps Command Center — shared runtime.
// Fetches .colaberry/*.json at runtime (never hard-coded into a page), renders
// the shared nav + "Data as of" header, and manages the global sample/real toggle.
// Every page includes this file and calls CommandCenter.init(tabId, render).

const TABS = [
  { id: "overview", label: "Overview", href: "index.html" },
  { id: "outcomes", label: "Outcomes", href: "outcomes.html" },
  { id: "users", label: "Users & Use Case", href: "users.html" },
  { id: "guardrails", label: "Guardrails", href: "guardrails.html" },
  { id: "systems", label: "Systems", href: "systems.html" },
  { id: "project-management", label: "Project Management", href: "project-management.html" },
  { id: "agents", label: "AI Agents", href: "agents.html" },
  { id: "knowledge-base", label: "Knowledge Base", href: "knowledge-base.html" },
  { id: "data-model", label: "Data Model", href: "data-model.html" },
];

const MODE_KEY = "cc-mode"; // "sample" | "real"
const THEME_KEY = "coreops-theme"; // same storage key as the main dashboard,
// so a preference set on either surface applies to both.

// Real by default: the Command Center reports what the plan and repo actually
// contain. Sample (an illustrative overlay of invented states) is opt-in only,
// via the toggle, because as the default it contradicted real data (e.g.
// REQ-012 "Not enforced yet" while its story was verified). Changed 2026-10-05.
function getMode() {
  let saved = null;
  try { saved = localStorage.getItem(MODE_KEY); } catch (e) { /* storage blocked: fall back to real */ }
  return saved === "sample" ? "sample" : "real";
}

function setMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
  location.reload();
}

function getTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Applies instantly via the CSS custom properties already in place — no
// reload needed, unlike setMode() above, which changes what data is shown
// rather than just how it looks.
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  renderThemeToggleIcon();
}

const SUN_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';

function renderThemeToggleIcon() {
  const btn = document.getElementById("cc-theme-toggle");
  if (btn) btn.innerHTML = getTheme() === "dark" ? MOON_ICON : SUN_ICON;
}

async function fetchJson(path) {
  // no-store: these files change every time the platform syncs, and the whole
  // point of manifest.json's staleness check is detecting exactly that change.
  // A cached response would make the freshness indicator itself go stale.
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  const [plan, progress, manifest] = await Promise.all([
    fetchJson("../.colaberry/plan.json").catch(() => null),
    fetchJson("../.colaberry/progress.json").catch(() => null),
    fetchJson("../.colaberry/manifest.json").catch(() => null),
  ]);
  // Generated from the code by `npm run inventory` (mcp-server/scripts/
  // generateRepoInventory.mjs): what the repo actually contains, alongside what
  // the plan names. null when it hasn't been generated, and pages say so.
  const inventory = await fetchJson("data/repo-inventory.json").catch(() => null);
  return { plan, progress, manifest, inventory };
}

function formatDataAsOf(manifest) {
  if (!manifest || !manifest.generated_at) {
    return { text: "Data as of: unknown — .colaberry/manifest.json is missing or unreadable", stale: true };
  }
  const generated = new Date(manifest.generated_at);
  const now = new Date();
  const diffDays = (now - generated) / (1000 * 60 * 60 * 24);
  const absolute = generated.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
  let relative;
  if (diffDays < 1) relative = "today";
  else if (diffDays < 2) relative = "1 day ago";
  else relative = `${Math.floor(diffDays)} days ago`;
  const stale = diffDays > 7;
  let text = `Data as of ${absolute} (${relative})`;
  if (stale) text += " — sync from the portal to refresh";
  return { text, stale };
}

function sampleBadge() {
  return getMode() === "sample" ? '<span class="cc-sample-badge">Sample data</span>' : "";
}

// Drill-down param, e.g. outcomes.html?id=REQ-017 — every tab handles both a
// list view (no id) and a detail view (id present) in the same file.
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// Named escapeHtml internally (not "esc") specifically so every page's inline
// script can safely do `const { esc } = CommandCenter;` without colliding with
// a same-named top-level function declaration — these are plain <script> tags
// sharing one global scope, not modules, so that redeclaration is a SyntaxError
// that silently aborts the whole script. Caught this exact bug during verification.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// Finds every story that fulfils a requirement, then looks up each story's
// verification state in progress.json. A requirement/guardrail counts as
// "enforced" only if EVERY fulfilling story is verified — partial coverage is
// shown as partial, not rounded up to enforced.
function verificationForRequirement(plan, progress, req) {
  const storyIds = (req && req.fulfilled_by) || [];
  if (storyIds.length === 0) {
    return { state: "unfulfilled", stories: [] };
  }
  const progressStories = (progress && progress.stories) || [];
  const stories = storyIds.map((id) => {
    const planStory = (plan.stories || []).find((s) => s.id === id);
    const progressStory = progressStories.find((s) => s.id === id);
    return {
      id,
      title: planStory ? planStory.title : id,
      state: progressStory ? progressStory.verification.state : "not_started",
    };
  });
  const allVerified = stories.every((s) => s.state === "verified");
  const anyVerified = stories.some((s) => s.state === "verified");
  const state = allVerified ? "enforced" : anyVerified ? "partial" : "not_enforced";
  return { state, stories };
}

function statusDot(state) {
  const cls = state === "verified" || state === "enforced" || state === "built_and_tested" ? "cc-dot-ok"
    : state === "error" || state === "no_evidence" ? "cc-dot-error"
    : state === "built_partly" || state === "built_target_unmeasured" || state === "partial" ? "cc-dot-warn" : "";
  return `<span class="cc-dot ${cls}"></span>`;
}

function renderChrome(activeTabId, dataAsOf) {
  const nav = document.getElementById("cc-nav");
  const modeToggle = document.getElementById("cc-mode-toggle");
  const stamp = document.getElementById("cc-data-as-of");

  if (nav) {
    nav.innerHTML = TABS.map(
      (t) => `<a href="${t.href}" class="cc-tab${t.id === activeTabId ? " active" : ""}">${t.label}</a>`
    ).join("");
  }

  if (modeToggle) {
    const mode = getMode();
    modeToggle.innerHTML = `
      <button class="cc-mode-btn${mode === "sample" ? " active" : ""}" data-mode="sample">Sample</button>
      <button class="cc-mode-btn${mode === "real" ? " active" : ""}" data-mode="real">Real</button>
    `;
    modeToggle.querySelectorAll(".cc-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.dataset.mode));
    });
  }

  if (stamp && dataAsOf) {
    stamp.textContent = dataAsOf.text;
    stamp.className = "cc-data-as-of" + (dataAsOf.stale ? " cc-stale" : "");
  }

  const themeToggle = document.getElementById("cc-theme-toggle");
  if (themeToggle) {
    renderThemeToggleIcon();
    themeToggle.addEventListener("click", () => {
      setTheme(getTheme() === "dark" ? "light" : "dark");
    });
  }
}

// init(tabId, renderFn): fetches data, renders shared chrome, then calls
// renderFn({ plan, progress, manifest, inventory, mode }) to render the page's own content.
async function init(tabId, renderFn) {
  const { plan, progress, manifest, inventory } = await loadData();
  const dataAsOf = formatDataAsOf(manifest);
  renderChrome(tabId, dataAsOf);
  if (renderFn) {
    renderFn({ plan, progress, manifest, inventory, mode: getMode(), dataAsOf });
  }
}

// The plan's schema_version 2 sends demo_release_key: null when no release is
// marked as the demo target. Calling .toUpperCase() on it threw and left Overview
// and Project Management stuck on "Loading…" (found 2026-10-05). Returns an
// escaped "(release R2)" fragment, or "" when no demo release is set.
function demoReleaseLabel(schedule) {
  const key = schedule && schedule.demo_release_key;
  return key ? `(release ${escapeHtml(String(key).toUpperCase())})` : "";
}

// plan.derived.owners isn't in schema_version 2; every story carries owner_agent
// instead. Use derived.owners when the platform sends it, otherwise group stories
// by owner_agent, so owners come from the plan either way rather than being blank.
function storyOwners(plan) {
  if (plan && plan.derived && Array.isArray(plan.derived.owners)) return plan.derived.owners;
  const byName = new Map();
  for (const s of (plan && plan.stories) || []) {
    if (!s.owner_agent) continue;
    if (!byName.has(s.owner_agent)) byName.set(s.owner_agent, { name: s.owner_agent, owns: [] });
    byName.get(s.owner_agent).owns.push(s.id);
  }
  return [...byName.values()];
}

// Every requirement that exists: the plan's, plus any the repo's own
// docs/REQUIREMENTS.md adds (from the generated inventory). Plan entries keep
// their plan fields; repo-only ones are marked source: "repo".
function allRequirements(plan, inventory) {
  const planReqs = ((plan && plan.requirements) || []).map((r) => ({ ...r, source: "plan" }));
  const seen = new Set(planReqs.map((r) => r.id));
  const repoOnly = ((inventory && inventory.requirements) || [])
    .filter((r) => !seen.has(r.id))
    .map((r) => ({
      id: r.id, statement: r.statement, priority: r.priority || "constraint",
      kind: r.kind, fulfilled_by: [], source: "repo",
    }));
  return [...planReqs, ...repoOnly].sort((a, b) => a.id.localeCompare(b.id));
}

// "Built outside the plan" is the whole distinction from platform-verified
// work. The dot colour says the rest: green when the code has tests, amber when
// it doesn't (e.g. a document deliverable, or a live drill rather than a test).
const REPO_STATUS_LABEL = {
  built_and_tested: "Built outside the plan",
  built_partly: "Built outside the plan",
  built_target_unmeasured: "Built; target not measured yet",
  planned: "Planned",
  documented_only: "Built outside the plan",
  no_evidence: "Not built",
};

// One honest status per requirement. A platform story (progress.json) wins
// when the plan has one; otherwise the repo's own evidence speaks, labelled as
// such, so work done after the platform's tracking still shows without anyone
// editing plan.json by hand.
function requirementStatus(plan, progress, inventory, req) {
  const v = verificationForRequirement(plan, progress, req);
  const repo = ((inventory && inventory.requirements) || []).find((r) => r.id === (req && req.id)) || null;
  if (v.state !== "unfulfilled") {
    const label = v.state === "enforced" ? "Verified by the platform" : v.state === "partial" ? "Partly verified by the platform" : "Not verified yet";
    return { state: v.state, label, stories: v.stories, repo };
  }
  if (!repo) return { state: "no_evidence", label: "Not built", stories: [], repo: null };
  return { state: repo.repo_status, label: REPO_STATUS_LABEL[repo.repo_status] || repo.repo_status, stories: [], repo };
}

// The story that covers a requirement: the plan's story if it has one,
// otherwise a repo story (docs/stories/), otherwise "Built directly" when the
// repo shows the work was done without a story.
function storyLabel(req, status) {
  const planStories = (req && req.fulfilled_by) || [];
  if (planStories.length) return planStories.join(", ");
  const repoStories = (status && status.repo && status.repo.repo_stories) || [];
  if (repoStories.length) return repoStories.join(", ");
  if (status && /^built|^documented/.test(status.state)) return "Built directly";
  return "—";
}

// Short, linkable summary of a requirement's repo evidence for tables.
function evidenceSummary(repo) {
  if (!repo) return "";
  const e = repo.evidence || {};
  const parts = [];
  if ((e.code || []).length) parts.push(`${e.code.length} code`);
  if ((e.tests || []).length) parts.push(`${e.tests.length} test`);
  if ((e.docs || []).length) parts.push(`${e.docs.length} doc`);
  if ((e.commits || []).length) parts.push(`${e.commits.length} commit`);
  if ((repo.repo_stories || []).length) parts.push(repo.repo_stories.join(", "));
  return parts.join(" · ");
}

window.CommandCenter = {
  TABS, getMode, setMode, loadData, formatDataAsOf, renderChrome, sampleBadge, demoReleaseLabel, storyOwners,
  allRequirements, requirementStatus, evidenceSummary, storyLabel,
  init, getParam, esc: escapeHtml, verificationForRequirement, statusDot,
  getTheme, setTheme,
};
