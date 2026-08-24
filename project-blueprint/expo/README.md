# Architect Expo package

Refreshed CoreOps architecture materials, built 2026-08-23/24 — supersedes the
numbered walkthrough one level up (`../01-idea.html` through `../07-not-covered.html`,
`../one-pager.pdf`), which describes an early walking skeleton (30/30 tests, no
guardrail approval flow, no session auth, no audit trail) rather than the system as
it actually stands now (210 tests, real human-approval gate, real session auth, a
correlation-ID audit trail).

## Files

- **`architecture-summary.html`** — the main page: what CoreOps is, the detection-to-decision
  flow, a real captured audit-trail example, the guardrail's governing principle, a
  layer-by-layer implementation table, an honest built/gap status table, and the stack.
  Published live at <https://claude.ai/code/artifact/5419b54e-1807-4174-b056-e5b88597c315>
- **`architecture-summary.pdf`** — the same content, print/download form.
- **`layer-diagram.html`** — the 7-layer reference architecture as a diagram, showing
  the governance gate between AI reasoning and production write-back, and the
  correlation ID threading through every layer.
  Published live at <https://claude.ai/code/artifact/b8bc3f71-e85e-4663-9df6-b0ad0d09058f>
- **`trust-boundaries.html`** — the real data-flow path left to right, with the four
  points where trust actually changes (identity, external services, rendering, the
  action gate) marked and explained.
  Published live at <https://claude.ai/code/artifact/f39fd0ed-49b5-466a-90d8-0edda0975ec8>
- **`7-layer-architecture-mapping.md`** — the full written version of the layer-table
  section in `architecture-summary.html`: each of the 7 layers with its components,
  interactions, responsibilities, and significance spelled out in prose, not just a
  table row. Not published as an Artifact — plain Markdown, meant to be read or
  submitted directly (e.g. as coursework).

## Updating

Each HTML file is self-contained (inline CSS/JS, Google Fonts for type — no other
external assets) and was built for Claude's Artifact publishing, not for `mcp-server`
or `frontend` to serve. To change one: edit the file here, then republish it to its
existing URL above (same file path from the session that published it, or pass the
URL explicitly from a new one) so the link stays the same rather than creating a
new artifact.

All three links are **private by default** — sharing them is a manual step from
each page's own share menu, not something set from this repo.
