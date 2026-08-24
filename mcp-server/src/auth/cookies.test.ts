import { describe, it, expect } from "vitest";
import { serializeSessionCookie, clearSessionCookie, parseSessionCookie } from "./cookies.js";

describe("serializeSessionCookie", () => {
  it("happy path: builds an HttpOnly, SameSite=Strict cookie with the given id and max-age", () => {
    const cookie = serializeSessionCookie("abc123", { secure: false, maxAgeMs: 60_000 });
    expect(cookie).toBe("coreops_session=abc123; Path=/; HttpOnly; SameSite=Strict; Max-Age=60");
  });

  it("appends Secure only when requested", () => {
    const secure = serializeSessionCookie("abc123", { secure: true, maxAgeMs: 60_000 });
    expect(secure).toContain("; Secure");
    const insecure = serializeSessionCookie("abc123", { secure: false, maxAgeMs: 60_000 });
    expect(insecure).not.toContain("Secure");
  });
});

describe("clearSessionCookie", () => {
  it("produces a Max-Age=0 cookie that clears the session id", () => {
    expect(clearSessionCookie(false)).toBe("coreops_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  });
});

describe("parseSessionCookie", () => {
  it("happy path: extracts the session id from a well-formed Cookie header", () => {
    expect(parseSessionCookie("coreops_session=abc123")).toBe("abc123");
  });

  it("failure path: a missing header returns null", () => {
    expect(parseSessionCookie(undefined)).toBeNull();
  });

  it("failure path: a header with no matching cookie name returns null", () => {
    expect(parseSessionCookie("other_cookie=xyz")).toBeNull();
  });

  it("boundary: picks the target cookie out of a multi-cookie header", () => {
    expect(parseSessionCookie("theme=dark; coreops_session=abc123; other=1")).toBe("abc123");
  });

  it("boundary: an empty cookie value is treated as absent", () => {
    expect(parseSessionCookie("coreops_session=")).toBeNull();
  });
});
