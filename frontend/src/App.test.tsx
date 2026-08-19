import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import App from './App'

function setRole(role: string | null) {
  const search = role === null ? '' : `?role=${encodeURIComponent(role)}`
  window.history.pushState(null, '', `/${search}`)
}

describe('App (STORY-005 dashboard)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('REQ-006/009: an IT Manager sees role-specific operational summary information', async () => {
    setRole('it-manager')
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        role: 'it-manager',
        incidentCount: 3,
        blockedSessionCount: 1,
        dataSource: 'live',
      }),
    })

    render(<App />)

    await waitFor(() => screen.getByTestId('it-manager-dashboard'))
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText(/Live SQL Server/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/dashboard/summary?role=it-manager')
  })

  it('shows the fallback data source honestly, not disguised as live', async () => {
    setRole('it-manager')
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        role: 'it-manager',
        incidentCount: 0,
        blockedSessionCount: 0,
        dataSource: 'fallback',
        message: 'No active requests matched the filter.',
      }),
    })

    render(<App />)

    await waitFor(() => screen.getByTestId('it-manager-dashboard'))
    expect(screen.getByText(/Fixture fallback/)).toBeInTheDocument()
    expect(screen.getByText('No active requests matched the filter.')).toBeInTheDocument()
  })

  it('failure path — no role specified: shows a clear error without ever calling fetch', async () => {
    setRole(null)

    render(<App />)

    await waitFor(() => screen.getByTestId('dashboard-error'))
    expect(screen.getByText('No role specified.')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('failure path — incorrect role information: surfaces the backend\'s real UNKNOWN_ROLE message', async () => {
    setRole('dba')
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: 'UNKNOWN_ROLE',
        message: 'Unknown dashboard role "dba". Supported: it-manager.',
      }),
    })

    render(<App />)

    await waitFor(() => screen.getByTestId('dashboard-error'))
    expect(screen.getByText('Unknown dashboard role "dba". Supported: it-manager.')).toBeInTheDocument()
  })

  it('failure path — dashboard not loading: a network failure shows an error state, not a blank or crashed page', async () => {
    setRole('it-manager')
    ;(fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('Failed to fetch'))

    render(<App />)

    await waitFor(() => screen.getByTestId('dashboard-error'))
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument()
  })
})
