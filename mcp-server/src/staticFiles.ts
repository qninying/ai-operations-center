import { existsSync, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";

// Pure path-resolution logic for serving the built frontend/dist/ output — kept
// separate from httpServer.ts's route handlers (which do the actual readFileSync),
// same "thin route, tested logic elsewhere" split as every other service in this
// file. Never throws: an unsafe or missing path is a normal, expected outcome, not
// an exceptional one.

// Resolves a requested URL path against rootDir, returning the safe absolute file
// path — or null if the resolved path would escape rootDir (path traversal), doesn't
// exist, or isn't a regular file. Real containment check, not a naive string
// prefix: startsWith(root + sep), not startsWith(root), since a bare prefix check
// would wrongly accept a sibling directory like "/tmp/dist-evil" against root
// "/tmp/dist".
export function resolveStaticFilePath(rootDir: string, requestedPath: string): string | null {
  const root = resolve(rootDir);
  // requestedPath arrives as e.g. "/main-abc123.js" (a leading slash, from
  // url.pathname). Strip it so `resolve` treats it as relative to root — resolve
  // treats a leading-slash argument as its own absolute path, discarding root
  // entirely, which is not what we want here.
  const relative = requestedPath.replace(/^\/+/, "");
  const candidate = resolve(root, relative);

  const withinRoot = candidate === root || candidate.startsWith(root + sep);
  if (!withinRoot) {
    return null;
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    return null;
  }
  return candidate;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const DEFAULT_MIME_TYPE = "application/octet-stream";

// Unknown extensions get a safe binary default, never a guess.
export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? DEFAULT_MIME_TYPE;
}
