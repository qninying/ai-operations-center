# CoreOps — 90-Second Demo Script

A screencast script for the "Showcase & portfolio" deliverable. Every command below
was run against this repo's real code before being written into this script — nothing
here is staged or hypothetical. Do one dry run before recording; the very first `npx
tsx` invocation on a machine downloads `tsx` fresh (a few seconds), which you don't
want happening live on camera.

**Setup, before you hit record:**

```bash
cd ai-operations-center/mcp-server
npm install          # once, if not already done
npm run http &       # starts the HTTP wrapper on localhost:8787, leave it running
cd ..
```

Then open `http://localhost:8787/` in a browser and leave the tab ready — this is the
dashboard used for both Act 2 and Act 3.

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

**[Cut to end card / repo link]**

---

## Timing checklist

| Beat | Target | What's on screen |
|---|---|---|
| Problem | 0:00–0:20 | Title card or talking head |
| Tool call | 0:20–0:60 | Browser: `localhost:8787/` dashboard, incident cards |
| Guardrail block | 0:60–0:90 | Same tab: click the button, red BLOCKED panel appears |

One continuous browser tab for Acts 2 and 3 — no window-switching mid-recording.

## Terminal alternative

If you'd rather demo from the command line instead of the dashboard:

```bash
curl -s http://localhost:8787/dmv/exec-requests   # Act 2
npx tsx guardrails/demoUnsafeAction.ts              # Act 3
```

Same underlying code, same output — just less visual for a screencast.

**After recording:** stop the HTTP server (`pkill -f "tsx src/httpServer.ts"` or
Ctrl-C the terminal it's running in) — it's a local dev process, not meant to be left
running.
