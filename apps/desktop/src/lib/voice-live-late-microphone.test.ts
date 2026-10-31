/** Live-voice media lifecycle with fake browser devices; no microphone or provider calls. */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useVoiceLiveConversation } from '@/app/chat/composer/hooks/use-voice-live-conversation'
import { VoiceLiveSession } from '@/lib/voice-live'

const mocks = vi.hoisted(() => ({ api: vi.fn(), notify: vi.fn() }))
vi.mock('@/api/client', async original => ({ ...(await original<object>()), hermesApi: mocks.api }))
vi.mock('@/store/notifications', () => ({ notify: mocks.notify, notifyError: mocks.notify }))

let resolveMic: (value: unknown) => void
let getUserMedia: ReturnType<typeof vi.fn>
let stop: ReturnType<typeof vi.fn<() => void>>
let peers: FakePeer[]
const streams: { getTracks: () => { stop: () => void }[]; getAudioTracks: () => { stop: () => void }[] }[] = []
const handlers = () => ({ onClosed: vi.fn(), onError: vi.fn(), onDelegation: vi.fn() })

class FakeChannel {
  readyState = 'open'
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 'closed' })
  listeners = new Map<string, (value: any) => void>()
  addEventListener(type: string, fn: (value: any) => void) { this.listeners.set(type, fn) }
  closedByServer() { this.listeners.get('message')?.({ data: JSON.stringify({ type: 'session.closed', reason: 'closed' }) }) }
}

class FakePeer {
  connectionState = 'new'
  iceGatheringState = 'complete'
  localDescription = { sdp: 'v=0\r\n' }
  channel = new FakeChannel()
  close = vi.fn(() => { this.connectionState = 'closed' })
  addEventListener() {}
  addTrack() { if (this.connectionState === 'closed') { throw new DOMException('Closed peer', 'InvalidStateError') } }
  createDataChannel() { return this.channel }
  async createOffer() { return {} }
  async setLocalDescription() {}
  async setRemoteDescription() { if (this.connectionState === 'closed') { throw new DOMException('Closed peer', 'InvalidStateError') } }
  constructor() { peers.push(this) }
}

function microphone() {
  const value = { getTracks: () => [{ stop }], getAudioTracks: () => [{ stop }] }
  streams.push(value)

  return value
}

beforeEach(() => {
  vi.clearAllMocks(); peers = []; streams.length = 0; stop = vi.fn()
  getUserMedia = vi.fn(() => new Promise(resolve => { resolveMic = resolve }))
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  vi.stubGlobal('Audio', class { srcObject = null; autoplay = false; pause = vi.fn() })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  mocks.api.mockResolvedValue({ ok: true, session: { id: 'synthetic' }, transport: { sdp: 'answer', type: 'answer' } })
})
afterEach(() => { cleanup(); streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); vi.useRealTimers(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, 'mediaDevices') })

it('stops a microphone granted after the session was already closed', async () => {
  const callbacks = handlers(), session = new VoiceLiveSession(callbacks)
  const starting = session.start([]).catch(() => undefined)
  session.close()
  expect(callbacks.onClosed).toHaveBeenCalledOnce()
  resolveMic(microphone())
  await starting
  session.close() // same cleanup as the conversation hook
  expect(stop).toHaveBeenCalledOnce()
  expect(mocks.api).not.toHaveBeenCalled()
  expect(callbacks.onClosed).toHaveBeenCalledOnce()
})

it('does not leak a late microphone through the real conversation hook after end/unmount', async () => {
  const hook = renderHook(() => useVoiceLiveConversation({ enabled: true, busy: false,
    onSubmit: vi.fn(), consumePendingResponse: vi.fn(), pendingResponse: () => null, seedHistory: () => [] }))

  let starting: Promise<void>
  await act(async () => { starting = hook.result.current.start(); await Promise.resolve() })
  expect(getUserMedia).toHaveBeenCalledOnce()
  await act(async () => { await hook.result.current.end() })
  hook.unmount()
  await act(async () => { resolveMic(microphone()); await starting! })
  expect(stop).toHaveBeenCalledOnce()
  expect(mocks.api).not.toHaveBeenCalled()
})

it('keeps the graceful close and ends tracks when session.closed arrives', async () => {
  const callbacks = handlers(), session = new VoiceLiveSession(callbacks)
  const starting = session.start([]); resolveMic(microphone()); await starting
  session.close()
  expect(peers[0].channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'session.close' }))
  expect(stop).not.toHaveBeenCalled()
  peers[0].channel.closedByServer()
  expect(stop).toHaveBeenCalledOnce()
  expect(peers[0].close).toHaveBeenCalledOnce()
  session.close(); expect(callbacks.onClosed).toHaveBeenCalledOnce()
})

it('ends the graceful close after its existing 15-second fallback', async () => {
  vi.useFakeTimers()
  const session = new VoiceLiveSession(handlers())
  const starting = session.start([]); resolveMic(microphone()); await starting
  session.close()
  await vi.advanceTimersByTimeAsync(14_999)
  expect(stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(stop).toHaveBeenCalledOnce()
  expect(peers[0].close).toHaveBeenCalledOnce()
})
