import { describe, it, expect, afterEach, vi } from "vitest";
import { restartFlyMachine, FlyMachineRestartFailedError } from "./flyMachinesExecutor.js";
import { getSourceChecks, __resetSourceReachabilityForTests } from "./sourceReachability.js";

describe("restartFlyMachine", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("happy path: posts to the correct Fly Machines API URL with a bearer token", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

    await restartFlyMachine("dev-superset", "machine-abc", "fo1_secret-token");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.machines.dev/v1/apps/dev-superset/machines/machine-abc/restart",
      { method: "POST", headers: { Authorization: "Bearer fo1_secret-token" } }
    );
  });

  it("failure path: a non-ok HTTP response raises FlyMachineRestartFailedError", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" } as Response);

    await expect(restartFlyMachine("dev-superset", "machine-abc", "bad-token")).rejects.toThrow(
      FlyMachineRestartFailedError
    );
  });

  it("failure path: a network-level failure (fetch rejects) also raises FlyMachineRestartFailedError, not a raw TypeError", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(restartFlyMachine("dev-superset", "machine-abc", "token")).rejects.toThrow(
      FlyMachineRestartFailedError
    );
  });

  it("never includes the API token in the thrown error's message", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" } as Response);

    try {
      await restartFlyMachine("dev-superset", "machine-abc", "super-secret-token-value");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FlyMachineRestartFailedError);
      expect((error as Error).message).not.toContain("super-secret-token-value");
    }
  });
});

describe("restartFlyMachine: records the real outcome for live status", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    __resetSourceReachabilityForTests();
  });

  it("records success after a real 200 from Fly's API", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    await restartFlyMachine("dev-postgres", "m1", "tok");
    expect(getSourceChecks().flyMachinesApi?.outcome).toBe("success");
  });

  it("records failure (error class only) when Fly's API rejects the call", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response);
    await expect(restartFlyMachine("dev-postgres", "m1", "tok")).rejects.toThrow(FlyMachineRestartFailedError);
    expect(getSourceChecks().flyMachinesApi).toMatchObject({ outcome: "failure", errorClass: "UpstreamCallFailedError" });
  });
});
