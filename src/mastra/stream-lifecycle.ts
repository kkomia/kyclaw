import type { StreamLease } from './ask-user-runtime'

export function ownStream<T>(source: ReadableStream<T>, lease: StreamLease): ReadableStream<T> {
  const reader = source.getReader()
  let terminal = false
  let stopping = false
  let stopPromise: Promise<void> | undefined
  let close: (() => void) | undefined
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const finish = (): void => {
    if (terminal) return
    terminal = true
    lease.release()
    resolveDone()
  }
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    if (terminal) return Promise.resolve()
    stopping = true
    close?.()
    stopPromise = (async () => {
      const cancellation = reader.cancel('interaction-cancelled')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          cancellation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('stream-stop-unconfirmed')), 5000)
          })
        ])
        finish()
        await done
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    })()
    return stopPromise
  }
  lease.bindStop(stop)
  return new ReadableStream<T>({
    async start(controller) {
      close = () => {
        try {
          controller.close()
        } catch {
          /* already cancelled */
        }
      }
      try {
        for (;;) {
          const part = await reader.read()
          if (terminal || stopping) return
          if (part.done) {
            controller.close()
            break
          }
          controller.enqueue(part.value)
        }
      } catch (error) {
        if (!terminal && !stopping) controller.error(error)
      } finally {
        if (!stopping) finish()
      }
    },
    cancel: stop
  })
}
