import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDiagnosticLogFile } from "./diagnosticLogReader.js";

describe("readDiagnosticLogFile", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeFile(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "diag-log-test-"));
    createdDirs.push(dir);
    const path = join(dir, "sample.log");
    await writeFile(path, content);
    return path;
  }

  it("happy path: a small file returns every line, untruncated", async () => {
    const path = await makeFile("line one\nline two\nline three");

    const result = await readDiagnosticLogFile(path);

    expect(result.lines).toEqual(["line one", "line two", "line three"]);
    expect(result.totalLinesInFile).toBe(3);
    expect(result.truncatedBySize).toBe(false);
    expect(result.truncatedByLineCount).toBe(false);
  });

  it("boundary: an empty file returns zero lines, not one blank line", async () => {
    const path = await makeFile("");

    const result = await readDiagnosticLogFile(path);

    expect(result.lines).toEqual([]);
    expect(result.totalLinesInFile).toBe(0);
  });

  it("truncates by line count, keeping the most recent (tail) lines, not the earliest", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `entry ${i}`);
    const path = await makeFile(lines.join("\n"));

    const result = await readDiagnosticLogFile(path, { maxLines: 3 });

    expect(result.lines).toEqual(["entry 7", "entry 8", "entry 9"]);
    expect(result.truncatedByLineCount).toBe(true);
    expect(result.totalLinesInFile).toBe(10);
  });

  it("truncates by size, reading only the tail of a file larger than the byte cap, and reports totalLinesInFile as unknown", async () => {
    // "AAAA\n" repeated is easy to reason about: 5 bytes per line.
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`);
    const path = await makeFile(lines.join("\n"));

    // Cap small enough to force a partial read well past the start of the file.
    const result = await readDiagnosticLogFile(path, { maxLines: 1000, maxReadBytes: 40 });

    expect(result.truncatedBySize).toBe(true);
    expect(result.totalLinesInFile).toBeNull();
    // The tail of the file should be present; the very first line should not.
    expect(result.lines.join("\n")).toContain("line-099");
    expect(result.lines).not.toContain("line-000");
  });

  it("failure path: a nonexistent file rejects rather than returning an empty result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diag-log-test-"));
    createdDirs.push(dir);

    await expect(readDiagnosticLogFile(join(dir, "does-not-exist.log"))).rejects.toThrow();
  });
});
