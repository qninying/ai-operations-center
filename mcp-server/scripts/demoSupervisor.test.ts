import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createSupervisor } from "./demoSupervisor.mjs";

function makeFakeChild() {
  const emitter = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  emitter.kill = vi.fn();
  return emitter;
}

describe("createSupervisor", () => {
  it("happy path: relaunches the child when it exits, up to the cap", async () => {
    const children: ReturnType<typeof makeFakeChild>[] = [];
    const spawnFn = vi.fn(() => {
      const child = makeFakeChild();
      children.push(child);
      return child;
    });
    const onRestart = vi.fn();

    createSupervisor({ spawnFn, command: "npm", args: ["run", "http"], restartDelayMs: 1, onRestart });

    expect(spawnFn).toHaveBeenCalledTimes(1);

    children[0].emit("exit", 1, null);
    await new Promise((r) => setTimeout(r, 10));

    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(onRestart).toHaveBeenCalledWith({ restartCount: 1, code: 1, signal: null });
  });

  it("failure path: stops respawning once maxRestarts is hit, and reports it instead of looping forever", async () => {
    const children: ReturnType<typeof makeFakeChild>[] = [];
    const spawnFn = vi.fn(() => {
      const child = makeFakeChild();
      children.push(child);
      return child;
    });
    const onGiveUp = vi.fn();

    createSupervisor({ spawnFn, command: "npm", args: ["run", "http"], maxRestarts: 2, restartDelayMs: 1, onGiveUp });

    for (let i = 0; i < 3; i++) {
      children[children.length - 1].emit("exit", 1, null);
      await new Promise((r) => setTimeout(r, 10));
    }

    // initial spawn + 2 allowed restarts = 3 total launches, no more after the cap
    expect(spawnFn).toHaveBeenCalledTimes(3);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledWith({ restartCount: 2, code: 1, signal: null });
  });

  it("stop() suppresses further respawns and kills the current child", () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child);
    const onRestart = vi.fn();

    const supervisor = createSupervisor({ spawnFn, command: "npm", args: ["run", "http"], restartDelayMs: 1, onRestart });
    supervisor.stop();
    child.emit("exit", 0, "SIGTERM");

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(onRestart).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
