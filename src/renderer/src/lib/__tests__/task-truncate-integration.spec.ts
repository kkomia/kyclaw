import { afterEach, describe, expect, it, vi } from 'vitest'
import { tasksStore } from '../tasks-store'
import { truncateThread } from '../threads-api'
import { installKyclawBridge, clearKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { defaultSettings } from '@shared/settings'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  clearKyclawBridge()
})
describe('Task truncate lifecycle', () => {
  it('服务端截断成功后 load，失败不假刷新', async () => {
    installKyclawBridge(defaultSettings())
    const load = vi.spyOn(tasksStore.getState(), 'load').mockResolvedValue(undefined)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: 2 })))
        .mockResolvedValueOnce(new Response('{}', { status: 500 }))
    )
    expect(await truncateThread('thread', 'message')).toBe(2)
    expect(load).toHaveBeenCalledExactlyOnceWith('thread')
    await expect(truncateThread('thread', 'message')).rejects.toThrow('500')
    expect(load).toHaveBeenCalledTimes(1)
  })
})
