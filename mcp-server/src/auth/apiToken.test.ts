import { describe, it, expect } from "vitest";
import { verifyBearerToken } from "./apiToken.js";

const TOKEN = "a-long-random-opaque-token-value";

describe("verifyBearerToken", () => {
  it("accepts the correct token with a Bearer prefix", () => {
    expect(verifyBearerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyBearerToken(undefined, TOKEN)).toBe(false);
  });

  it("rejects a header without the Bearer scheme", () => {
    expect(verifyBearerToken(TOKEN, TOKEN)).toBe(false);
  });

  it("rejects the wrong token", () => {
    expect(verifyBearerToken("Bearer wrong-token", TOKEN)).toBe(false);
  });

  it("rejects a token that is a prefix of the real one", () => {
    expect(verifyBearerToken(`Bearer ${TOKEN.slice(0, 10)}`, TOKEN)).toBe(false);
  });

  it("rejects an empty bearer value", () => {
    expect(verifyBearerToken("Bearer ", TOKEN)).toBe(false);
  });

  it("is case-sensitive on the token value", () => {
    expect(verifyBearerToken(`Bearer ${TOKEN.toUpperCase()}`, TOKEN)).toBe(false);
  });
});
