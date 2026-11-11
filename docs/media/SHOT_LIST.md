# Demo GIF shot list

Target: `docs/media/demo.gif`, 30 to 45 seconds, about 1200 px wide, under 10 MB so GitHub renders it inline. Record locally (`npm run http` in `mcp-server/`) with a real incident, so the root cause and the fix are not staged.

**Before recording:** start the server and trigger an incident the Docker or Postgres execution path can actually fix (the `demo-docker-incident` or `demo-postgres-incident` Claude Code skills in `.claude/skills/` do this). Have the TOTP code ready (`npm run current-totp-code`). Close unrelated tabs and use the day theme for contrast.

| # | Shot | Seconds | What the viewer should notice |
|---|------|---------|-------------------------------|
| 1 | Login page: username, password, then the 6-digit TOTP code | 4 | Every session is MFA-verified |
| 2 | Dashboard with the incident card highlighted | 4 | A live incident from a real data source, tagged `live` |
| 3 | Click **Troubleshoot**: Claude's root cause, confidence score and cited evidence | 8 | Evidence-backed diagnosis, not a guess |
| 4 | Click **Fix**: the proposed remediation with its guardrail checks | 6 | The AI proposes; nothing has run yet |
| 5 | **Approve** as the logged-in operator | 4 | Only a verified human can approve |
| 6 | Execution, then the health confirmation turning green | 6 | Fixed only once recovery is confirmed |
| 7 | **View audit trail**: every step for this incident under one correlation ID | 6 | Who approved what, and when, in one trace |
| 8 | (Optional) Terminal: `curl https://coreops.fly.dev/health/dependencies` | 4 | The same system runs in production |

**After recording:** save as `docs/media/demo.gif`, then in `README.md` replace the `TODO` comment in the Demo section with the image line it contains.
