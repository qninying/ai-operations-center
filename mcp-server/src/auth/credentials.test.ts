import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./credentials.js";

describe("hashPassword / verifyPassword", () => {
  it("happy path: the correct password verifies against its own hash", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("failure path: a wrong password does not verify", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", hash)).toBe(false);
  });

  it("boundary: two hashes of the same password use different salts, both still verify", () => {
    const hashA = hashPassword("same password");
    const hashB = hashPassword("same password");

    expect(hashA).not.toBe(hashB);
    expect(verifyPassword("same password", hashA)).toBe(true);
    expect(verifyPassword("same password", hashB)).toBe(true);
  });

  it("boundary: a malformed stored hash is rejected, not thrown", () => {
    expect(verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "onlyonepart")).toBe(false);
    expect(verifyPassword("anything", "not-hex:also-not-hex")).toBe(false);
    expect(verifyPassword("anything", "aa:bb")).toBe(false); // wrong length hash
  });

  it("boundary: an empty password still hashes and verifies consistently", () => {
    const hash = hashPassword("");
    expect(verifyPassword("", hash)).toBe(true);
    expect(verifyPassword("not empty", hash)).toBe(false);
  });
});
