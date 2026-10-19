// @vitest-environment node
/**
 * B3.1a：flag 关 → `maybeStartKernelAdapter` 必须 **null 且零副作用**（不 spawn、不碰路径）。
 */
import { describe, expect, it } from 'vitest'
import { maybeStartKernelAdapter } from '../kernel-bootstrap'

describe('kernel bootstrap：默认关 = 行为不变', () => {
  it('未设 / 非 1：返回 null（非法路径也不会被访问）', async () => {
    await expect(
      maybeStartKernelAdapter({
        electronExecutable: 'Z:\\does\\not\\exist.exe',
        asarPath: 'Z:\\does\\not\\exist.asar',
        appDataDir: 'Z:\\does\\not\\exist',
        env: {}
      })
    ).resolves.toBeNull()
    await expect(
      maybeStartKernelAdapter({
        electronExecutable: 'Z:\\does\\not\\exist.exe',
        asarPath: 'Z:\\does\\not\\exist.asar',
        appDataDir: 'Z:\\does\\not\\exist',
        env: { KYCLAW_KERNEL_PORT: '0' }
      })
    ).resolves.toBeNull()
  })
})
