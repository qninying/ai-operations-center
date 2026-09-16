# STORY-012 (REQ-025): a reproducible, from-clean-checkout build for a real
# production deploy, with no dependency on anything already sitting on a
# developer's machine, and no compiled-dist step. This repo's every documented run path
# (`npm run http`, README's "See it running") executes TypeScript directly via
# `tsx`, not the `tsc`-compiled `dist/` output. httpServer.ts's frontend-serving
# path (`frontendDistDir = join(__dirname, "..", "..", "frontend", "dist")`)
# assumes it is running from `mcp-server/src`, one level below the repo root's
# `mcp-server/` directory. A compiled build under `mcp-server/dist/mcp-server/src`
# sits one directory deeper and would resolve that path wrong. Rather than touch
# already-tested source to fix a path assumption nothing has hit yet, this image
# runs the exact same `tsx src/httpServer.ts` command the test suite and every
# developer already runs, preserving the same relative directory layout
# (`mcp-server/`, `guardrails/`, `frontend/dist`) the source assumes.

# ---- frontend build -------------------------------------------------------
FROM node:22-alpine AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- mcp-server dependencies -----------------------------------------------
FROM node:22-alpine AS mcp-deps
WORKDIR /build/mcp-server
COPY mcp-server/package.json mcp-server/package-lock.json ./
# Full install, devDependencies included: tsx and typescript run at container
# start (see the note above), they are not build-time-only tools here.
RUN npm ci

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
RUN apk add --no-cache dumb-init
WORKDIR /app

# guardrails/ has zero runtime npm dependencies (see guardrails/package.json):
# source only, no install step needed.
COPY guardrails/*.ts ./guardrails/

COPY mcp-server/package.json mcp-server/package-lock.json ./mcp-server/
COPY --from=mcp-deps /build/mcp-server/node_modules ./mcp-server/node_modules
COPY mcp-server/src ./mcp-server/src
COPY mcp-server/tsconfig.json ./mcp-server/

COPY --from=frontend-build /build/frontend/dist ./frontend/dist

# ADR-005: the persisted, rotating audit-trail JSONL lives here at runtime
# (mcp-server/src/httpServer.ts's AuditLog persistTo path), not committed
# source (see .gitignore). Mount a persistent volume at this path in production
# (see fly.toml) or every deploy silently starts a fresh audit trail.
RUN mkdir -p /app/mcp-server/data

WORKDIR /app/mcp-server
ENV NODE_ENV=production
EXPOSE 8787

# Liveness only, matching GET /health exactly (see httpServer.ts's comment on
# why that route stays dependency-free). Readiness (GET /health/dependencies)
# is for a human or an incident drill to query, not for a container orchestrator
# to gate restarts on, since SQL Server being in fallback is this app's own
# honest degraded-but-serving state, not a reason to kill the container.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb-init: Node isn't PID 1-safe on its own (it ignores SIGTERM by default in
# that role), so without this, `fly deploy`/`docker stop` would wait out the
# full grace period and force-kill the container on every deploy instead of
# letting httpServer.ts shut down promptly.
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "http"]
