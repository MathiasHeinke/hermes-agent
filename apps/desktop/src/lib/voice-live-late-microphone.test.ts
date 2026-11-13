import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type VoiceLiveHandlers, VoiceLiveSession } from './voice-live'

// The permission prompt can outlive the call: ending a session while
// getUserMedia is still pending must not leave the late stream capturing.

const handlers = (): VoiceLiveHandlers => ({ onClosed: vi.fn(), onDelegation: vi.fn(), onError: vi.fn() })

let grantMicrophone: (stream: unknown) => void
let stopTrack: ReturnType<typeof vi.fn>
let api: ReturnType<typeof vi.fn>

function microphone() {
  const tracks = [{ stop: stopTrack }]

  return { getAudioTracks: () => tracks, getTracks: () => tracks }
}

beforeEach(() => {
  stopTrack = vi.fn()
  api = vi.fn(async () => ({ ok: true, session: { id: 's1' }, transport: { sdp: 'answer', type: 'answer' } }))

  const channel = {
    addEventListener: () => undefined,
    close: () => undefined,
    readyState: 'open',
    send: () => undefined
  }

  // Like WebRTC, a closed peer refuses new tracks.
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      connectionState = 'new'
      iceGatheringState = 'complete'
      localDescription = { sdp: 'v=0\r\n' }
      addEventListener = () => undefined
      createDataChannel = () => channel
      createOffer = async () => ({})
      setLocalDescription = async () => undefined
      setRemoteDescription = async () => undefined

      addTrack() {
        if (this.connectionState === 'closed') {
          throw new DOMException('The RTCPeerConnection is closed', 'InvalidStateError')
        }
      }

      close() {
        this.connectionState = 'closed'
      }
    }
  )
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api } })
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => new Promise(resolve => (grantMicrophone = resolve)) }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'hermesDesktop')
  Reflect.deleteProperty(window.navigator, 'mediaDevices')
})

describe('a microphone granted after the live session closed', () => {
  it('is released, and no backend session is created', async () => {
    const callbacks = handlers()
    const session = new VoiceLiveSession(callbacks)
    const starting = session.start([]).catch((error: unknown) => error)

    session.close()
    grantMicrophone(microphone())

    const failure = await starting

    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(failure).toBeUndefined()
    expect(api).not.toHaveBeenCalled()
    expect(callbacks.onClosed).toHaveBeenCalledTimes(1)
  })

  it('stays open when the session is still live', async () => {
    const session = new VoiceLiveSession(handlers())
    const starting = session.start([])

    grantMicrophone(microphone())
    await starting

    expect(stopTrack).not.toHaveBeenCalled()
    expect(api).toHaveBeenCalledTimes(1)
  })
})
