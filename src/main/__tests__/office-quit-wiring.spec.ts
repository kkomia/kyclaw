// @vitest-environment node
/**
 * M3-S5-1 的**接线钉子**（源码级，手法同 `window-close-wiring.spec.ts` / `telemetry-env.spec.ts`）：
 * `index.ts` / `window.ts` 都 import electron（或静态资源），在 vitest 里装不进来，所以这里读源码
 * 把 S5 的几条硬口径钉死：
 *
 *   1. **两个入口都接**：`before-quit` 只挂 guard（旧的 `app.on('before-quit', markQuitting)` 已撤）；
 *      窗口 close 的 allow 分支经 `registerCloseAllowGuard` 接同一个 guard。hide（收进托盘）不接。
 *   2. **`markQuitting()` 顺序**：唯一落点是 office-quit.ts 的 `markAllowedQuit()`，只在两条放行
 *      路径（dirty=0 / 壳回 saved|discarded）调用；取消 / 超时 / 发送失败绝不经过它。
 *      index.ts 里没有直接调用（标记只能由真事件与 guard 的放行分支触发）。
 *   3. **纯状态机不碰 electron、不与更新安装路径耦合**（与 updater.ts 的"零耦合"同口径）。
 *   4. **allow 分支的位置**：守卫在 `decision.kind === 'allow'` 内、`decision.kind === 'hide'` 之前
 *      —— hide / prompt 分支根本执行不到它。
 *
 * 行为级断言（拦不拦、重入、三态结果）在 `office-quit.spec.ts`；这里只钉"接线有没有被改坏"。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const windowSource = readFileSync(new URL('../window.ts', import.meta.url), 'utf8')
const windowCloseSource = readFileSync(new URL('../window-close.ts', import.meta.url), 'utf8')
const quitSource = readFileSync(new URL('../office-quit.ts', import.meta.url), 'utf8')

describe('S5-1 接线：before-quit 入口（index.ts）', () => {
  it('before-quit 只挂 guard；旧的直挂 markQuitting 已撤，更新安装那一路保持原样', () => {
    expect(indexSource).toContain("app.on('before-quit', quitGuard.handleBeforeQuit)")
    expect(indexSource).not.toContain("app.on('before-quit', markQuitting)")
    // 只允许这一处 before-quit 订阅（多一处就是绕过 guard 的旁路）；按行首锚定，排除注释里的示例
    expect(indexSource.match(/^ *app\.on\('before-quit'/gm) ?? []).toHaveLength(1)
    // 更新安装（quitAndInstall）那条真事件：原样保留（见 index.ts 的长注释与 window-close-wiring）
    expect(indexSource).toContain("autoUpdater?.on('before-quit-for-update', markQuitting)")
  })

  it('index.ts 里没有"直接立标记"的调用：标记只能由真事件与 guard 的放行分支触发', () => {
    // 只以引用形式传给 guard（`markQuitting,`）——不允许出现 markQuitting() 调用
    expect(indexSource).not.toMatch(/markQuitting\(\)/)
    expect(indexSource).toContain('markQuitting,\n    isQuitting')
  })

  it('guard 的依赖齐全：quit-request 通道 + 退出 + 关窗 + 标记/现状查询', () => {
    expect(indexSource).toContain('createOfficeQuitGuard({')
    // 发给壳的通道是 office:quit-request（owner = 最后一次上报脏计数的 webContents）
    expect(indexSource).toContain('IPC_CHANNELS.office.quitRequest')
    expect(indexSource).toContain('webContents.fromId(ownerId)')
    expect(indexSource).toContain('quit: () => app.quit()')
    // close 入口收尾按 owner 现找窗口（不持窗口引用）
    expect(indexSource).toContain('BrowserWindow.fromWebContents(contents)')
    expect(indexSource).toContain('.close()')
  })
})

describe('S5-1 接线：两条入口的注册（index.ts）', () => {
  it('whenReady 里注册两条 invoke 通道 + 窗口 close 的 allow 守卫', () => {
    expect(indexSource).toContain('registerOfficeQuitIpc(quitGuard, ipcMain)')
    expect(indexSource).toContain(
      'registerCloseAllowGuard((event) => quitGuard.guardCloseAllow(event))'
    )
  })
})

describe('S5-1 接线：markQuitting 的唯一落点（office-quit.ts）', () => {
  it('全文件只有一处 deps.markQuitting() 调用，它就在放行收口 markAllowedQuit 里', () => {
    // 真实调用只有一处（注释与接口声明里的 `markQuitting()` 字样不算）
    expect(quitSource.match(/deps\.markQuitting\(\)/g) ?? []).toHaveLength(1)
    // 放行收口只有两个调用点：① before-quit 时脏计数为 0；② 壳回 saved / discarded
    expect(quitSource.match(/markAllowedQuit\(\)/g) ?? []).toHaveLength(2)
    const funnelAt = quitSource.indexOf('const markAllowedQuit = (): void => {')
    const callAt = quitSource.indexOf('deps.markQuitting()')
    expect(funnelAt).toBeGreaterThan(-1)
    expect(callAt).toBeGreaterThan(funnelAt)
  })

  it('settle 里：取消分支在(标记)放行分支之前 return（取消绝不立标记）', () => {
    const settleAt = quitSource.indexOf('settle: (senderId, response) =>')
    const cancelledAt = quitSource.indexOf("response.action === 'cancelled'", settleAt)
    // settle 内第一次出现放行收口调用，必然在 saved / discarded 分支（取消分支已 return）
    const markAt = quitSource.indexOf('markAllowedQuit()', settleAt)
    expect(settleAt).toBeGreaterThan(-1)
    expect(cancelledAt).toBeGreaterThan(settleAt)
    expect(markAt).toBeGreaterThan(cancelledAt)
  })

  it("before-quit 只在 dirty>0 时 ask：dirty===0 的分支在 ask('quit') 之前", () => {
    const handlerAt = quitSource.indexOf('handleBeforeQuit:')
    const cleanAt = quitSource.indexOf('if (dirty === 0)', handlerAt)
    const askAt = quitSource.indexOf("ask('quit')", handlerAt)
    expect(handlerAt).toBeGreaterThan(-1)
    expect(cleanAt).toBeGreaterThan(handlerAt)
    expect(askAt).toBeGreaterThan(cleanAt)
  })

  it("quitDecisionPending（phase==='asking'）防重入：两个入口各一处", () => {
    expect(quitSource.match(/if \(phase === 'asking'\)/g) ?? []).toHaveLength(2)
  })
})

describe('S5-1 接线：纯状态机边界（office-quit.ts）', () => {
  it('不 import electron（可在纯 node 单测里直接驱动），也不与更新安装路径耦合', () => {
    expect(quitSource).not.toContain("from 'electron'")
    expect(quitSource).not.toContain('updater')
    // 入参闸门走共享 helper；通道名来自 shared 合同
    expect(quitSource).toContain('parseIpcArgs')
    expect(quitSource).toContain('IPC_CHANNELS.office.dirtyState')
    expect(quitSource).toContain('IPC_CHANNELS.office.quitResult')
  })

  it('window-close-wiring 的既有语义不受影响：真退出事件标记仍在 window.ts（session-end 唯一一处）', () => {
    expect(windowSource).toContain("win.on('session-end', () => markQuitting())")
    expect(windowSource).not.toContain("win.on('query-session-end'")
  })
})

describe('S5-1 接线：window-close.ts 的 allow 分支守卫', () => {
  it('allowGuard 在 allow 分支内执行；位置在 hide 分支之前（hide / prompt 走不到它）', () => {
    expect(windowCloseSource).toContain('registerCloseAllowGuard')
    expect(windowCloseSource).toContain('options.allowGuard ?? registeredAllowGuard')
    const allowAt = windowCloseSource.indexOf("decision.kind === 'allow'")
    const guardAt = windowCloseSource.indexOf('const allowGuard')
    const hideAt = windowCloseSource.indexOf("decision.kind === 'hide'")
    expect(allowAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(allowAt)
    expect(hideAt).toBeGreaterThan(guardAt)
  })

  it('模块级注册表默认不拦截（没接线时保持 0.1.3 原行为）', () => {
    expect(windowCloseSource).toContain('let registeredAllowGuard: CloseAllowGuard | null = null')
    expect(windowCloseSource).toContain('if (allowGuard !== null && allowGuard(event)) return')
  })
})
