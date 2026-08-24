import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveStaticFilePath, mimeTypeFor } from "./staticFiles.js";

describe("resolveStaticFilePath", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coreops-static-test-"));
    writeFileSync(join(root, "main-abc123.js"), "console.log('hi');");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("happy path: resolves a file that exists, with a leading slash", () => {
    expect(resolveStaticFilePath(root, "/main-abc123.js")).toBe(join(root, "main-abc123.js"));
  });

  it("happy path: resolves identically without a leading slash", () => {
    expect(resolveStaticFilePath(root, "main-abc123.js")).toBe(join(root, "main-abc123.js"));
  });

  it("failure path: a file that doesn't exist returns null, not a throw", () => {
    expect(resolveStaticFilePath(root, "/does-not-exist.js")).toBeNull();
  });

  it("failure path (traversal): a decoded '../' attempt is rejected", () => {
    expect(resolveStaticFilePath(root, "/../../../etc/passwd")).toBeNull();
  });

  it("boundary: requesting the root directory itself is rejected (a directory, not a file)", () => {
    expect(resolveStaticFilePath(root, "")).toBeNull();
    expect(resolveStaticFilePath(root, "/")).toBeNull();
  });

  it("boundary: a sub-directory is rejected, not treated as a file", () => {
    mkdirSync(join(root, "chunks"));
    writeFileSync(join(root, "chunks", "vendor-xyz.js"), "// chunk");
    expect(resolveStaticFilePath(root, "/chunks")).toBeNull();
    expect(resolveStaticFilePath(root, "/chunks/vendor-xyz.js")).toBe(join(root, "chunks", "vendor-xyz.js"));
  });

  it("boundary: a sibling directory that merely shares root's name as a string prefix is rejected", () => {
    // The classic bug this guards against: a bare `startsWith(root)` check would
    // wrongly accept "<root>-evil/file.js" since the string "<root>-evil" starts
    // with the string "<root>". startsWith(root + sep) does not have this bug.
    const evilSibling = `${root}-evil`;
    mkdirSync(evilSibling);
    writeFileSync(join(evilSibling, "file.js"), "// not actually inside root");

    const relativeIntoSibling = join("..", `${evilSibling.split("/").pop()}`, "file.js");
    expect(resolveStaticFilePath(root, relativeIntoSibling)).toBeNull();

    rmSync(evilSibling, { recursive: true, force: true });
  });
});

describe("mimeTypeFor", () => {
  it.each([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".png", "image/png"],
    [".json", "application/json; charset=utf-8"],
    [".ico", "image/x-icon"],
    [".woff2", "font/woff2"],
  ])("maps %s to %s", (ext, expected) => {
    expect(mimeTypeFor(`file${ext}`)).toBe(expected);
  });

  it("falls back to a safe binary default for an unrecognized extension", () => {
    expect(mimeTypeFor("file.xyz")).toBe("application/octet-stream");
  });

  it("falls back to the default for a file with no extension at all", () => {
    expect(mimeTypeFor("Makefile")).toBe("application/octet-stream");
  });
});
