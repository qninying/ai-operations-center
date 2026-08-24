import { useEffect, useState } from 'react'
import './App.css'

// STORY-005 / REQ-006 + REQ-009: role-based dashboard views. Fetches from
// mcp-server's real /api/dashboard/summary route (see dashboardSummary.ts for the
// actual logic, and httpServer.ts for the route itself) — this component is
// presentation only, same philosophy as the existing dashboard.html.
//
// Only "it-manager" is a real, rendered view — matches this story's own acceptance
// criteria, which are IT-Manager-only. Any other role, including "dba", surfaces the
// backend's own UNKNOWN_ROLE error honestly rather than a fabricated view.

interface ItManagerSummary {
  role: 'it-manager'
  incidentCount: number
  blockedSessionCount: number
  dataSource: 'live' | 'fallback'
  message?: string
}

interface ApiErrorBody {
  error: string
  message: string
}

type FetchState =
  | { status: 'loading' }
  | { status: 'success'; summary: ItManagerSummary }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }

function getRoleFromUrl(): string {
  return new URLSearchParams(window.location.search).get('role') ?? ''
}

// Covers both named failure paths from the backend boundary: "Dashboard not
// loading" (the fetch itself fails — network error, backend down) and "Incorrect
// role information" (the backend responds but rejects the role, e.g. 400
// UNKNOWN_ROLE). Both end up in the same error state, with the real message
// surfaced, not a generic "something went wrong."
function useDashboardSummary(role: string): FetchState {
  const [state, setState] = useState<FetchState>({ status: 'loading' })

  useEffect(() => {
    if (!role) {
      setState({ status: 'error', message: 'No role specified.' })
      return
    }

    let cancelled = false
    setState({ status: 'loading' })

    fetch(`/api/dashboard/summary?role=${encodeURIComponent(role)}`)
      .then(async (res) => {
        // Session-based auth landed on the backend after this component was
        // built — every /api/* route now requires a signed-in session. A 401 is
        // a distinct, expected state (not signed in yet), not a generic failure:
        // it needs a way to actually sign in, not just an error message.
        if (res.status === 401) {
          if (!cancelled) setState({ status: 'unauthenticated' })
          return
        }
        const body = (await res.json()) as ItManagerSummary | ApiErrorBody
        if (!res.ok) {
          throw new Error((body as ApiErrorBody).message ?? 'Unknown error')
        }
        if (!cancelled) setState({ status: 'success', summary: body as ItManagerSummary })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Could not load the dashboard.',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [role])

  return state
}

function ItManagerDashboard({ summary }: { summary: ItManagerSummary }) {
  return (
    <div className="oc-page" data-testid="it-manager-dashboard">
      <header className="oc-header">
        <span className="oc-brand">CoreOps</span>
        <span className="oc-header-role">IT Manager</span>
      </header>
      <main className="dashboard">
        <h1>Operational Summary</h1>
        <div className="summary-grid">
          <div className="summary-card">
            <span className="summary-value">{summary.incidentCount}</span>
            <span className="summary-label">Active Incidents</span>
          </div>
          <div className="summary-card">
            <span className="summary-value">{summary.blockedSessionCount}</span>
            <span className="summary-label">Blocked Sessions</span>
          </div>
        </div>
        <div className={`status-badge status-badge-${summary.dataSource}`}>
          <span className="status-dot" />
          {summary.dataSource === 'live'
            ? 'Live SQL Server'
            : 'Fixture fallback (no live SQL Server connected)'}
        </div>
        {summary.message && <p className="summary-message">{summary.message}</p>}
      </main>
    </div>
  )
}

export default function App() {
  const role = getRoleFromUrl()
  const state = useDashboardSummary(role)

  if (state.status === 'loading') {
    return <div data-testid="dashboard-loading">Loading dashboard…</div>
  }

  if (state.status === 'unauthenticated') {
    return (
      <div className="dashboard-error" data-testid="dashboard-unauthenticated">
        <h1>Sign in required</h1>
        <p>
          <a href="/login">Sign in</a> to view the dashboard.
        </p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="dashboard-error" data-testid="dashboard-error">
        <h1>Couldn't load the dashboard</h1>
        <p>{state.message}</p>
      </div>
    )
  }

  return <ItManagerDashboard summary={state.summary} />
}
