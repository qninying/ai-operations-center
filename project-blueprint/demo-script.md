# CoreOps — Demo Script

A screencast script for the "Showcase & portfolio" deliverable. Every command below
was run against this repo's real code before being written into this script — nothing
here is staged or hypothetical. Do one dry run before recording; the very first `npx
tsx` invocation on a machine downloads `tsx` fresh (a few seconds), which you don't
want happening live on camera.

Two cuts: the original **90-second cut** (Acts 1-3) stands on its own. The **extended
cut** adds Acts 4-5, showing CoreOps's actual reporting-service integration and the
external-system verification behind it — genuinely useful, but there was no honest
way to also fit those into 90 seconds, so this is a longer video, not a faster one.

**Setup, before you hit record:**

```bash
cd ai-operations-center/mcp-server
npm install          # once, if not already done
npm run http &       # starts the HTTP wrapper on localhost:8787, leave it running
cd ..
```

Then open `http://localhost:8787/` in a browser and leave the tab ready — this is the
dashboard used for both Act 2 and Act 3.

**Additional setup, only if recording the extended cut (Acts 4-5):**

```bash
cd mcp-server/dev-superset
./setup.sh            # starts Superset + Postgres via Docker, initializes both,
                       # runs one real successful and one real failing query
cd ../..
```

Act 4 needs no Docker at all — it reads through the same real Azure SQL connection
the DMV path already uses. Act 5 is the one that needs this container up.

---

## Act 1 — The problem (0:00–0:20)

**[Talking head or title card, no screen yet]**

> "A SQL Server job fails at 2am. Nobody notices until an SSRS report comes back
> empty at 8am — six hours of silent failure. By the time someone's paged, they're
> manually cross-referencing job logs, blocking sessions, and downstream reports
> across a dozen different tools, trying to reconstruct what happened.
>
> CoreOps watches SQL Server, SSIS, SSRS, and Windows Server continuously, correlates
> failures automatically, and uses Claude to explain *why* something broke — using
> live evidence, not guesswork. But there's one rule that outranks everything else in
> this design: it can investigate and recommend all day long. It can never act
> without a human saying yes."

---

## Act 2 — The tool being called (0:20–0:60)

**[Screen: browser, `http://localhost:8787/`]**

> "Here's the read path live. This is a real MCP server, callable by Claude, reading
> SQL Server's Dynamic Management Views — and this dashboard is just a window onto
> the exact same tool."

**[Action: the dashboard is already open from setup — no navigation needed. Point at
the incident cards.]**

> "Session 61 is suspended, blocked by session 52, waiting on a lock, eight and a
> half seconds and counting. That's a real blocking-chain incident — structured data
> Claude can reason over, not a paragraph someone had to write by hand.
>
> Notice the source tag says `fallback` — there's no live SQL Server connected in
> this environment right now, so it's honestly telling you this is fixture data, not
> live production data. It never pretends. If the real connection were up, this same
> tag would say `live` — same shape, same contract, no code change required on the
> caller's side."

---

## Act 3 — The guardrail blocks an unsafe result (0:60–0:90)

**[Same browser tab, scroll to the "Proposed remediation" panel]**

> "Say Claude looks at that blocking chain and recommends restarting the service on
> `prod-app-server-03`. Reasonable fix. Cites its evidence. Right action type. Here's
> what happens next."

**[Action: click the "Recommend: restart_service on prod-app-server-03" button]**

**[Point at the panel that appears — specifically the red "BLOCKED" verdict and the
violation list]**

> "`NOT_HUMAN_APPROVED`. `PRODUCTION_WRITE_REQUIRES_APPROVAL`. The recommendation was
> good. The evidence was real. It still doesn't run — because nothing in this system
> can execute a change against production without a human clicking approve first.
> Not a content filter checking if the AI's idea is smart. A structural gate checking
> if a person signed off. That's CoreOps."

**[Cut to end card / repo link — or continue to Act 4 for the extended cut]**

---

## Act 4 — A real reporting service, connected (0:90–1:15, extended cut only)

**[Screen: terminal]**

> "CoreOps doesn't just watch SQL Server and Windows Servers — it watches SSRS too,
> the actual reporting layer. And here's the thing about SSRS: it logs every single
> report run straight into a SQL Server database, in a view called ExecutionLog3. So
> connecting to a reporting service didn't need a new integration — it needed the
> same real database connection this system already has, pointed at one more table."

**[Action: run the command below, let the output print]**

```bash
npx tsx mcp-server/src/demoSsrsExecutionLog.ts
```

> "Same honest pattern as before — live if the connection's up, `fallback` and clearly
> tagged as such if it's not, never silently one pretending to be the other. This is
> the actual reporting-service integration. What's coming up next is a different
> thing — proof that this whole pattern holds up against a real, running external
> system, not just a database mock."

---

## Act 5 — Proving the pattern against a real system (1:15–1:45, extended cut only)

**[Screen: terminal, Superset already running from setup]**

> "This is Apache Superset — not SSRS, and not something CoreOps ships. It's here to
> answer one honest question: does the live-query-then-fallback pattern this system
> is built on actually work against a real running service, or has it only ever been
> proven against mocks in a test file?"

**[Action: run the command below, from inside `mcp-server/dev-superset/`]**

```bash
cd mcp-server/dev-superset
npx tsx verify-live-pattern.ts
cd ../..
```

> "Real authentication against Superset's REST API. A real successful query and a
> real failed one, pulled from its actual execution history. Same live-tagged,
> fallback-tagged contract, proven against something genuinely running, not just
> mocked. This doesn't prove SSRS itself is correct — different system, different
> schema — but it proves the architecture this whole system leans on actually holds
> up outside a test file."

**[Cut to end card / repo link]**

---

## Timing checklist

| Beat | Target | What's on screen |
|---|---|---|
| Problem | 0:00–0:20 | Title card or talking head |
| Tool call | 0:20–0:60 | Browser: `localhost:8787/` dashboard, incident cards |
| Guardrail block | 0:60–0:90 | Same tab: click the button, red BLOCKED panel appears |
| *— 90-second cut ends here —* | | |
| Real reporting integration | 0:90–1:15 | Terminal: `demoSsrsExecutionLog.ts` output |
| Pattern verified live | 1:15–1:45 | Terminal: `verify-live-pattern.ts` output |

One continuous browser tab for Acts 2 and 3 — no window-switching mid-recording.
Acts 4-5 are terminal-only; a clean switch from browser to terminal between Act 3 and
Act 4 is fine, unlike mid-act switching.

## Terminal alternative

If you'd rather demo from the command line instead of the dashboard:

```bash
curl -s http://localhost:8787/dmv/exec-requests   # Act 2
npx tsx guardrails/demoUnsafeAction.ts              # Act 3
```

Same underlying code, same output — just less visual for a screencast.

**After recording:** stop the HTTP server (`pkill -f "tsx src/httpServer.ts"` or
Ctrl-C the terminal it's running in) — it's a local dev process, not meant to be left
running. If you recorded the extended cut, also tear down the Superset stack —
`docker compose down -v` from inside `mcp-server/dev-superset/` — same reasoning,
dev/verification tooling that isn't meant to run unattended.
