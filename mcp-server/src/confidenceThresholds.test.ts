import { describe, it, expect, afterEach } from "vitest";
import { readConfidenceThreshold, InvalidConfidenceThresholdError } from "./confidenceThresholds.js";

const ENV_VAR = "TEST_CONFIDENCE_THRESHOLD";

describe("readConfidenceThreshold — REQ-014", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("returns the default when the env var is unset", () => {
    expect(readConfidenceThreshold(ENV_VAR, 60)).toBe(60);
  });

  it("returns the default when the env var is set but empty", () => {
    process.env[ENV_VAR] = "";
    expect(readConfidenceThreshold(ENV_VAR, 60)).toBe(60);
  });

  it("returns the configured value when set to a valid number", () => {
    process.env[ENV_VAR] = "45";
    expect(readConfidenceThreshold(ENV_VAR, 60)).toBe(45);
  });

  it("accepts 0 and 100 as valid boundary values", () => {
    process.env[ENV_VAR] = "0";
    expect(readConfidenceThreshold(ENV_VAR, 60)).toBe(0);

    process.env[ENV_VAR] = "100";
    expect(readConfidenceThreshold(ENV_VAR, 60)).toBe(100);
  });

  it("failure path — non-numeric value: throws InvalidConfidenceThresholdError rather than silently returning NaN", () => {
    process.env[ENV_VAR] = "not-a-number";
    expect(() => readConfidenceThreshold(ENV_VAR, 60)).toThrow(InvalidConfidenceThresholdError);
  });

  it("failure path — out of range (below 0): throws rather than silently accepting an invalid threshold", () => {
    process.env[ENV_VAR] = "-5";
    expect(() => readConfidenceThreshold(ENV_VAR, 60)).toThrow(InvalidConfidenceThresholdError);
  });

  it("failure path — out of range (above 100): throws rather than silently accepting an invalid threshold", () => {
    process.env[ENV_VAR] = "150";
    expect(() => readConfidenceThreshold(ENV_VAR, 60)).toThrow(InvalidConfidenceThresholdError);
  });

  it("the thrown error names the offending env var and raw value for a fast fix", () => {
    process.env[ENV_VAR] = "banana";
    try {
      readConfidenceThreshold(ENV_VAR, 60);
      throw new Error("expected readConfidenceThreshold to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConfidenceThresholdError);
      expect((error as InvalidConfidenceThresholdError).envVarName).toBe(ENV_VAR);
      expect((error as InvalidConfidenceThresholdError).rawValue).toBe("banana");
    }
  });
});
