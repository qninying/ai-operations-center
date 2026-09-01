import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPackageRoot } from "./loadEnv.js";

describe("findPackageRoot", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "loadenv-test-"));
    createdDirs.push(dir);
    return dir;
  }

  it("happy path: finds package.json in the starting directory itself", () => {
    const root = makeTempRoot();
    writeFileSync(join(root, "package.json"), "{}");
    expect(findPackageRoot(root)).toBe(root);
  });

  it("happy path: finds package.json by walking up through nested directories, matching dist/'s extra mirrored depth", () => {
    const root = makeTempRoot();
    writeFileSync(join(root, "package.json"), "{}");
    const nested = join(root, "dist", "mcp-server", "src");
    mkdirSync(nested, { recursive: true });
    expect(findPackageRoot(nested)).toBe(root);
  });

  it("failure path: returns null when no package.json exists within the search depth", () => {
    const root = makeTempRoot();
    const deep = join(root, "a", "b", "c", "d", "e", "f", "g");
    mkdirSync(deep, { recursive: true });
    expect(findPackageRoot(deep)).toBeNull();
  });
});
