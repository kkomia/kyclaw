import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * splash · v4-pixel 内联 SVG 契约（task-96），以及 2026-10-18「状态海獭同步 v4-pixel」后的
 * 旧 v5 sprite sheet 退场断言。
 *
 * 状态灯（输入卡右上角）的运行时/资产契约见 `pixel-otter.spec.tsx`；这里只钉 splash 本体
 * 与「旧 32×32 sheet 资产/挑档模块已删」这两件事（避免回退时把 34 个 PNG 又带回来）。
 *
 * 路径用仓库根相对解析（vitest 从仓库根跑；jsdom 里的 URL 不是 Node 的 file: 实现，
 * 用 readdirSync(URL) 会报 "URL must be of scheme file"）。
 */
const REPO_ROOT = process.cwd()
const INDEX_PATH = resolve(REPO_ROOT, 'src/renderer/index.html')
const INDEX_HTML = readFileSync(INDEX_PATH, 'utf8')

describe('splash · v4-pixel 内联 SVG（index.html，task-96）', () => {
  it('结构：otter 容器 + animated/static 两个 inline SVG，aria-hidden 装饰', () => {
    expect(INDEX_HTML).toContain('<div class="app-splash__otter" aria-hidden="true">')
    expect(INDEX_HTML).toContain('class="app-splash__otter--animated"')
    expect(INDEX_HTML).toContain('class="app-splash__otter--static"')
    // v5 sprite-sheet 的两张 @4x PNG 已退场
    expect(INDEX_HTML).not.toContain('app-splash__otter-frame')
    expect(INDEX_HTML).not.toContain('data:image/png;base64,')
  })

  it('尺寸/字节：48 栅格 viewBox、显示 128；index.html 预算 ≤ 28KB（比两张 base64 PNG 省请求）', () => {
    const svgs = INDEX_HTML.match(/<svg[\s\S]*?<\/svg>/g) ?? []
    expect(svgs).toHaveLength(2)
    for (const svg of svgs) {
      expect(svg).toContain('viewBox="0 0 48 48"')
      expect(svg).toContain('width="128"')
      expect(svg).toContain('height="128"')
      expect(svg).toContain('shape-rendering="crispEdges"')
    }
    const animated = svgs.find((svg) => (svg.match(/<g transform=/g) ?? []).length === 3)
    const staticFrame = svgs.find((svg) => (svg.match(/<g transform=/g) ?? []).length === 1)
    expect(animated, '缺 3 帧 animated SVG').toBeTruthy()
    expect(staticFrame, '缺单帧 static SVG').toBeTruthy()
    // 设计资产：animated 9,081 B / static 3,725 B（strip 内联部分 7,667 / 2,646 字符）
    expect(animated?.length ?? 0).toBeGreaterThan(7000)
    expect(staticFrame?.length ?? 0).toBeGreaterThan(2500)
    expect(statSync(INDEX_PATH).size).toBeLessThan(28 * 1024)
  })

  it('零请求：全部 inline SVG；无 data URI 图片、无外链字体/图片、无 @import', () => {
    expect(INDEX_HTML).not.toMatch(/url\(\s*['"]?https?:/i)
    expect(INDEX_HTML).not.toMatch(/<img[^>]+src=["']https?:/i)
    expect(INDEX_HTML).not.toContain('@import')
    expect(INDEX_HTML).not.toContain('data:font')
  })

  it('动效：4s steps(1,end) sprite 整数位移；reduced 切静态帧 A（不隐藏）', () => {
    expect(INDEX_HTML).toContain('animation: app-splash-otter-frames 4s steps(1, end) infinite')
    expect(INDEX_HTML).toContain('translateX(-48px)')
    expect(INDEX_HTML).toContain('translateX(-96px)')
    // 静态帧在有 reduced 时显示、animated 隐藏（不是把海獭整体隐藏）
    expect(INDEX_HTML).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?svg\.app-splash__otter--animated \{\s*display: none;/
    )
    expect(INDEX_HTML).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?svg\.app-splash__otter--static \{\s*display: block;/
    )
  })

  it('浅深：同一份 SVG 只换 --om-* 变量（跟随 prefers-color-scheme，无 sheet 换载空窗）', () => {
    expect(INDEX_HTML).toContain('--om-page: #ffffff')
    expect(INDEX_HTML).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*?\.app-splash__otter \{[\s\S]*?--om-page: #1e1e1d/
    )
    expect((INDEX_HTML.match(/class="app-splash__otter"/g) ?? []).length).toBe(1)
  })

  it('沿用现有 splash 离场逻辑（id/leaving/阶段推进标记不动），旧 Kimi 蓝 mark 退场', () => {
    expect(INDEX_HTML).toContain('id="app-splash"')
    expect(INDEX_HTML).toContain('#app-splash.is-leaving')
    expect(INDEX_HTML).toContain('data-startup-percent="20"')
    expect(INDEX_HTML).not.toContain('app-splash__mark')
    expect(INDEX_HTML).not.toContain('#2588f7')
  })
})

describe('旧 v5 sprite sheet 资产退场（2026-10-18 状态海獭换 v4-pixel）', () => {
  it('assets/pixel-otter（34 PNG + manifest）已删，挑档模块已删', () => {
    expect(existsSync(resolve(REPO_ROOT, 'src/renderer/src/assets/pixel-otter'))).toBe(false)
    expect(
      existsSync(resolve(REPO_ROOT, 'src/renderer/src/features/brand/pixel-otter-sheets.ts'))
    ).toBe(false)
  })

  it('新资产三态在 otter-v4/ 下：32 栅格、3/4 帧、无位图', () => {
    for (const state of ['idle', 'think', 'type'] as const) {
      const raw = readFileSync(
        resolve(REPO_ROOT, `src/renderer/src/features/brand/otter-v4/chat-${state}.svg`),
        'utf8'
      )
      expect(raw).toContain('viewBox="0 0 32 32"')
      expect(raw).toContain('class="pixel-otter-strip"')
      expect(raw).not.toContain('<image')
      expect(raw).not.toContain('base64')
    }
  })
})
