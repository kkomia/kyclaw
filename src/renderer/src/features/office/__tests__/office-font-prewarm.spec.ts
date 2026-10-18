import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  applyPrewarmDataset,
  buildFontPrewarmUrl,
  isOfficeUsed,
  markOfficeUsed,
  OFFICE_USED_STORAGE_KEY,
  scheduleOfficeFontPrewarm
} from '../office-font-prewarm'
import { isSurfaceFontsReady } from '../../../office/font-prewarm-protocol'

/**
 * task-76 · Office 字体启动预注册契约。
 *
 * 用户口径：「字体注册要在整个产品启动时就做预注册，不要等打开的时候再注册 拖慢速度」。
 * 现状（改前）：`SurfaceBoot` 等首个 `doc:open` 才 `ensureSurfaceFonts()`（22 面/46 注册/27MB，
 * spike 2.05–2.58s，串在「打开文档 → 可编辑」之间）。
 * 改后：产品启动后 idle 建 hidden 预热面（`?officePrewarm=1`）注册字体 → 同 session HTTP cache；
 * 真实面挂载即开始注册（不等 doc），壳释放预热 iframe。这里钉纯函数 + 源码契约。
 */
function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const prewarmTs = read('../office-font-prewarm.ts')
const protocolTs = read('../../../office/font-prewarm-protocol.ts')
const bridgeProtocolTs = read('../../../office/bridge-protocol.ts')
const surfaceBootTsx = read('../../../office/SurfaceBoot.tsx')
const rendererMainTsx = read('../../../main.tsx')
const officeSurfaceTsx = read('../OfficeSurface.tsx')

describe('字体预注册：URL / dataset 纯函数', () => {
  it('预热面 URL = 正常 surface URL + officePrewarm=1（保留原 query）', () => {
    expect(buildFontPrewarmUrl('kyclaw-office://surface/')).toBe(
      'kyclaw-office://surface/?officePrewarm=1'
    )
    expect(buildFontPrewarmUrl('http://localhost:5173/office.html?officeDebug=1')).toContain(
      'officePrewarm=1'
    )
    expect(buildFontPrewarmUrl('http://localhost:5173/office.html?officeDebug=1')).toContain(
      'officeDebug=1'
    )
  })

  it('数据集：loading/ready/error/skipped + ready 时有耗时/字节/注册数（探针只读 dataset）', () => {
    const root = { dataset: {} as DOMStringMap }
    applyPrewarmDataset(root, 'loading')
    expect(root.dataset.officeFontPrewarm).toBe('loading')
    applyPrewarmDataset(root, 'ready', {
      fetchedBytes: 27_380_000,
      registrations: 46,
      elapsedMs: 1234.6
    })
    expect(root.dataset.officeFontPrewarm).toBe('ready')
    expect(root.dataset.officeFontPrewarmMs).toBe('1235')
    expect(root.dataset.officeFontPrewarmBytes).toBe('27380000')
    expect(root.dataset.officeFontPrewarmRegistrations).toBe('46')
    applyPrewarmDataset(root, 'error')
    expect(root.dataset.officeFontPrewarm).toBe('error')
  })
})

describe('字体预注册：消息协议守卫', () => {
  const valid = {
    type: 'surface:fonts-ready',
    prewarm: true,
    elapsedMs: 1000,
    stats: { faces: 22, registrations: 46, fetchedBytes: 27_380_000, ms: 990 }
  }

  it('合法 fonts-ready 通过；类型/字段不对拒绝', () => {
    expect(isSurfaceFontsReady(valid)).toBe(true)
    expect(isSurfaceFontsReady({ ...valid, type: 'surface:ready' })).toBe(false)
    expect(isSurfaceFontsReady({ ...valid, prewarm: 'yes' })).toBe(false)
    expect(isSurfaceFontsReady({ ...valid, stats: { faces: 22 } })).toBe(false)
    expect(isSurfaceFontsReady(null)).toBe(false)
    expect(isSurfaceFontsReady('surface:fonts-ready')).toBe(false)
  })
})

describe('字体预注册：启动接线与面侧行为（源码契约）', () => {
  it('renderer 入口在**启动阶段**预热（initTheme 后、不等 idle，与首屏并行；task-100）', () => {
    expect(rendererMainTsx).toContain(
      "import { scheduleOfficeFontPrewarm } from './features/office/office-font-prewarm'"
    )
    expect(rendererMainTsx).toContain('scheduleOfficeFontPrewarm()')
    // 在 initTheme() 之后、start() 之前调度：启动阶段就并行，不再等「首屏提交后 idle」
    expect(rendererMainTsx.indexOf('scheduleOfficeFontPrewarm()')).toBeGreaterThan(
      rendererMainTsx.indexOf('initTheme()')
    )
    expect(rendererMainTsx.indexOf('scheduleOfficeFontPrewarm()')).toBeLessThan(
      rendererMainTsx.indexOf('start()')
    )
    // 首帧让位（rAF 一次）后立刻开始：不再有 idle 长延迟
    expect(prewarmTs).toContain('requestAnimationFrame')
    expect(prewarmTs).not.toContain('requestIdleCallback')
    expect(prewarmTs).not.toContain('const PREWARM_DELAY_MS')
  })

  it('预热面：hidden host（off-screen + display:none）/ sandbox 同口径 / 升格前不被销毁', () => {
    // task-101：iframe 挪进 off-screen hidden host（升格时期望被复用，不能 reparent）
    expect(prewarmTs).toContain('office-font-prewarm-host')
    expect(prewarmTs).toContain(
      'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;display:none'
    )
    expect(prewarmTs).toContain("setAttribute('aria-hidden', 'true')")
    expect(prewarmTs).toContain("setAttribute('tabindex', '-1')")
    // 复用不降低隔离口径：预热 iframe 也带与真实文档面相同的 sandbox
    expect(prewarmTs).toContain("setAttribute('sandbox', 'allow-scripts allow-same-origin')")
    expect(prewarmTs).toContain('office-font-prewarm-frame')
    // 升格 API：取走 / 归还；空闲 60s 才释放（给首个文档打开留窗口），被升格时不能被定时器删掉
    expect(prewarmTs).toContain('takePrewarmedSurface')
    expect(prewarmTs).toContain('releasePrewarmedSurface')
    expect(prewarmTs).toContain('prewarmAdopted')
    expect(prewarmTs).toContain('scheduleDispose(60_000)')
  })

  it('升格复用：预热面隐藏期完成握手、OfficeSurface 沿用 nonce（不再等 5s hello 窗口），iframe 覆盖内容区', () => {
    expect(officeSurfaceTsx).toContain('takePrewarmedSurface()')
    expect(officeSurfaceTsx).toContain('releasePrewarmedSurface()')
    // 复用时不重设 src（重设 = 重载文档 = 白复用）
    // 复用时不重设 src（重设 = 重载文档 = 白复用）；自建 iframe 用独立 ref，避免卸载时把升格面清掉
    expect(officeSurfaceTsx).toContain('if (prewarmed === null) {')
    expect(officeSurfaceTsx).toContain('ownIframeRef')
    expect(officeSurfaceTsx).toContain("prewarmed.frame.dataset.testid = 'office-surface-iframe'")
    expect(officeSurfaceTsx).toContain('prewarmed.nonce')
    // 预热模块在隐藏期自己完成 hello→init，并把 nonce 交给升格方
    expect(prewarmTs).toContain("type: 'surface:init'")
    expect(prewarmTs).toContain('prewarmNonce')
    expect(prewarmTs).toContain('nonce: prewarmNonce')
    // 被升格过的预热面不能因其它真实面 ready 被提前销毁（否则归还后再复用失效）
    expect(prewarmTs).toContain('prewarmEverAdopted')
    // 观测点（dataset，不新增 IPC/权限）：升格/归还/释放 + 回退原因计数
    expect(prewarmTs).toContain('officePrewarmSurface')
    expect(prewarmTs).toContain('notePrewarmFallback')
    expect(prewarmTs).toContain('fallback:${reason}')
    expect(officeSurfaceTsx).toContain('notePrewarmFallback()')
    // 面侧仍需处理 hello-request（壳在极端时序下重发 hello 的兜底通道保留）
    expect(surfaceBootTsx).toContain('isSurfaceHelloRequest')
    expect(bridgeProtocolTs).toContain("type: 'surface:hello-request'")
  })

  it('面侧：挂载即注册字体（不再等 doc:open），并回 surface:fonts-ready（含 prewarm 标记）', () => {
    // 改前旧代码：if (doc === null || fontsStartedRef.current) return
    expect(surfaceBootTsx).not.toContain('if (doc === null || fontsStartedRef.current) return')
    expect(surfaceBootTsx).toContain('fontsStartedRef.current = true')
    expect(surfaceBootTsx).toContain("type: 'surface:fonts-ready'")
    expect(surfaceBootTsx).toContain('prewarm,')
    expect(surfaceBootTsx).toContain("has('officePrewarm')")
    // 协议字段在专门的协议文件里（不经 src/shared IPC 契约）
    expect(protocolTs).toContain("type: 'surface:fonts-ready'")
    expect(protocolTs).toContain('elapsedMs')
  })
})

describe('P0-2 / P0-5：升格面定位不再 rAF 空转 + 字体预热门控', () => {
  it('P0-2：OfficeSurface 升格定位用事件驱动（无 requestAnimationFrame 循环）', () => {
    // rAF 循环已移除；改用 ResizeObserver / IntersectionObserver / visibilitychange 事件
    expect(officeSurfaceTsx).not.toContain('requestAnimationFrame')
    expect(officeSurfaceTsx).toContain('new ResizeObserver(sync)')
    expect(officeSurfaceTsx).toContain('new IntersectionObserver(sync')
    expect(officeSurfaceTsx).toContain("document.addEventListener('visibilitychange'")
  })

  it('PB-017：取消 12s 门控——启动就排队预热，office-used 只留观测语义', () => {
    // 12s 门控与延后调度已删除（源码契约，防回潮）
    expect(prewarmTs).not.toContain('NEVER_USED_PREWARM_DELAY_MS')
    expect(prewarmTs).not.toContain('prewarmDelayMs')
    expect(prewarmTs).not.toContain('officeFontPrewarmDeferred')
    expect(prewarmTs).not.toContain('deferredTimer')
    // CR-09：watcher 只记「用过」，不再同步 start（/office 深链也必须走统一调度）
    expect(prewarmTs).not.toContain('if (!started) startOfficeFontPrewarm()')
    // CR-10：rAF 之外有固定 500ms 定时器兜底（隐藏窗口 rAF 不跑也能起）
    expect(prewarmTs).toContain('setTimeout(run, 500)')
    // R2-01：起预热前先看**真实 paint 记录**（不是「两帧 rAF」近似）
    expect(prewarmTs).toContain('waitPaint')
    expect(prewarmTs).toContain("getEntriesByType('paint')")
    // CR-11：失败有界重试 1 次（2s 退避）
    expect(prewarmTs).toContain('retried')
    expect(prewarmTs).toContain('2_000')
    // office-used 标记保留（观测/深链标记），但 schedule 不再读它做门控
    expect(prewarmTs).toContain(OFFICE_USED_STORAGE_KEY)
    expect(prewarmTs).toContain('installOfficeUsedWatcher')
    expect(prewarmTs).toContain('hashchange')
  })

  it('CR-09/10：启动即深链 /office 不绕过调度；rAF 不跑时 500ms 定时器兜底起预热', async () => {
    window.location.hash = '#/office'
    const originalRaf = window.requestAnimationFrame
    // 模拟隐藏/后台窗口：rAF 永不回调
    window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame
    try {
      scheduleOfficeFontPrewarm()
      // CR-09：watcher 在 install 时同步跑，但只记标记——此刻不得出现预热面
      expect(document.querySelector('[data-testid="office-font-prewarm-host"]')).toBeNull()
      expect(window.localStorage.getItem(OFFICE_USED_STORAGE_KEY)).toBe('1')
      // CR-10：500ms 定时器兜底（不依赖 rAF/paint）
      await vi.waitFor(
        () => {
          expect(
            document.querySelector('[data-testid="office-font-prewarm-host"]')
          ).not.toBeNull()
        },
        { timeout: 2_000 }
      )
    } finally {
      window.requestAnimationFrame = originalRaf
      document
        .querySelectorAll('[data-testid="office-font-prewarm-host"]')
        .forEach((node) => node.remove())
      window.location.hash = ''
    }
  })

  it('P0-5：markOfficeUsed / isOfficeUsed 持久化（localStorage）', () => {
    window.localStorage.clear()
    expect(isOfficeUsed()).toBe(false)
    markOfficeUsed()
    expect(isOfficeUsed()).toBe(true)
    expect(window.localStorage.getItem(OFFICE_USED_STORAGE_KEY)).toBe('1')
    window.localStorage.clear()
    expect(isOfficeUsed()).toBe(false)
  })
})
