# ADR-004: Serve the Built React Console from `mcp-server` Itself

**Status:** Implemented — built, unit-tested, and live-verified against the running server.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-23
**Component:** `mcp-server/src/staticFiles.ts`, `mcp-server/src/httpServer.ts`, `frontend/`

---

## Context

`frontend/`'s own code had flagged, since it was first written, that "where the
built frontend actually reaches the backend in a real deployment is an open
question this walking skeleton doesn't answer yet." That question stayed abstract
until ADR-003 (session-based auth) made it concrete: the frontend's API call now
needs a session cookie, and cookies are scoped to an origin. Two different origins
— `frontend`'s dev server on one port, `mcp-server` on another — means either CORS
plumbing plus `credentials: 'include'` on every request, or the cookie silently
not being sent at all.

The honest interim fix, done as part of ADR-003's own work, was to make *dev mode*
work correctly (Vite's `server.proxy` forwarding `/login` and `/api/*` to
`mcp-server`, so the browser only ever sees one origin) while deliberately leaving
the *production* topology exactly as unresolved as it already was — that fix was
scoped to development only and said so explicitly. This ADR is the decision that
closes the gap the interim fix left open on purpose.

## Decision drivers

| Driver | Source | Why it matters here |
|---|---|---|
| Same-origin cookies | ADR-003 — session cookie is the auth mechanism | Whatever serves the built console must share an origin with the API, or the cookie doesn't travel and every request 401s. |
| Zero existing deploy tooling | Current repo state — no Dockerfile, no CI/CD pipeline, no reverse proxy config anywhere in this repo | A solution that assumes a reverse proxy or a container-orchestration layer would be inventing infrastructure that doesn't exist, not resolving today's open question. |
| One process already running in production | `mcp-server` is the one long-running service this system has | Reusing it avoids standing up a second process just to serve static files. |
| Avoid fragile cross-file coupling | This session's own prior mistakes with implicit config coupling | A decision encoded as a one-line change in `frontend/vite.config.ts` that only makes sense in light of routing decided in a completely different file (`httpServer.ts`) is exactly the kind of thing that silently breaks when someone touches one file without knowing about the other. |
| Minimal, reversible step | This repo's own `CLAUDE.md`: "Small, reversible steps" | Whatever is chosen should be undoable without restructuring the rest of the system. |

## Options considered

| | **A: `mcp-server` serves `dist/` at `/console` + `/assets/*`** | **B: `mcp-server` serves it under a `base: '/console/'` prefix** | **C: A reverse proxy (nginx) in front of both** | **D: Leave it unresolved, dev-proxy only** |
|---|---|---|---|---|
| Same-origin cookies | ✅ Yes | ✅ Yes | ✅ Yes, if configured correctly | ❌ No — the exact gap this ADR exists to close |
| New infrastructure required | None — reuses `mcp-server` | None — reuses `mcp-server` | Yes — this repo has zero reverse-proxy config today | None, but resolves nothing |
| Cross-file coupling | Low — only `httpServer.ts` needs to know the route scheme | Higher — `frontend/vite.config.ts`'s `base` only makes sense in light of a routing choice made in `httpServer.ts`, a file `vite.config.ts` has no other reason to reference | Low, but couples deploy topology to a new config surface (nginx) that doesn't exist yet | N/A |
| Matches Vite's own default build output | ✅ Yes — `dist/index.html` already emits root-relative `/assets/...` paths with no config change | ⚠️ Requires a config change and keeping it in sync with the serving path forever | Depends on proxy config | N/A |
| Scope vs. this task | Right-sized — closes exactly the gap identified | Over-engineered for a single-process deployment | Real net-new production infrastructure — a bigger decision than "where does one already-built app get served from" | Doesn't close the gap at all |

Option C was rejected specifically because it would introduce production
infrastructure (a reverse proxy) that doesn't exist anywhere in this repo today —
that's a legitimately bigger decision than the one this ADR is scoped to, not a
free upgrade. Option D was rejected because it's not a decision, it's declining to
make one, and the whole point of this ADR is to stop declining.

## Decision

**Serve the built React app from `mcp-server` itself: the page shell at
`GET /console`, the compiled JS/CSS at Vite's own default root-relative
`/assets/*`, with no `base` override added to `frontend/vite.config.ts`.**

Concretely:

- New module `mcp-server/src/staticFiles.ts` — `resolveStaticFilePath(rootDir,
  requestedPath)` resolves both paths to absolute, normalized form and requires
  the candidate to be `=== root` or `startsWith(root + sep)` — not a bare
  `startsWith(root)`, which is the classic traversal-guard bug that would wrongly
  accept a sibling directory like `/tmp/dist-evil` against root `/tmp/dist` —
  before ever touching the filesystem; confirms `.isFile()`; returns `null` for
  anything unsafe or missing rather than throwing. `mimeTypeFor(filePath)` is a
  small fixed extension→MIME map with a safe default.
- `httpServer.ts`: `GET /console` checks `existsSync(frontend/dist/index.html)`
  **per request**, not cached at module load like `dashboardHtml`/`loginHtml` —
  those are committed source guaranteed to exist, while `dist/` only exists if and
  after a separate build ran, and its absence must never crash the server or break
  `/`, `/login`, `/health`, or the API. Missing returns `503 CONSOLE_NOT_BUILT`
  (not `404` — the route genuinely exists and will work once built), present
  reads and serves it fresh each time, tolerating a build happening after the
  server already started. `GET /assets/*` resolves through
  `resolveStaticFilePath()`/`mimeTypeFor()`. Neither route is gated by
  `requireSession()` — same reasoning as `GET /`: the shell and compiled JS/CSS
  embed no secrets, and `frontend/`'s `App.tsx` already has a tested
  `'unauthenticated'` state that only works if the shell loads *before* auth
  succeeds; gating it would break that already-built UX.
- One optional convenience script, `mcp-server/package.json`'s
  `"build-console": "npm run build --prefix ../frontend"` — never runs
  automatically, since no build/deploy automation exists in this repo yet and
  adding one is explicitly out of scope for this decision.

This choice was validated against Vite's actual output, not assumed from
documentation: `npm run build-console` was run for real, and the emitted
`dist/index.html` was inspected directly, confirming it already references
`/assets/<name>-<hash>.js` as a root-relative path with zero config changes
needed — the empirical check that made Option A viable without Option B's
coupling.

## Consequences

**What this requires, already built:**
- `mcp-server` must have `frontend/dist/` built and present before `/console`
  serves real content; absent, it fails clearly (`503`) rather than serving a
  broken page or crashing the rest of the server.
- One new import (`existsSync`) in `httpServer.ts`, alongside the existing
  `readFileSync`.

**What this explicitly does not cover (flagged, not silently skipped):**
- Any Docker/CI/deploy pipeline — this repo has none today; automating the build
  step is a separate, larger decision.
- A `/console/*` SPA-routing catch-all — `frontend/` does no client-side routing
  yet, so there is nothing to catch; a one-line follow-up if that changes.
- The pre-existing, unrelated gap where `mcp-server`'s own `tsc` build doesn't
  copy `.html` files into its `dist/` — real, confirmed during this work, but not
  caused by or fixed as part of this decision.
- Changes to `frontend/`'s own source code — this decision only changes where the
  already-built output is served from, not how it's built.

## What would change this decision

- **If `frontend/` needs to scale or deploy independently of `mcp-server`** (a
  separate release cadence, a CDN in front of static assets, a different team
  owning it) — same-origin-via-one-process stops being the right tradeoff, and
  Option C (a real reverse proxy) becomes the correct next step, at which point
  it's no longer "inventing infrastructure that doesn't exist" but genuinely
  warranted.
- **If `frontend/` grows client-side routing** — the current setup serves exactly
  `/console` and `/assets/*`; a `/console/*` catch-all serving `index.html` for
  any sub-route would need to be added, a small, additive change, not a reversal
  of this decision.
- **If this repo ever adds real deploy tooling** (Docker, CI) — the `build-console`
  script's manual-only nature would be revisited, but the underlying "one process
  serves both" choice would likely still hold unless the scaling driver above also
  applies.
