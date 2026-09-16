import { describe, it, expect } from "vitest";
import { redactSecrets } from "./evidenceRedaction.js";

describe("redactSecrets", () => {
  it("leaves ordinary evidence text unchanged (happy path)", () => {
    const text = 'Session 61 blocked by session 52, wait_type: "LCK_M_X", wait_time_ms: 362000';
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts a connection-string password", () => {
    const text = "Connection failed: Server=prod-sql-01;User=svc_etl;Password=Tr0ub4dor&3;Database=Warehouse";
    const result = redactSecrets(text);
    expect(result).not.toContain("Tr0ub4dor&3");
    expect(result).toContain("Password=[REDACTED]");
    // Non-sensitive fields stay legible so the evidence is still diagnostically useful.
    expect(result).toContain("Server=prod-sql-01");
    expect(result).toContain("User=svc_etl");
  });

  it("redacts a Pwd= variant", () => {
    const result = redactSecrets("Pwd=hunter2;Server=x");
    expect(result).not.toContain("hunter2");
    expect(result).toContain("Pwd=[REDACTED]");
  });

  it("redacts basic auth embedded in a URL", () => {
    const result = redactSecrets("Failed to reach https://svc_etl:s3cr3tValue@internal.example.com/api");
    expect(result).not.toContain("s3cr3tValue");
    expect(result).toContain("https://svc_etl:[REDACTED]@internal.example.com/api");
  });

  it("redacts a generic api_key assignment", () => {
    const result = redactSecrets('config loaded: api_key="AbCdEf1234567890xyz"');
    expect(result).not.toContain("AbCdEf1234567890xyz");
    expect(result.toLowerCase()).toContain("api_key=[redacted]".toLowerCase());
  });

  it("redacts an AWS-style access key id", () => {
    const result = redactSecrets("credentials: AKIAABCDEFGHIJKLMNOP found in log");
    expect(result).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts a JWT-shaped token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = redactSecrets(`Authorization header: Bearer ${jwt}`);
    expect(result).not.toContain(jwt);
    expect(result).toContain("[REDACTED]");
  });

  it("handles an empty string (boundary case)", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("redacts every occurrence when a secret appears more than once", () => {
    const result = redactSecrets("Password=first;retrying with Password=first again");
    expect(result).not.toContain("first");
  });
});
