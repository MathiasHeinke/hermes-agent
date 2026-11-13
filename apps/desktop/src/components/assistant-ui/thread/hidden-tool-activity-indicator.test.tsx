// With display.tool_progress off the transcript draws no row for a read, a
// search or a command. A call in flight then has nothing on screen to narrate
// the wait with, so the tail activity row owes the user its line and timer.
import type { ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetElapsedTimerRegistryForTests } from '@/components/chat/activity-timer'
import { $activeSessionId, $busy, $turnStartedAt } from '@/store/session'
import { $showToolActivity } from '@/store/tool-activity'

import { createdAt, stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime, userMessage } from '../test-utils'

import { Thread } from '.'

stubThreadEnvironment()
stubThreadViewportSize()

const sessionId = 'session-hidden-tools'

const readingFile = {
  id: 'assistant-1',
  role: 'assistant',
  content: [
    { type: 'text', text: 'Let me look.' },
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', args: { path: '/w/a.md' }, argsText: '{}' }
  ],
  status: { type: 'running' },
  createdAt,
  metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
} as ThreadMessage

function activityRow() {
  const { container } = render(
    <ThreadRuntime messages={[userMessage('user-1', 'Read a.md'), readingFile]}>
      <Thread />
    </ThreadRuntime>
  )

  act(() => {
    vi.advanceTimersByTime(5_000)
  })

  return container.querySelector('[data-slot="aui_turn-activity"]')
}

describe('the turn activity row while a tool call runs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    __resetElapsedTimerRegistryForTests()
    $activeSessionId.set(sessionId)
    $turnStartedAt.set(Date.now())
    $busy.set(true)
  })

  afterEach(() => {
    cleanup()
    $showToolActivity.set(true)
    $busy.set(false)
    $activeSessionId.set(null)
    $turnStartedAt.set(null)
    __resetElapsedTimerRegistryForTests()
    vi.useRealTimers()
  })

  it('times the wait itself when the tool feed is hidden', () => {
    $showToolActivity.set(false)

    expect(activityRow()?.getAttribute('data-state')).toBe('active')
  })

  it('stays out of the way of a visible tool row', () => {
    expect(activityRow()).toBeNull()
  })
})
