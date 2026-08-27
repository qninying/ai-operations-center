# ADR-011: A Moroccan-Influenced Day/Night Theme System, Shared Across All Three UI Surfaces

**Status:** Implemented — restyled and live-verified across all three surfaces in both themes, zero logic changes.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-27
**Component:** `mcp-server/src/dashboard.html`, `login.html`, `command-center/assets/`, `frontend/src/`

---

## Context

Asked directly for a full UI/UX redesign — premium, modern, minimalistic, enterprise-ready, with a subtle Moroccan architectural influence (geometric detail, arch-inspired shapes, restrained color — not a literal or "tourist" aesthetic), with an explicit Day (Moroccan Oasis) and Night (Midnight Riad) palette, a smooth toggle between them, and an explicit constraint: no business logic, API, data model, or routing changes.

**Audited before touching any code, per the explicit ask.** Two parallel Explore passes plus direct reading found three separate, independently-styled UI surfaces, not one app with one design system:

- `mcp-server/src/dashboard.html` (1,650 lines) + `login.html` — the most mature surface, where all real AI-workflow UI lives (confidence, claims, grounding, approvals, outcomes). Dark-only, no light variant, but already had a real token system (spacing scale, radius scale, semantic colors) to build on.
- `command-center/` (9 static pages, shared CSS/JS) — real shared navigation and header chrome, but a minimal visual system (one accent color, no spacing scale, no shadows, its own comment calling it "neutral palette until a brand is chosen").
- `frontend/` (React Operations Console) — confirmed via Explore to be a genuine stub: one page, no router, no component library, 2 commits. Not what a user actually sees day to day.

**Resolved directly with the user**: `frontend/` gets the token system applied for consistency, but no new navigation, views, or component library — it stays exactly as thin as it is today, just on-brand. Real design effort went into `dashboard.html`/`login.html` and `command-center/`.

## Decision

**One shared token vocabulary, three independently-maintained files.** Each surface already had its own token prefix and its own CSS pipeline before this change (`--` unprefixed in dashboard.html/login.html, `--cc-` in command-center, `--oc-` in frontend) — every existing token *name* was preserved exactly, only *values* changed, so no component-level CSS needed rewriting, only the `:root` blocks. This is the same "separate build pipelines, synchronized by hand" tradeoff `frontend/App.css`'s own pre-existing comment already documented for its relationship to `command-center.css` — extended to all three now, not fixed, since fixing it would mean introducing a shared build step none of these three pipelines currently has.

**The palette** (exact values, both directions):

| Token role | Day (Moroccan Oasis) | Night (Midnight Riad) |
|---|---|---|
| Background | `#F5F1E8` warm ivory | `#0F202A` deep green-black |
| Elevated surface | `#FBF8F3` cream | `#163832` |
| Text | `#12372F` deep green | `#F5F1E8` warm ivory |
| Accent | `#2E7D6B` emerald | `#3D8F78` emerald |
| Accent secondary | `#C7683D` terracotta (both) | `#C7683D` terracotta (both) |
| Accent tertiary | `#C49A6C` brass | `#D4AF37` gold |

Semantic colors (success/warning/danger) are kept deliberately distinct from the accent hue, per the brief's own rule — not reskinned to brand colors, since conflating "this is on-brand" with "this is a status signal" would undermine the at-a-glance legibility every incident card and status dot depends on.

**The toggle**: `localStorage`-backed `data-theme` attribute on `<html>`, applied by a small synchronous inline script in each surface's `<head>` (before first paint, so there's no flash of the wrong theme), defaulting to `prefers-color-scheme` when no explicit choice exists — the standard three-state pattern (system / explicit light / explicit dark). All three surfaces read and write the **same** `coreops-theme` key, so a preference set on the main dashboard applies on the Command Center and the Operations Console too, without those needing their own toggle control (`frontend/` deliberately has no toggle button of its own — see the re-skin-only scope above).

**Geometric detail, restrained per the brief**: a faint (5% opacity) 8-pointed star motif as a background texture on large, mostly-empty surfaces only — the dashboard's sidebar, the login card, the Command Center header — never on data-dense surfaces (incident cards, tables, KPI tiles). An arch-inspired cue on every major panel/card: a 2px accent-colored top border paired with a top-corner radius one step larger than the bottom corners, evoking architectural structure without an illustrated arch.

**Tokenization as a side effect of the redesign, not separate scope**: `dashboard.html` had several literal hex colors outside its token block (`#ffb3bd`, `#4d2129`, `#06122b`, hover-state colors) that would have silently stayed the old blue theme's colors after the token swap — all now reference tokens, four of them new (`--accent-contrast`, `--accent-hover`, `--surface-hover`, `--danger-hover`) added specifically because the old hardcoded values were standing in for hover/contrast states the original token set never had names for.

**`frontend/src/index.css` correction during audit**: the earlier Explore pass called this file's contents entirely dead Vite-template boilerplate. Direct verification found that wasn't quite right — `#root { ... }` targets the real DOM mount point and does affect the live rendered page (centering, max-width, flex layout), unlike the unreferenced `--text`/`--accent`/`--shadow` token set and `h1`/`h2`/`code`/`.counter` rules around it, which matched nothing in `App.tsx`'s real JSX. Kept the live rule (now pointing at `App.css`'s real `--oc-border` token instead of the deleted duplicate), removed only what was confirmed genuinely unreferenced.

## Consequences

**What this closes, live-verified in the browser, not just written:**
- `dashboard.html`/`login.html`: logged in, confirmed real data (9 real incidents across SQL/SSRS/Cloud/Docker) renders correctly in both themes, confirmed the toggle switches instantly and survives a reload with no flash of the wrong theme.
- `command-center/`: served over real HTTP (`python3 -m http.server`, required — these pages don't work over `file://`), confirmed `guardrails.html`'s real card grid (real `.colaberry/plan.json` data) renders correctly in both themes, confirmed the toggle applies instantly without a page reload (unlike the existing Sample/Real toggle, which does reload).
- `frontend/`: `npm test` — 6/6 passing, unchanged. `npm run dev`, confirmed the real IT Manager summary view (real `10 active incidents`, `5 blocked sessions`, live/fallback badge) renders correctly re-skinned.

**A real, pre-existing bug found during verification, not introduced by this change, not fixed**: `command-center/index.html`'s own `renderOverview()` throws `Cannot read properties of null (reading 'toUpperCase')` on `currentRelease.key` — confirmed via `git diff` that this line was never touched by this redesign. Left as-is, since fixing business logic was explicitly out of scope for this pass — flagged here so it's not mistaken for something this change broke.

**What this explicitly does not cover:**
- No shared build step or single canonical token file — three synchronized copies, an accepted tradeoff already documented in the codebase before this change, not solved by it.
- `frontend/` has no navigation, component library, or additional views — confirmed out of scope directly with the user.
- The pre-existing `command-center/index.html` bug above.

## What would change this decision

- **A real shared build step ever being introduced** across the three pipelines (static HTML, Vite, mcp-server-served) would be the trigger to consolidate the three token copies into one real shared source instead of three hand-synchronized ones.
- **`frontend/` ever becoming the actual primary surface** (real navigation, multiple roles, real usage) would be the trigger to revisit the re-skin-only scope decision and build it out properly, per the same reasoning that kept it thin this pass.
