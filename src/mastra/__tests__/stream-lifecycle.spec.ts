// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ownStream } from '../stream-lifecycle'
import type { StreamLease } from '../ask-user-runtime'

function lease(): { value: StreamLease; stop: () => Promise<void>; releases: () => number } {
  let releases = 0
  let stop: () => Promise<void> = async () => {}
  const value: StreamLease = {
    release: () => {
      releases += 1
    },
    bindStop: (callback) => {
      stop = callback
    }
  }
  return { value, stop: () => stop(), releases: () => releases }
}

describe('server-owned stream lifecycle', () => {
  it('finishes the source without requiring the client to consume the response', async () => {
    const owner = lease()
    let finished!: () => void
    const done = new Promise<void>((resolve) => {
      finished = resolve
    })
    let count = 0
    const source = new ReadableStream<number>({
      pull(controller) {
        if (count++ === 2) {
          controller.close()
          finished()
        } else controller.enqueue(count)
      }
    })
    ownStream(source, owner.value)
    await done
    await owner.stop()
    expect(owner.releases()).toBe(1)
  })

  it('uncooperative source cancellation fails closed without releasing execution ownership', async () => {
    vi.useFakeTimers()
    try {
      const owner = lease()
      let cancelled = false
      const source = new ReadableStream<number>({
        cancel() {
          cancelled = true
          return new Promise<void>(() => {})
        }
      })
      ownStream(source, owner.value)
      const stopped = expect(owner.stop()).rejects.toThrow('stream-stop-unconfirmed')
      await vi.advanceTimersByTimeAsync(5000)
      await stopped
      expect(cancelled).toBe(true)
      expect(owner.releases()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('client cancellation after one chunk stops the source once', async () => {
    const owner = lease()
    let cancels = 0
    const source = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1)
      },
      cancel() {
        cancels += 1
      }
    })
    const response = ownStream(source, owner.value).getReader()
    expect((await response.read()).value).toBe(1)
    await response.cancel()
    await owner.stop()
    expect(cancels).toBe(1)
    expect(owner.releases()).toBe(1)
  })
})
