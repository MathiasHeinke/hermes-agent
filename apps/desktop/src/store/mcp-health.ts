/**
 * Background MCP health checker. On gateway connect — and every 30 minutes
 * after — probe the ACTIVE profile's enabled HTTP/SSE MCP servers and nudge
 * the user when one is in needs-auth (expired OAuth token) or error: on the
 * transition, then at most once a day while it stays broken, with a
 * one-click path to the MCP page's Authenticate button and a Disable button
 * for servers the user no longer wants.
 *
 * Scope is deliberate: stdio servers are NEVER probed here. Probing a stdio
 * server SPAWNS a local process, so a background timer would silently launch
 * user-configured commands every half hour. Only url-shaped servers (HTTP/SSE
 * — where OAuth expiry actually lives) are swept, sequentially, and through
 * the same probe cache the MCP page uses so neither surface re-probes what
 * the other just learned.
 *
 * A server the gateway reports as connected is recorded ok without a probe,
 * and one still connecting is left alone. A connected runtime session is not
 * a fresh OAuth check, so an expired token on a live session surfaces only
 * once the runtime drops it (its own keepalive) or a manual probe runs.
 */

import { mcpServerStatus } from '@/app/capabilities/connectors/data/rpc'
import { getHermesConfigRecord, type McpTestResult, setMcpServerEnabled, testMcpServer } from '@/hermes'
import { translateNow } from '@/i18n'
import { classifyProbe, freshProbe, probeCache, probeKey } from '@/lib/mcp-probe-cache'
import { getServers, serverEnabled } from '@/lib/mcp-servers'
import { persistString, storedString } from '@/lib/storage'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $gatewayState } from '@/store/session'

// A constant, not a config knob: the sweep is cheap (a handful of sequential
// HTTP probes at most) and the notification is transition-gated below, so
// there is nothing for a user to meaningfully tune.
const CHECK_INTERVAL_MS = 30 * 60_000

export type McpHealthStatus = 'error' | 'needs-auth' | 'ok'

/**
 * The notify decision, as a pure state machine: nudge on a TRANSITION into a
 * bad state — never for ok. An unknown previous state (first sweep of the
 * session) notifies only when its persisted cooldown is absent or elapsed,
 * so an expired token discovered at launch is still surfaced without
 * re-notifying after a renderer restart.
 *
 * A server that STAYS broken is nudged again once the daily snooze lapses:
 * a dead OAuth token is a standing problem the user has to act on (sign in
 * again, or disable the server), and a one-shot toast they closed on Monday
 * is forgotten by Wednesday. `snoozedUntil` is the persisted per-server
 * cooldown (set when a toast is shown); the recheck path re-nudges only past
 * it, so an unchanged bad state costs at most one toast per day.
 */
export function shouldNotify(
  previous: McpHealthStatus | null,
  next: McpHealthStatus,
  snoozedUntil: number,
  now: number
): boolean {
  if (next !== 'error' && next !== 'needs-auth') {
    return false
  }

  // A renderer restart clears transition memory but not the per-server
  // cooldown. Treat that first sweep as a recheck: an active persisted snooze
  // must still suppress the toast, while an unset or elapsed snooze may nudge.
  if (previous === null) {
    return now >= snoozedUntil
  }

  return previous !== next || now >= snoozedUntil
}

// Same time-based snooze the update/skew toasts use (store/updates.ts): a
// shown toast arms a 24h cooldown for that (profile, server), persisted so an
// app restart does not re-nudge before the day is up.
const SNOOZE_KEY_PREFIX = 'hermes:mcp-health-snooze-until:'
const SNOOZE_MS = 24 * 60 * 60 * 1000

function snoozedUntil(key: string): number {
  const until = Number(storedString(SNOOZE_KEY_PREFIX + key) || 0)

  return Number.isFinite(until) ? until : 0
}

function snooze(key: string): void {
  persistString(SNOOZE_KEY_PREFIX + key, String(Date.now() + SNOOZE_MS))
}

// Last-known status per (profile, server) — the transition memory. Keyed by
// profile so one profile's broken server can't mute or trigger another's
// (AGENTS.md scope-in-key).
const lastStatus = new Map<string, McpHealthStatus>()

let started = false
let timer: ReturnType<typeof setInterval> | null = null
// Bumped on profile switch and whenever the gateway leaves 'open'; in-flight
// sweeps compare and bail so a slow profile-A probe can't record (or notify)
// into profile B's state, and a snapshot from a dropped connection can't be
// recorded after a reconnect.
let sweepEpoch = 0
// At most one sweep runs and one follow-up is remembered. Reconnect storms
// still request a fresh pass, but cannot append an unbounded backlog.
let sweepInFlight: Promise<void> | null = null
let sweepQueued = false
let offGatewayState: (() => void) | null = null
let offProfile: (() => void) | null = null

function openMcpServerPage(name: string): void {
  window.location.hash = `#/capabilities?tab=connectors&server=${encodeURIComponent(name)}`
}

// "Disable" from the toast: `enabled: false` in config.yaml (the server stays
// listed on the MCP page for a later re-enable). The backend follows the edit
// on its own — the gateway's config reconcile and the serve backend's next
// reload both drop a disabled server — so no reload RPC is issued here.
async function disableServer(profileKey: string, name: string): Promise<void> {
  try {
    await setMcpServerEnabled(name, false)
    lastStatus.delete(`${profileKey}::${name}`)
    notify({
      kind: 'success',
      message: translateNow('notifications.mcp.disabledMessage', name)
    })
  } catch (err) {
    notifyError(err, translateNow('notifications.mcp.disableFailed', name))
  }
}

function recordResult(profileKey: string, name: string, status: McpHealthStatus): void {
  const key = `${profileKey}::${name}`
  const previous = lastStatus.get(key) ?? null
  lastStatus.set(key, status)

  if (!shouldNotify(previous, status, snoozedUntil(key), Date.now())) {
    return
  }

  snooze(key)

  const needsAuth = status === 'needs-auth'

  notify({
    action: {
      label: translateNow(needsAuth ? 'notifications.mcp.signIn' : 'notifications.mcp.view'),
      onClick: () => openMcpServerPage(name)
    },
    id: `mcp-health-${key}`,
    kind: 'warning',
    message: translateNow(needsAuth ? 'notifications.mcp.needsAuthMessage' : 'notifications.mcp.errorMessage', name),
    secondaryAction: {
      label: translateNow('notifications.mcp.disable'),
      onClick: () => void disableServer(profileKey, name)
    },
    title: translateNow(needsAuth ? 'notifications.mcp.needsAuthTitle' : 'notifications.mcp.errorTitle')
  })
}

const isUrlServer = (server: Record<string, unknown>): boolean =>
  typeof server.url === 'string' && serverEnabled(server)

type RuntimeState = 'connected' | 'connecting'

// Only a well-formed row may skip a probe; anything else falls through to it.
function runtimeState(row: unknown): RuntimeState | null {
  if (!row || typeof row !== 'object') {
    return null
  }

  const { connected, status } = row as Record<string, unknown>

  if (connected === true && status === 'connected') {
    return 'connected'
  }

  return connected === false && status === 'connecting' ? 'connecting' : null
}

// Reading the gateway's cached state avoids a second connection and tool listing.
// Older/unavailable gateways fall back to the existing probe path.
async function runtimeStates(profile: string): Promise<Map<string, RuntimeState> | null> {
  try {
    const { servers } = (await mcpServerStatus(profile)) as { servers?: unknown }
    const states = new Map<string, RuntimeState>()

    for (const row of Array.isArray(servers) ? servers : []) {
      const state = runtimeState(row)
      const name = (row as { name?: unknown } | null)?.name

      if (state && typeof name === 'string') {
        states.set(name, state)
      }
    }

    return states
  } catch {
    return null
  }
}

async function sweep(): Promise<void> {
  const epoch = sweepEpoch
  const profile = $activeGatewayProfile.get()
  const profileKey = normalizeProfileKey(profile)

  let config: Record<string, unknown>

  try {
    config = await getHermesConfigRecord()
  } catch {
    // Backend unreachable / mid-restart — the next interval tick retries.
    return
  }

  if (epoch !== sweepEpoch || $gatewayState.get() !== 'open') {
    return
  }

  // getServers drops non-object entries (a bare `name:` in config.yaml parses
  // as `null`), so isUrlServer below never reads `.url` off a null entry.
  const servers = getServers(config)
  const states = await runtimeStates(profile)

  if (epoch !== sweepEpoch || $gatewayState.get() !== 'open') {
    return
  }

  for (const [name, server] of Object.entries(servers)) {
    if (!isUrlServer(server)) {
      continue
    }

    // A profile switch or gateway drop mid-sweep stops the remaining probes.
    if (epoch !== sweepEpoch || $gatewayState.get() !== 'open') {
      return
    }

    // Live sessions are healthy; let an in-progress connection finish on its own.
    const state = states?.get(name)

    if (state === 'connected') {
      recordResult(profileKey, name, 'ok')

      continue
    }

    if (state === 'connecting') {
      continue
    }

    const key = probeKey(name, server, profileKey)
    let result = freshProbe(key)

    if (!result) {
      try {
        result = await testMcpServer(name)
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] } as McpTestResult
      }

      if (epoch !== sweepEpoch) {
        return
      }

      probeCache.set(key, { at: Date.now(), result })
    }

    recordResult(profileKey, name, classifyProbe(result))
  }
}

function queueSweep(): void {
  if (sweepInFlight) {
    sweepQueued = true

    return
  }

  sweepInFlight = sweep()

  const settled = () => {
    sweepInFlight = null

    if (sweepQueued) {
      sweepQueued = false
      queueSweep()
    }
  }

  sweepInFlight.then(settled, settled)
}

function arm(): void {
  if (timer !== null) {
    return
  }

  queueSweep()
  timer = setInterval(queueSweep, CHECK_INTERVAL_MS)
}

function disarm(): void {
  sweepQueued = false

  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

/** Wire the background checker to gateway/profile state. Idempotent. */
export function startMcpHealthChecker(): void {
  if (started || typeof window === 'undefined') {
    return
  }

  started = true

  // Never check while the gateway is disconnected: the timer only exists
  // while the active socket is open, and rearms on reconnect.
  offGatewayState = $gatewayState.subscribe((state: string) => {
    if (state === 'open') {
      arm()
    } else {
      sweepEpoch += 1
      disarm()
    }
  })

  // Profile switch: invalidate in-flight sweeps, drop the timer, and re-arm
  // for the new profile (fresh immediate sweep + fresh interval) if its
  // gateway is connected. lastStatus and the snooze keys are profile-keyed,
  // so no wipe is needed — profile A's transition memory stays intact for
  // when the user switches back.
  offProfile = $activeGatewayProfile.listen(() => {
    sweepEpoch += 1
    disarm()

    if ($gatewayState.get() === 'open') {
      arm()
    }
  })
}

export function stopMcpHealthChecker(): void {
  disarm()
  sweepEpoch += 1
  offGatewayState?.()
  offGatewayState = null
  offProfile?.()
  offProfile = null
  started = false
}
