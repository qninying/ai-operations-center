import { describe, it, expect, beforeEach } from "vitest";
import {
  recordAnthropicCallOutcome,
  getLastAnthropicCallOutcome,
  __resetAnthropicReachabilityForTests,
} from "./anthropicReachability.js";

describe("anthropicReachability", () => {
  beforeEach(() => {
    __resetAnthropicReachabilityForTests();
  });

  it("starts null — no real call has happened yet this process", () => {
    expect(getLastAnthropicCallOutcome()).toBeNull();
  });

  it("records a successful call with a timestamp, no errorClass", () => {
    recordAnthropicCallOutcome("success", undefined, () => Date.parse("2026-10-04T12:00:00.000Z"));

    expect(getLastAnthropicCallOutcome()).toEqual({
      outcome: "success",
      at: "2026-10-04T12:00:00.000Z",
    });
  });

  it("records a failed call with its errorClass", () => {
    recordAnthropicCallOutcome("failure", "AuthenticationError", () => Date.parse("2026-10-04T12:00:00.000Z"));

    expect(getLastAnthropicCallOutcome()).toEqual({
      outcome: "failure",
      at: "2026-10-04T12:00:00.000Z",
      errorClass: "AuthenticationError",
    });
  });

  it("a later call overwrites the earlier one — only the most recent outcome is kept", () => {
    recordAnthropicCallOutcome("failure", "AuthenticationError", () => Date.parse("2026-10-04T12:00:00.000Z"));
    recordAnthropicCallOutcome("success", undefined, () => Date.parse("2026-10-04T12:05:00.000Z"));

    expect(getLastAnthropicCallOutcome()).toEqual({
      outcome: "success",
      at: "2026-10-04T12:05:00.000Z",
    });
  });
});
