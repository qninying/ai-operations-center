import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveWithinRoots, PathOutsideRootsError, NoRootsDeclaredError } from "./rootsEnforcement.js";

function makeFakeServer(rootPaths: string[]): McpServer {
  return {
    server: {
      listRoots: async () => ({
        roots: rootPaths.map((p) => ({ uri: pathToFileURL(p).toString() })),
      }),
    },
  } as unknown as McpServer;
}

describe("resolveWithinRoots", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "roots-test-"));
    createdDirs.push(dir);
    // macOS symlinks /tmp -> /private/tmp (and /var -> /private/var, wherever
    // os.tmpdir() resolves to on a given machine), so realpath() on anything
    // built from this dir won't equal the raw mkdtemp() string. Resolving it
    // here once keeps every path built from `root` consistent with what
    // resolveWithinRoots() itself will resolve to.
    return await realpath(dir);
  }

  it("happy path: a real file genuinely inside a declared root resolves", async () => {
    const root = await makeRoot();
    const file = join(root, "report.csv");
    await writeFile(file, "data");
    const server = makeFakeServer([root]);

    const resolved = await resolveWithinRoots(server, file);
    expect(resolved).toBe(file);
  });

  it("happy path: the root directory itself resolves (not just files under it)", async () => {
    const root = await makeRoot();
    const server = makeFakeServer([root]);

    const resolved = await resolveWithinRoots(server, root);
    expect(resolved).toBe(root);
  });

  it("attack: dot-dot traversal out of the declared root is denied, even though the raw string starts with the root's prefix", async () => {
    const root = await makeRoot();
    // A sibling directory the root's own prefix string would still "match"
    // under a naive prefix check, since the raw path literally begins with
    // `${root}/../` — but real path resolution collapses it to a location
    // outside root entirely.
    const outsideFile = join(root, "..", "outside-secret.txt");
    await writeFile(outsideFile, "should never be reachable");
    const traversalPath = join(root, "..", "outside-secret.txt");
    const server = makeFakeServer([root]);

    await expect(resolveWithinRoots(server, traversalPath)).rejects.toThrow(PathOutsideRootsError);
    await rm(outsideFile, { force: true });
  });

  it("attack: a symlink physically inside the root but pointing outside it is denied", async () => {
    const root = await makeRoot();
    const outsideDir = await makeRoot(); // a second, unrelated temp dir — never declared as a root
    const secretFile = join(outsideDir, "secret.txt");
    await writeFile(secretFile, "outside data");
    const linkInsideRoot = join(root, "innocent-looking-link.txt");
    await symlink(secretFile, linkInsideRoot);
    const server = makeFakeServer([root]);

    // The symlink's own path is genuinely inside root — a raw-path check
    // would allow it. Only dereferencing it (realpath) reveals the real
    // target lives outside every declared root.
    await expect(resolveWithinRoots(server, linkInsideRoot)).rejects.toThrow(PathOutsideRootsError);
  });

  it("failure path: no roots declared at all denies everything", async () => {
    const root = await makeRoot();
    const file = join(root, "x.txt");
    await writeFile(file, "data");
    const server = makeFakeServer([]);

    await expect(resolveWithinRoots(server, file)).rejects.toThrow(NoRootsDeclaredError);
  });

  it("failure path: a nonexistent requested path is denied, not assumed safe", async () => {
    const root = await makeRoot();
    const server = makeFakeServer([root]);

    await expect(resolveWithinRoots(server, join(root, "does-not-exist.txt"))).rejects.toThrow(
      PathOutsideRootsError
    );
  });

  it("failure path: a declared root that doesn't exist on disk is dropped, not trusted", async () => {
    const root = await makeRoot();
    const file = join(root, "x.txt");
    await writeFile(file, "data");
    const server = makeFakeServer(["/this/root/does/not/exist/anywhere"]);

    await expect(resolveWithinRoots(server, file)).rejects.toThrow(NoRootsDeclaredError);
  });

  it("boundary: a sibling directory that merely shares a name prefix with the root is still denied", async () => {
    const root = await makeRoot();
    // e.g. root = /tmp/roots-test-abc, sibling = /tmp/roots-test-abcdef —
    // a naive `startsWith(root)` string check (no separator) would wrongly
    // allow this; the real containment check requires the separator boundary.
    const sibling = `${root}xyz`;
    await mkdir(sibling);
    createdDirs.push(sibling);
    const file = join(sibling, "x.txt");
    await writeFile(file, "data");
    const server = makeFakeServer([root]);

    await expect(resolveWithinRoots(server, file)).rejects.toThrow(PathOutsideRootsError);
  });
});
