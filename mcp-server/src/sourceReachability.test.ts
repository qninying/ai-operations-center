import { describe, it, expect, beforeEach } from "vitest";
import { recordSourceCheck, getSourceChecks, __resetSourceReachabilityForTests } from "./sourceReachability.js";

const at = () => Date.parse("2026-10-05T12:00:00.000Z");

describe("sourceReachability", () => {
  beforeEach(() => __resetSourceReachabilityForTests());

  it("happy path: records the latest real outcome per source", () => {
    recordSourceCheck("postgres", "success", {}, at);
    recordSourceCheck("sql", "success", { sourceMode: "live" }, at);
    const checks = getSourceChecks();
    expect(checks.postgres).toEqual({ outcome: "success", at: "2026-10-05T12:00:00.000Z" });
    expect(checks.sql).toEqual({ outcome: "success", at: "2026-10-05T12:00:00.000Z", sourceMode: "live" });
  });

  it("failure path: keeps the error class, never a message that could leak detail", () => {
    recordSourceCheck("superset", "failure", { errorClass: "CircuitOpenError" }, at);
    expect(getSourceChecks().superset).toEqual({
      outcome: "failure",
      at: "2026-10-05T12:00:00.000Z",
      errorClass: "CircuitOpenError",
    });
  });

  it("boundary: every source is present, null until a real check happens", () => {
    const checks = getSourceChecks();
    expect(Object.keys(checks).sort()).toEqual(["cloud", "flyMachinesApi", "ntfy", "postgres", "sql", "ssrs", "superset"]);
    expect(Object.values(checks).every((v) => v === null)).toBe(true);
  });

  it("a newer check replaces the older one rather than accumulating", () => {
    recordSourceCheck("postgres", "failure", { errorClass: "UpstreamCallFailedError" }, at);
    recordSourceCheck("postgres", "success", {}, () => at() + 3000);
    expect(getSourceChecks().postgres).toEqual({ outcome: "success", at: "2026-10-05T12:00:03.000Z" });
  });
});
