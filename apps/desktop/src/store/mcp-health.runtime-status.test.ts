import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  notify: vi.fn(),
  probe: vi.fn(),
  status: vi.fn()
}))

vi.mock('@/hermes', () => ({
  getHermesConfigRecord: mocks.config,
  setMcpServerEnabled: vi.fn(),
  testMcpServer: mocks.probe
}))
vi.mock('@/app/capabilities/connectors/data/rpc', () => ({ mcpServerStatus: mocks.status }))
vi.mock('@/i18n', () => ({ translateNow: (key: string) => key }))
vi.mock('@/store/notifications', () => ({ notify: mocks.notify, notifyError: vi.fn() }))
vi.mock('@/store/session', () => ({ $gatewayState: atom('open') }))
vi.mock('@/store/profile', () => ({
  $activeGatewayProfile: atom('default'),
  normalizeProfileKey: (name: null | string | undefined) => name?.trim() || 'default'
}))

import { probeCache } from '@/lib/mcp-probe-cache'
import { $activeGatewayProfile } from '@/store/profile'
import { $gatewayState } from '@/store/session'

import { startMcpHealthChecker, stopMcpHealthChecker } from './mcp-health'

const SERVERS = {
  cloudflare: { url: 'https://mcp.cloudflare.example/mcp' },
  github: { url: 'https://api.github.example/mcp' },
  linear: { url: 'https://mcp.linear.example/mcp' }
}

async function sweepOnce(): Promise<void> {
  startMcpHealthChecker()
  await vi.waitFor(() => expect(mocks.config).toHaveBeenCalled())
  await new Promise(resolve => setTimeout(resolve, 20))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.status.mockReset()
  $activeGatewayProfile.set('default')
  $gatewayState.set('open')
  localStorage.clear()
  probeCache.clear()
  mocks.config.mockResolvedValue({ mcp_servers: SERVERS })
  mocks.probe.mockResolvedValue({ ok: false, error: '401 Unauthorized', tools: [] })
})

afterEach(() => {
  stopMcpHealthChecker()
  vi.clearAllMocks()
})

describe('background MCP health sweep and the runtime status', () => {
  it('probes only servers without a live session and skips one that is connecting', async () => {
    mocks.status.mockResolvedValue({
      checked_at: 0,
      servers: [
        { connected: true, name: 'cloudflare', status: 'connected' },
        { connected: false, name: 'github', status: 'connecting' },
        { connected: false, name: 'linear', status: 'failed' }
      ]
    })

    await sweepOnce()

    expect(mocks.status).toHaveBeenCalledWith('default')
    expect(mocks.probe.mock.calls.map(([name]) => name)).toEqual(['linear'])
    // The probed server that failed auth still gets its nudge.
    expect(mocks.notify).toHaveBeenCalledTimes(1)
  })

  it('does not read runtime status after the gateway closed during config loading', async () => {
    let resolveConfig!: (value: Record<string, unknown>) => void
    mocks.config.mockReturnValueOnce(
      new Promise(resolve => {
        resolveConfig = resolve
      })
    )
    startMcpHealthChecker()
    $gatewayState.set('closed')
    resolveConfig({ mcp_servers: SERVERS })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mocks.status).not.toHaveBeenCalled()
    expect(mocks.probe).not.toHaveBeenCalled()
  })

  it('discards a pending runtime snapshot after the checker stops', async () => {
    let resolveStatus!: (value: { servers: unknown[] }) => void
    mocks.status.mockReturnValueOnce(
      new Promise(resolve => {
        resolveStatus = resolve
      })
    )
    startMcpHealthChecker()
    await vi.waitFor(() => expect(mocks.status).toHaveBeenCalled())
    stopMcpHealthChecker()
    resolveStatus({ servers: [] })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mocks.probe).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('probes a server whose status row is malformed, and still skips a valid connected row', async () => {
    mocks.status.mockResolvedValue({
      servers: [
        { connected: 'false', name: 'cloudflare', status: 'failed' },
        { connected: true, name: 'github', status: 'connected' },
        { connected: false, name: 'linear', status: 'failed' }
      ]
    })

    await sweepOnce()

    expect(mocks.probe.mock.calls.map(([name]) => name).sort()).toEqual(['cloudflare', 'linear'])
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'mcp-health-default::cloudflare' }))
  })

  it('discards a pending runtime snapshot when the gateway closes and reopens', async () => {
    let resolveStatus!: (value: { servers: unknown[] }) => void
    mocks.status.mockReturnValueOnce(
      new Promise(resolve => {
        resolveStatus = resolve
      })
    )
    startMcpHealthChecker()
    await vi.waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1))

    // Same profile, new connection; hold the follow-up sweep at its config read.
    let releaseConfig!: (value: Record<string, unknown>) => void
    mocks.config.mockReturnValueOnce(
      new Promise(resolve => {
        releaseConfig = resolve
      })
    )
    $gatewayState.set('closed')
    $gatewayState.set('open')

    try {
      resolveStatus({ servers: [{ connected: false, name: 'linear', status: 'failed' }] })
      await vi.waitFor(() => expect(mocks.config).toHaveBeenCalledTimes(2))
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(mocks.probe).not.toHaveBeenCalled()
      expect(mocks.notify).not.toHaveBeenCalled()
    } finally {
      // Let the held follow-up finish so no sweep stays in flight for later tests.
      stopMcpHealthChecker()
      releaseConfig({ mcp_servers: SERVERS })
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })

  it('drops a pending snapshot after a profile switch and reads the new profile', async () => {
    let resolveStatus!: (value: { servers: unknown[] }) => void
    mocks.status.mockReturnValueOnce(
      new Promise(resolve => {
        resolveStatus = resolve
      })
    )
    mocks.status.mockResolvedValue({
      servers: Object.keys(SERVERS).map(name => ({ connected: true, name, status: 'connected' }))
    })
    startMcpHealthChecker()
    await vi.waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1))
    $activeGatewayProfile.set('work')
    resolveStatus({ servers: [{ connected: false, name: 'linear', status: 'failed' }] })
    await vi.waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2))

    expect(mocks.status.mock.calls).toEqual([['default'], ['work']])
    expect(mocks.probe).not.toHaveBeenCalled()
  })

  it('falls back for malformed status and still excludes disabled and stdio servers', async () => {
    mocks.status.mockResolvedValue({ servers: null })
    mocks.config.mockResolvedValue({
      mcp_servers: {
        ...SERVERS,
        disabled: { url: 'https://disabled.example/mcp', enabled: false },
        local: { command: 'do-not-start' }
      }
    })
    await sweepOnce()

    expect(mocks.probe.mock.calls.map(([name]) => name).sort()).toEqual(['cloudflare', 'github', 'linear'])
  })

  it('probes every server when the status read is unavailable', async () => {
    mocks.status.mockRejectedValue(new Error('method not found'))

    await sweepOnce()

    expect(mocks.probe.mock.calls.map(([name]) => name).sort()).toEqual(['cloudflare', 'github', 'linear'])
  })
})
