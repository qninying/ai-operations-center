// Gates demo-only routes (e.g. POST /api/demo/restart-server) behind an env
// var that is only ever passed as a shell prefix on the demo launch command
// (see .claude/skills/demo-start/SKILL.md) — never written to .env, so the
// capability is structurally absent from any non-demo run.
export function isDemoModeEnabled(): boolean {
  return process.env.DEMO_MODE === "true";
}
