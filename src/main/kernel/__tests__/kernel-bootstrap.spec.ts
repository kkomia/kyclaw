// @vitest-environment node
/**
 * PB-020 B：内核必启后不再有 flag；`maybeStartKernelAdapter` 只做「配置硬校验 → 布局校验」，
 * 缺参数（PB-017 的 spawn('') 崩溃面）或路径不存在都必须抛带 code 的 KernelStartupError。
 */
import { describe, expect, it } from 'vitest'
import { maybeStartKernelAdapter } from '../kernel-bootstrap'

describe('kernel bootstrap：必启（无 flag）', () => {
  it('空参数 → KERNEL_NOT_CONFIGURED（fail fast，不 spawn）', async () => {
    await expect(
      maybeStartKernelAdapter({
        electronExecutable: '',
        asarPath: '',
        appDataDir: 'Z:\\does\\not\\exist'
      })
    ).rejects.toMatchObject({ code: 'KERNEL_NOT_CONFIGURED' })
  })

  it('内核路径不存在 → 统一 KernelStartupError（不 spawn、不裸抛 ENONT）', async () => {
    await expect(
      maybeStartKernelAdapter({
        electronExecutable: 'Z:\\does\\not\\exist.exe',
        asarPath: 'Z:\\does\\not\\exist.asar',
        appDataDir: 'Z:\\does\\not\\exist'
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/^KERNEL_/) })
  })
})
