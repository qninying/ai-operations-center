import { timingSafeEqual } from "node:crypto";

// Bearer-token verification for httpMcpServer.ts's network-facing MCP transport
// (ADR-001). MCP callers there are services/agents, not a browser — no login UI or
// cookie jar makes sense for a machine caller, so this is deliberately separate from
// sessionStore.ts/credentials.ts, which authenticate the one human operator.
//
// The SDK ships requireBearerAuth() for exactly this, but it's an Express
// RequestHandler built around an OAuth-shaped provider (server/auth/provider.js) —
// this repo has no Express dependency and a single static token needs none of OAuth's
// machinery, so this hand-rolls the one check actually needed, consistent with how
// credentials.ts/cookies.ts already avoid new dependencies for small auth primitives.

const BEARER_PREFIX = "Bearer ";

// Not hashed at rest, unlike AUTH_PASSWORD_HASH: this token is a long random opaque
// value (never a human-memorable password), so its entropy plus a constant-time
// comparison is the real defense — consistent with how every other operational
// secret in this repo's .env already lives in plaintext (SQLSERVER_PASSWORD,
// ANTHROPIC_API_KEY): the threat model is a network-reachable attacker, not someone
// who already has filesystem access to this gitignored file.
export function verifyBearerToken(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (!authorizationHeader || !authorizationHeader.startsWith(BEARER_PREFIX)) {
    return false;
  }
  const provided = authorizationHeader.slice(BEARER_PREFIX.length);

  const providedBuf = Buffer.from(provided, "utf-8");
  const expectedBuf = Buffer.from(expectedToken, "utf-8");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}
