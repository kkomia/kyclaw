import { defineConfig } from '@playwright/test'

/**
 * E2E（T16）：Playwright 的 **Electron 模式**——不起浏览器、也不需要 `playwright install`
 * （渲染进程由 Electron 自带，`_electron.launch` 直接连）。
 *
 * - 产物走 `pnpm test:e2e`（先 `pnpm build` 再跑本配置）；用例只读 `out/` 的构建产物；
 * - 全量串行（`workers: 1`）：每个用例起一个真 Electron 实例，且各自用独立的 userData
 *   （见 e2e/harness.ts），并发只会互相干扰窗口焦点与托盘；
 * - 失败时的截图/trace 落到 `.superpowers/.../smoke-t16/e2e-artifacts/`（证据簿，不进仓库）。
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  outputDir: '.superpowers/sdd/2026-10-10-kyclaw-mvp/smoke-t16/e2e-artifacts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
