/**
 * backend-dial-claim.ts
 *
 * Single-owner reconnect/dial claim for backend spawns, keyed by the pool
 * key of the backend a (connectionId, profile) dial answers: keyFor() (#90812).
 *
 * Why this exists: reconnectGateway()'s in-flight lock lives at renderer
 * module scope, so it only dedupes reconnects INSIDE one window. Two windows
 * (main + a session pop-out) racing the same wake both invoke the main-process
 * dial IPC, and for a pooled SSH connection the loser of the pool-entry race
 * could bootstrap a duplicate remote backend. Electron main is the single
 * owner of backend lifecycles, so the claim belongs here: the first dial for a
 * (connectionId, profile) key runs; every concurrent caller for the same key
 * awaits and receives that first dial's result.
 *
 * Bounded by construction: a claim exists only while its dial promise is
 * unsettled — both outcomes release it, so a failed dial is never cached and
 * the next reconnect attempt runs fresh (fail closed, not latched).
 */
import { backendScopeKey, LOCAL_CONNECTION_ID, resolveRegistryLocalRoute } from './connection-registry'

export class BackendDialClaims {
  readonly #inflightByKey = new Map<string, Promise<unknown>>()
  readonly #globalRemote: () => boolean
  readonly #profileRemoteOverride: (profile: string) => unknown

  /** The live v1 routing facts resolveRegistryLocalRoute() decides on; the defaults mean a local primary. */
  constructor(
    globalRemote: () => boolean = () => false,
    profileRemoteOverride: (profile: string) => unknown = () => false
  ) {
    this.#globalRemote = globalRemote
    this.#profileRemoteOverride = profileRemoteOverride
  }

  /**
   * The claim key for a dial of (connectionId, profile): the pool key of the
   * backend that dial answers. backendScopeKey('local', p) is the bare key the
   * primary route's own dial of `p` claims. While that route is remote the
   * registry's 'local' entry answers its forced-local child instead, so it
   * claims under the child's `conn:local::<profile>` pool key; on the shared
   * bare key, whichever of the two dials arrived second got the other backend.
   */
  keyFor(connectionId: null | string | undefined, profile: null | string | undefined): string {
    const scopeKey = backendScopeKey(connectionId, profile)

    if (String(connectionId ?? '').trim() !== LOCAL_CONNECTION_ID) {
      return scopeKey
    }

    const route = resolveRegistryLocalRoute(profile, {
      globalRemote: this.#globalRemote(),
      profileRemoteOverride: Boolean(this.#profileRemoteOverride(scopeKey))
    })

    return route.delegate ? scopeKey : route.poolKey
  }

  /** Whether a dial for this key is currently in flight (test/diagnostic seam). */
  inFlight(key: string): boolean {
    return this.#inflightByKey.has(key)
  }

  run<T>(key: string, dial: () => Promise<T> | T): Promise<T> {
    const existing = this.#inflightByKey.get(key) as Promise<T> | undefined

    if (existing) {
      return existing
    }

    // Start the dial eagerly so the first caller's spawn is already in flight
    // when a concurrent caller arrives; a synchronously-throwing dial is
    // converted into a rejection of THIS claim so it cannot bypass the seam.
    let pending: Promise<T>

    try {
      pending = Promise.resolve(dial())
    } catch (error) {
      pending = Promise.reject(error)
    }

    const release = () => {
      if (this.#inflightByKey.get(key) === pending) {
        this.#inflightByKey.delete(key)
      }
    }

    this.#inflightByKey.set(key, pending)
    // Release on both outcomes without creating an unhandled rejected branch.
    void pending.then(release, release)

    return pending
  }
}
