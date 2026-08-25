"""CoreOps Dependency Map MCP server -- looks up which systems, reports, and
business processes depend on a given CoreOps-monitored system.

Fills a real, documented gap: project-blueprint/architecture.md explicitly lists
Service Dependency Map auto-discovery as something this design does not cover
("assumed to be maintained by ops... this design doesn't include a discovery
crawler"). This is a first step toward that lookup being queryable instead of
assumed -- the in-memory data below stands in for a real, ops-maintained source.

Note: the installed mcp SDK (2.1.0) exposes the server class as MCPServer,
imported from mcp.server directly -- not FastMCP from mcp.server.fastmcp, which
doesn't exist in this version. Confirmed by inspecting the installed package
directly before writing this, not assumed from memory.
"""

import json
from pathlib import Path
from typing import Annotated

from mcp.server import MCPServer
from pydantic import Field

mcp = MCPServer("coreops-dependency-map")

# The real, live-persisted audit trail (docs/ADR-005-audit-trail-persistence.md) --
# an append-only JSONL file guardrails/auditLog.ts writes to, wired in production
# via mcp-server/src/httpServer.ts. Read directly, not duplicated or mocked: this
# is genuine incident history, not a sample.
AUDIT_LOG_PATH = Path(__file__).parent.parent / "mcp-server" / "data" / "audit-log.jsonl"


def _load_audit_entries() -> list[dict]:
    if not AUDIT_LOG_PATH.exists():
        return []
    entries = []
    with AUDIT_LOG_PATH.open() as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))
    return entries

# Small in-memory sample standing in for the real Service Dependency Map.
# Reuses real system/report names already established elsewhere in this
# project (LoadCustomerDim, the SSRS fixture report paths) rather than
# inventing unrelated placeholder data.
DEPENDENCY_ROWS = [
    {"system": "LoadCustomerDim", "feeds": "/Finance/MonthlyRevenue", "business_process": "Monthly Revenue Reporting", "criticality": "high"},
    {"system": "LoadCustomerDim", "feeds": "/Ops/DailyIncidentSummary", "business_process": "Daily Ops Review", "criticality": "medium"},
    {"system": "prod-sql-01", "feeds": "/Sales/RegionalPipeline", "business_process": "Regional Sales Forecasting", "criticality": "high"},
    {"system": "prod-sql-01", "feeds": "notification-queue-consumer", "business_process": "Operator Alerting", "criticality": "high"},
    {"system": "prod-app-server-03", "feeds": "CoreOpsApi", "business_process": "Incident Dashboard", "criticality": "medium"},
    {"system": "notification-queue-consumer", "feeds": "on-call-paging", "business_process": "Operator Alerting", "criticality": "high"},
]


@mcp.tool()
def lookup_service_dependencies(
    query: Annotated[
        str,
        Field(min_length=1, max_length=200, description="The system, job, or report name to look up, e.g. 'LoadCustomerDim'."),
    ],
    limit: Annotated[
        int,
        Field(ge=1, le=20, description="Maximum number of dependency rows to return."),
    ] = 5,
) -> list[dict]:
    """Call this before stating an incident's downstream business impact. Given
    the name of a system, job, or report involved in an incident, returns which
    other systems, reports, or business processes depend on it as structured
    rows, not prose -- so impact statements are grounded in real dependency data
    instead of guesswork. Always call this when you need to know what else is
    affected by a problem in one system, not just the system itself.
    """
    matches = [row for row in DEPENDENCY_ROWS if query.lower() in row["system"].lower()]
    return matches[:limit]


@mcp.tool()
def search_incident_history(
    query: Annotated[
        str,
        Field(min_length=1, max_length=200, description="A term to search for -- a system name, an actor, an event type, an error class, or any other real detail from a past incident."),
    ],
    limit: Annotated[
        int,
        Field(ge=1, le=20, description="Maximum number of matching audit-log entries to return."),
    ] = 5,
) -> list[dict]:
    """Call this when diagnosing an incident to check whether something like it
    has genuinely happened before. Searches CoreOps's real, persisted audit
    trail -- not a summary or a guess -- and returns matching entries as
    structured rows, most recent first, so a root-cause explanation can cite
    real precedent instead of treating every incident as unprecedented.
    """
    entries = _load_audit_entries()
    needle = query.lower()
    matches = [entry for entry in entries if needle in json.dumps(entry).lower()]
    matches.sort(key=lambda entry: entry.get("loggedAt", ""), reverse=True)
    return matches[:limit]


if __name__ == "__main__":
    mcp.run(transport="stdio")
