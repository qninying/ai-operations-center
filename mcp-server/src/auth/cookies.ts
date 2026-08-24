// Hand-rolled — the one cookie this app sets doesn't warrant a `cookie` npm
// dependency. SameSite=Strict does the real CSRF-mitigation work here (modern
// browsers withhold Strict cookies on essentially all cross-site requests) without
// a separate CSRF token, which would be over-engineering for a single-operator
// system. Secure is gated by SESSION_COOKIE_SECURE (default off) so plain
// http://localhost:8787 keeps working with zero setup — this plain http.Server has
// no TLS awareness to infer Secure from automatically; turning it on for a real,
// non-localhost HTTPS deployment is a deliberate deploy-time choice.

export const SESSION_COOKIE_NAME = "coreops_session";

export function serializeSessionCookie(
  sessionId: string,
  options: { secure: boolean; maxAgeMs: number }
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(options.maxAgeMs / 1000)}`,
  ];
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function parseSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      return rest.join("=") || null;
    }
  }
  return null;
}
