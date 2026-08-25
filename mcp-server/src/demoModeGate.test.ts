import { describe, it, expect, afterEach } from "vitest";
import { isDemoModeEnabled } from "./demoModeGate.js";

describe("isDemoModeEnabled", () => {
  const original = process.env.DEMO_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = original;
  });

  it("happy path: returns true when DEMO_MODE is exactly 'true'", () => {
    process.env.DEMO_MODE = "true";
    expect(isDemoModeEnabled()).toBe(true);
  });

  it("failure path: returns false when DEMO_MODE is unset", () => {
    delete process.env.DEMO_MODE;
    expect(isDemoModeEnabled()).toBe(false);
  });

  it("failure path: returns false for any non-'true' value, not just falsy ones", () => {
    process.env.DEMO_MODE = "1";
    expect(isDemoModeEnabled()).toBe(false);
    process.env.DEMO_MODE = "TRUE";
    expect(isDemoModeEnabled()).toBe(false);
    process.env.DEMO_MODE = "false";
    expect(isDemoModeEnabled()).toBe(false);
  });
});
