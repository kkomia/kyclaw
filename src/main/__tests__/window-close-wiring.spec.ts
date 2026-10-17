// @vitest-environment node
/**
 * 0.1.3 托盘驻留的**接线钉子**（源码级，手法同 telemetry-env.spec.ts）：
 * `index.ts` / `window.ts` / `tray.ts` 都 import electron（或 `icon.png?asset`），在 vitest 里装不进来，
 * 所以这里读源码把三条硬口径钉死（独立审核 135 的收口点）：
 *
 *   1. **退出标记只由真事件立**：`app.on('before-quit')`、更新安装的
 *      `autoUpdater.on('before-quit-for-update')`、Windows 会话结束的窗口 `session-end`；
 *      可被取消的 `query-session-end` **不许接**；`index.ts` 里不许有直接调用（标记只能被事件触发）。
 *   2. **安装路径不预立标记**（回归点：提前立 = 安装失败 / 静默 false 之后点 X 直接退出）：
 *      `updater.ts` 与"退出标记"零耦合，`index.ts` 里没有安装前的钩子。
 *   3. **托盘可用性现问现答**：`tray.ts` 注册的探针把 `isDestroyed()` 一起看（启动后失效立刻反映）。
 *
 * 真行为（真窗口 / 真托盘 / 真聊天流）不在单测范围：e2e 探针 + 人工走查。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const windowSource = readFileSync(new URL('../window.ts', import.meta.url), 'utf8')
const traySource = readFileSync(new URL('../tray.ts', import.meta.url), 'utf8')
const updaterSource = readFileSync(new URL('../updater.ts', import.meta.url), 'utf8')

describe('退出标记的接线（源码级）', () => {
  it('index.ts：before-quit 与 before-quit-for-update 两处真事件立标记；没有安装前的提前闩', () => {
    expect(indexSource).toContain("app.on('before-quit', markQuitting)")
    // 更新安装那条路：在**发事件的那个对象**上接（Electron 原生 autoUpdater）。
    // electron-updater 6.8.9 的 BaseUpdater.js 只在 install() 真成功后才 emit 它再 app.quit()；
    // 失败 / 静默 false / 重复点安装都不会发（也不会退出）。
    expect(indexSource).toContain("autoUpdater?.on('before-quit-for-update', markQuitting)")
    // 不许有第三种立标记的方式：标记只能被上面两个事件触发，跨字段的"提前闩"一律不要
    expect(indexSource).not.toMatch(/markQuitting\(\)/)
    expect(indexSource).not.toContain('onInstall')
  })

  it('window.ts：只接 session-end（真结束）；可被取消的 query-session-end 不接', () => {
    expect(windowSource).toContain("win.on('session-end', () => markQuitting())")
    // 标记的调用点在这一处之外一个都不许有（提前立起来会把之后的关闭全放行）
    expect(windowSource.match(/markQuitting\(\)/g) ?? []).toHaveLength(1)
    expect(windowSource).not.toContain("win.on('query-session-end'")
  })

  it('window.ts：探针注入走 is.dev 门（打包生产忽略 KYCLAW_CLOSE_PROMPT，环境变量改不了偏好）', () => {
    // 唯一入口 + 把 is.dev 交进去：生产构建里 is.dev 为 false → 一律不认这个环境变量
    expect(windowSource).toContain(
      'scriptedClosePromptFor(is.dev, process.env.KYCLAW_CLOSE_PROMPT)'
    )
    expect(windowSource).not.toMatch(/parseScriptedClosePrompt\(/)
  })

  it('updater.ts：安装路径与"退出标记"零耦合（安装失败 / 重复安装都不改变关闭行为）', () => {
    expect(updaterSource).not.toContain('markQuitting')
    expect(updaterSource).not.toContain('window-close')
  })

  it('tray.ts：注册现问现答的可用性探针（含 isDestroyed——启动后失效立刻反映）', () => {
    expect(traySource).toContain('registerTrayAvailability(')
    expect(traySource).toContain('isDestroyed()')
  })
})
