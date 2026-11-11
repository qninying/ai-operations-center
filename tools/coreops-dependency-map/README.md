# coreops-dependency-map

A small Python MCP server with 2 tools: `lookup_service_dependencies` (which services depend on which) and `search_incident_history` (searches the persisted CoreOps audit trail in `mcp-server/data/`). It was the project's first MCP server, built before the main TypeScript server in [`mcp-server/`](../../mcp-server/).

Run it with [uv](https://docs.astral.sh/uv/) from this folder:

```bash
uv run server.py
```

It is not part of the production deployment (excluded from the Docker build context).
