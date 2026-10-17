import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyPrewarmDataset, buildFontPrewarmUrl } from '../office-font-prewarm'
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
const surfaceBootTsx = read('../../../office/SurfaceBoot.tsx')
const rendererMainTsx = read('../../../main.tsx')

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
  it('renderer 入口在首屏后排 idle 预热（不等 Office 打开）', () => {
    expect(rendererMainTsx).toContain(
      "import { scheduleOfficeFontPrewarm } from './features/office/office-font-prewarm'"
    )
    expect(rendererMainTsx).toContain('scheduleOfficeFontPrewarm()')
    // 在 start() 之后（首屏提交后）调用
    expect(rendererMainTsx.indexOf('scheduleOfficeFontPrewarm()')).toBeGreaterThan(
      rendererMainTsx.indexOf('start()')
    )
    expect(prewarmTs).toContain('requestIdleCallback')
    expect(prewarmTs).toContain('PREWARM_DELAY_MS')
  })

  it('预热面：hidden 1px / aria-hidden / pointer-events:none，不抢焦点不占布局', () => {
    expect(prewarmTs).toContain('position:fixed;left:-10000px;top:-10000px;width:1px;height:1px')
    expect(prewarmTs).toContain('opacity:0;pointer-events:none')
    expect(prewarmTs).toContain("setAttribute('aria-hidden', 'true')")
    expect(prewarmTs).toContain("setAttribute('tabindex', '-1')")
    expect(prewarmTs).toContain('office-font-prewarm-frame')
    // 用完释放 iframe（HTTP cache 留 session），不让隐藏面常驻内存
    expect(prewarmTs).toContain('frame.remove()')
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
