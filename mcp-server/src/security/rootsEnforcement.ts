import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Asks the connected client for its declared MCP roots (real filesystem
// locations it has said this server may touch), resolves the REAL path of the
// requested file (collapsing "../" traversal and dereferencing symlinks), and
// only then checks whether that real path falls inside one of the real root
// paths. The order is the whole control: resolve first, compare second.
//
// A plain string-prefix check on the *raw, unresolved* requested path is not
// enough on its own, and is deliberately not what this does, for two concrete
// bypasses it cannot see:
//   1. "../" traversal: the raw string "/allowed/root/../../etc/passwd" still
//      starts with "/allowed/root", so a prefix check on the raw string
//      passes — even though the real target is nowhere near that root. Only
//      resolving the path first (which collapses the ".." segments) reveals
//      where it actually points.
//   2. Symlinks: a symlink can sit physically inside an allowed root while
//      pointing at a file outside every root. The raw requested path never
//      mentions the symlink's real target at all, so a check on that raw
//      path can never catch it — only realpath(), which dereferences the
//      symlink, exposes the real destination to compare against the roots.
//
// Fails closed: a root that can't be resolved (doesn't exist on disk) denies
// everything under it rather than being silently skipped, and a requested
// path that can't be resolved at all (doesn't exist, broken symlink, no
// permission) is denied rather than assumed safe.
export class PathOutsideRootsError extends Error {
  readonly errorClass = "PathOutsideRootsError" as const;

  constructor(readonly requestedPath: string) {
    super(`Requested path is outside every declared root: ${requestedPath}`);
    this.name = "PathOutsideRootsError";
  }
}

export class NoRootsDeclaredError extends Error {
  readonly errorClass = "NoRootsDeclaredError" as const;

  constructor() {
    super("Client declared no roots — nothing is allowed until it does.");
    this.name = "NoRootsDeclaredError";
  }
}

async function resolveRootPaths(server: McpServer): Promise<string[]> {
  const { roots } = await server.server.listRoots();
  const resolved = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(fileURLToPath(root.uri));
      } catch {
        // A declared root that doesn't exist on disk can't safely be trusted
        // as a container for anything — drop it rather than let a typo'd or
        // stale root silently widen what's allowed.
        return null;
      }
    })
  );
  return resolved.filter((path): path is string => path !== null);
}

function isWithinRoot(realTarget: string, realRoot: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep);
}

// Returns the resolved real path on success. Throws PathOutsideRootsError (or
// NoRootsDeclaredError, itself a case of "outside every root" since there are
// none) on denial — callers translate that into a clean tool error result and
// a warning log, the same pattern already used for UnsupportedDmvError.
export async function resolveWithinRoots(server: McpServer, requestedPath: string): Promise<string> {
  const realRoots = await resolveRootPaths(server);
  if (realRoots.length === 0) {
    throw new NoRootsDeclaredError();
  }

  let realTarget: string;
  try {
    realTarget = await realpath(requestedPath);
  } catch {
    throw new PathOutsideRootsError(requestedPath);
  }

  const isAllowed = realRoots.some((root) => isWithinRoot(realTarget, root));
  if (!isAllowed) {
    throw new PathOutsideRootsError(requestedPath);
  }

  return realTarget;
}
