# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue: open the repository's **Security** tab and choose **Report a vulnerability**. You should get a reply within 5 working days.

Include what you found, how to reproduce it, and the impact you expect.

## Scope

In scope: the code in this repository and the production deployment at `coreops.fly.dev` (report only; do not run load tests, scanners or attempts to access other users' data against it).

## How the project handles security

- Every production change requires a human approval from an MFA-verified session, and every decision is written to an append-only audit log.
- Secrets live in environment variables and deployment secrets, never in the repository. `mcp-server/.env.example` lists every setting; its only prefilled values are local-development defaults.
- Evidence passes through secret redaction before it is sent to the AI model or returned by the MCP gateway.
- The MCP gateway is read-only and requires a bearer token.
- Dependency updates for GitHub Actions arrive weekly through Dependabot.

Design records: [ADR-003](docs/ADR-003-session-based-authentication.md) (sessions), [ADR-006](docs/ADR-006-totp-mfa.md) (MFA), [ADR-014](docs/ADR-014-mcp-roots-containment-order.md) (MCP filesystem containment).
