#!/usr/bin/env node
// Minimal process supervisor for CoreOps demos. The HTTP server can't
// reliably relaunch itself after calling process.exit() (see
// POST /api/demo/restart-server in src/httpServer.ts) — this watches the
// child and relaunches it, so the "Restart server (demo)" dashboard button
// produces a real restart-and-recover, not a dead process. Restarts are
// capped so a genuine crash loop fails loud instead of looping forever.
import { spawn } from "node:child_process";

const DEFAULT_MAX_RESTARTS = 10;
const DEFAULT_RESTART_DELAY_MS = 500;

// spawnFn is injectable so demoSupervisor.test.ts can exercise the
// respawn/cap logic without spawning a real child process.
export function createSupervisor({
  spawnFn,
  command,
  args,
  maxRestarts = DEFAULT_MAX_RESTARTS,
  restartDelayMs = DEFAULT_RESTART_DELAY_MS,
  onChildSpawned,
  onRestart,
  onGiveUp,
}) {
  let restartCount = 0;
  let stopped = false;
  let child = null;

  function launch() {
    if (stopped) return;
    child = spawnFn(command, args, { stdio: "inherit" });
    onChildSpawned?.(child);
    child.on("exit", (code, signal) => {
      if (stopped) return;
      if (restartCount >= maxRestarts) {
        onGiveUp?.({ restartCount, code, signal });
        return;
      }
      restartCount += 1;
      onRestart?.({ restartCount, code, signal });
      setTimeout(launch, restartDelayMs);
    });
  }

  launch();

  return {
    stop() {
      stopped = true;
      child?.kill("SIGTERM");
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const supervisor = createSupervisor({
    spawnFn: spawn,
    command: "npm",
    args: ["run", "http"],
    onRestart: ({ restartCount, code, signal }) => {
      console.error(
        `coreops-demo-supervisor: child exited (code=${code}, signal=${signal}) — restarting (${restartCount}/${DEFAULT_MAX_RESTARTS})`
      );
    },
    onGiveUp: ({ restartCount, code, signal }) => {
      console.error(
        `coreops-demo-supervisor: child exited (code=${code}, signal=${signal}) and hit the ${restartCount}-restart cap — giving up, not looping forever.`
      );
      process.exit(1);
    },
  });

  process.on("SIGINT", () => {
    supervisor.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    supervisor.stop();
    process.exit(0);
  });
}
