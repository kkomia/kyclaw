import { describe, expect, it, vi } from 'vitest'
import { officeFontPrewarmState, startOfficeFontPrewarm } from '../office-font-prewarm'

/**
 * R2-04：失败重试（有界 1 次 / 2s 退避）必须可被「真实面已就绪」取消——
 * 否则用户在 2s 内打开 Office 文档后，还会白起一个 27MB/46 注册的隐藏预热面。
 *
 * 单独一个 spec 文件：模块状态是单例（started/state/retried），与其他用例隔离。
 */
describe('R2-04：预热失败重试可被真实面取消', () => {
  it('真实面 ready 后清掉 2s 重试定时器：不再白起预热面', () => {
    vi.useFakeTimers()
    try {
      const hosts = (): number =>
        document.querySelectorAll('[data-testid="office-font-prewarm-host"]').length

      startOfficeFontPrewarm()
      expect(hosts()).toBe(1)

      // 30s 预热超时 → error + 排一次 2s 后的重试（error 后内部转回 idle 等重试）
      vi.advanceTimersByTime(30_001)
      expect(officeFontPrewarmState()).toBe('idle')
      expect(hosts()).toBe(0)

      // 2s 内用户打开了**真实** Office 面（消息来自其它面，不是预热面）→ 应取消重试
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'surface:fonts-ready',
            prewarm: false,
            elapsedMs: 5,
            stats: {
              faces: 22,
              registrations: 46,
              fetchedBytes: 1,
              fontSetSize: 1,
              ms: 5,
              cjk: true
            }
          }
        })
      )

      vi.advanceTimersByTime(2_500)
      expect(hosts()).toBe(0)
      expect(officeFontPrewarmState()).not.toBe('loading')
    } finally {
      vi.useRealTimers()
      document
        .querySelectorAll('[data-testid="office-font-prewarm-host"]')
        .forEach((node) => node.remove())
    }
  })
})
