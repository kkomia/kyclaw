import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OTTER_STATES } from '../otter-states'

/**
 * 像素海獭资产 · splash 内联与预算契约（rev3 / task-49；设计稿 §5.1/§5.5/§7.1）。
 *
 * 这里钉的是**文件级事实**（jsdom 测不到动画）：资产子集只含四处落点用到的 6 个状态、
 * splash 用 data URI 内联（首屏零请求）、无外链、reduced-motion 静态、旧 Kimi 蓝 mark 已退场。
 * 运行时逐帧行为见 `pixel-otter.spec.tsx`（组件 props/状态）与 `pixel-otter.css`（steps 契约，下方断言）。
 *
 * 路径用仓库根相对解析（vitest 从仓库根跑；jsdom 里的 URL 不是 Node 的 file: 实现，
 * 用 readdirSync(URL) 会报 "URL must be of scheme file"）。
 */
const REPO_ROOT = process.cwd()
const INDEX_PATH = resolve(REPO_ROOT, 'src/renderer/index.html')
const OTTER_CSS_PATH = resolve(REPO_ROOT, 'src/renderer/src/features/brand/pixel-otter.css')
const ASSET_ROOT = resolve(REPO_ROOT, 'src/renderer/src/assets/pixel-otter')

const INDEX_HTML = readFileSync(INDEX_PATH, 'utf8')
const OTTER_CSS = readFileSync(OTTER_CSS_PATH, 'utf8')
const MANIFEST = JSON.parse(readFileSync(resolve(ASSET_ROOT, 'manifest.json'), 'utf8')) as {
  version: string
  target: string
  totalBytes: number
  fileCount: number
  usage: Record<string, { sizes: number[]; states: string[] }>
  states: Record<string, { frames: number; frameMs: number; reducedFrame: number }>
}

/** 从 `url('data:image/png;base64,...')` 里解出 PNG 的宽高（IHDR 在固定偏移） */
function pngSizeOf(dataUri: string): { width: number; height: number } {
  const base64 = dataUri.slice(dataUri.indexOf('base64,') + 'base64,'.length)
  const buffer = Buffer.from(base64, 'base64')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

interface AssetFile {
  path: string
  bytes: number
}

function collectAssets(dir: string, prefix = ''): AssetFile[] {
  const files: AssetFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = resolve(dir, entry.name)
    const childPrefix = `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`
    if (entry.isDirectory()) files.push(...collectAssets(child, childPrefix))
    else files.push({ path: childPrefix, bytes: statSync(child).size })
  }
  return files
}

const ASSETS = collectAssets(ASSET_ROOT)

describe('像素海獭资产子集（rev3 launch-v1，43 文件 36,950 B）', () => {
  it('rev3 资产身份：manifest 版本/目标目录/四处 usage 都对得上', () => {
    expect(MANIFEST.version).toContain('rev3')
    expect(MANIFEST.target).toBe('src/renderer/src/assets/pixel-otter/')
    expect(MANIFEST.fileCount).toBe(42)
    expect(MANIFEST.totalBytes).toBe(28263)
    // 四处落点（v1 三处 + 初始页右上角氛围位）
    for (const surface of ['splash', 'chatHeader', 'welcomeLogo', 'ambientWelcome']) {
      expect(MANIFEST.usage[surface], `manifest 缺 ${surface}`).toBeTruthy()
    }
    expect(MANIFEST.usage.ambientWelcome.sizes).toEqual([24, 32])
    expect(MANIFEST.usage.ambientWelcome.states).toEqual(['idle'])
    // 状态帧规格（idle 8×120ms / loading 6×80ms / think 6×120 / type 4×80 / float 6×120 / wave 6×100）
    expect(MANIFEST.states.idle).toMatchObject({ frames: 8, frameMs: 120, reducedFrame: 0 })
    expect(MANIFEST.states.loading).toMatchObject({ frames: 6, frameMs: 80, reducedFrame: 0 })
    expect(MANIFEST.states.think).toMatchObject({ frames: 6, frameMs: 120, reducedFrame: 2 })
  })

  it('只含四处用到的 6 个状态 × 浅/深（不把全量 350 文件塞进产品）', () => {
    const names = ASSETS.map((file) => file.path).join('\n')

    for (const state of Object.keys(OTTER_STATES)) {
      expect(names, `缺 ${state} 的浅/深资产`).toContain(`sheets/light/otter-${state}`)
      expect(names, `缺 ${state} 的浅/深资产`).toContain(`sheets/dark/otter-${state}`)
    }
    // 未接的状态不进产品（v1 只允许四处）
    for (const excluded of ['idle-rare', 'success', 'error', 'sleep', 'hover', 'drag']) {
      expect(names).not.toContain(`otter-${excluded}`)
    }
    // 逐帧 PNG 不随包（都走 sheet + reduced 静态帧）
    expect(ASSETS.every((file) => !/frames\//.test(file.path))).toBe(true)
  })

  it('体积预算：≤ 37 KB（42 资产文件 28,263 B + manifest；设计稿实测 36,950 B）', () => {
    const assetsOnly = ASSETS.filter((file) => file.path !== 'manifest.json')
    const manifest = ASSETS.find((file) => file.path === 'manifest.json')
    const totalBytes = ASSETS.reduce((sum, file) => sum + file.bytes, 0)

    expect(ASSETS.length).toBe(43)
    expect(assetsOnly).toHaveLength(42)
    // 像素资产字节数必须与设计稿子集一致（新增/删帧会破坏预算）
    expect(assetsOnly.reduce((sum, file) => sum + file.bytes, 0)).toBe(28263)
    expect(manifest?.bytes ?? 0).toBeLessThanOrEqual(9 * 1024)
    expect(totalBytes).toBeLessThanOrEqual(37 * 1024)
  })

  it('浅/深 sprite 与 reduced 静态帧齐全（header 1x、welcome/splash @4x）', () => {
    const names = ASSETS.map((file) => file.path)
    expect(names).toContain('sheets/light/otter-idle.sheet.png')
    expect(names).toContain('sheets/light/otter-think.sheet@2x.png')
    expect(names).toContain('sheets/dark/otter-type.sheet@2x.png')
    expect(names).toContain('sheets/light/otter-loading.sheet@4x.png')
    expect(names).toContain('sheets/dark/otter-float.sheet@4x.png')
    expect(names).toContain('sheets/light/otter-wave.sheet@4x.png')
    // reduced 静态帧（stills）保留：设计交接单帧口径，运行时由 sheet 固定帧表达
    expect(names).toContain('stills/light/otter-think-24.png')
    expect(names).toContain('stills/dark/otter-loading-128.png')
  })
})

describe('splash · 内联海獭 loading（index.html）', () => {
  it('图像/结构：otter 容器 + 浅深两帧都在，aria-hidden 装饰', () => {
    expect(INDEX_HTML).toContain('<div class="app-splash__otter" aria-hidden="true">')
    expect(INDEX_HTML).toContain('app-splash__otter-frame--light')
    expect(INDEX_HTML).toContain('app-splash__otter-frame--dark')
  })

  it('零请求：sprite 用 data URI 内联（浅/深各一条），没有外链图片/字体', () => {
    const dataUris = INDEX_HTML.match(/data:image\/png;base64,/g) ?? []
    expect(dataUris.length).toBe(2)
    // base64 两条 loading sheet ≈ 4 KB（index.html 总大小受控）
    expect(statSync(INDEX_PATH).size).toBeLessThan(20 * 1024)
    expect(INDEX_HTML).not.toMatch(/url\(\s*['"]?https?:/i)
    expect(INDEX_HTML).not.toMatch(/<img[^>]+src=["']https?:/i)
    expect(INDEX_HTML).not.toContain('@import')
  })

  it('内联的是 rev3 @4x loading sheet：576×96（6 帧 ×96）、字节数与 rev3 资产一致', () => {
    const uris = INDEX_HTML.match(/url\('(data:image\/png;base64,[^']+)'\)/g) ?? []
    expect(uris).toHaveLength(2)
    const decodedSizes: number[] = []
    for (const uri of uris) {
      expect(pngSizeOf(uri)).toEqual({ width: 576, height: 96 })
      const base64 = uri.slice(uri.indexOf('base64,') + 'base64,'.length, -2)
      decodedSizes.push(Buffer.from(base64, 'base64').length)
    }
    // v1 是 1,459/1,460 B；rev3 是 1,514/1,528 B —— 换装后旧串必须已被替换
    expect(decodedSizes.sort()).toEqual([1514, 1528])
  })

  it('逐帧：6 帧 ×80ms steps(6) loop + 最近邻放大', () => {
    expect(INDEX_HTML).toContain('image-rendering: pixelated')
    expect(INDEX_HTML).toContain('animation: app-splash-otter 480ms steps(6) infinite')
    expect(INDEX_HTML).toContain('background-size: 768px 128px')
    expect(INDEX_HTML).toContain('@keyframes app-splash-otter')
  })

  it('reduced-motion：停动画（静态 reducedFrame #0），主题跟随 prefers-color-scheme', () => {
    expect(INDEX_HTML).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.app-splash__otter-frame \{\s*animation: none;/
    )
    expect(INDEX_HTML).toContain('@media (prefers-color-scheme: dark)')
  })

  it('沿用现有 splash 离场逻辑（id/leaving/阶段推进标记不动），旧 Kimi 蓝 mark 退场', () => {
    expect(INDEX_HTML).toContain('id="app-splash"')
    expect(INDEX_HTML).toContain('#app-splash.is-leaving')
    expect(INDEX_HTML).toContain('data-startup-percent="20"')
    expect(INDEX_HTML).not.toContain('app-splash__mark')
    expect(INDEX_HTML).not.toContain('#2588f7')
  })
})

describe('pixel-otter.css · 动效契约', () => {
  it('sprite + steps：逐帧跳、不补间；最近邻像素化', () => {
    expect(OTTER_CSS).toContain('image-rendering: pixelated')
    expect(OTTER_CSS).toContain('animation: var(--otter-animation, none)')
    for (const mask of ['steps(8)', 'steps(6)', 'steps(4)']) {
      expect(OTTER_CSS).toContain(mask)
    }
    expect(OTTER_CSS).toContain('@keyframes otter-frames-8')
    expect(OTTER_CSS).toContain('@keyframes otter-frames-6')
    expect(OTTER_CSS).toContain('@keyframes otter-frames-4')
  })

  it('装饰性：pointer-events:none（不挡按钮/不吞点击），不接收焦点', () => {
    expect(OTTER_CSS).toMatch(/\.pixel-otter \{[\s\S]*?pointer-events: none;/)
  })

  it('主题：浅/深两层按 :root[data-theme=dark] 切显隐', () => {
    expect(OTTER_CSS).toContain(":root[data-theme='dark'] .pixel-otter-sheet--light")
    expect(OTTER_CSS).toContain(":root[data-theme='dark'] .pixel-otter-sheet--dark")
  })

  it('不可见暂停：data-paused 用 animation-play-state（不重置帧）', () => {
    expect(OTTER_CSS).toMatch(
      /\.pixel-otter\[data-paused='true'\] \.pixel-otter-sheet \{\s*animation-play-state: paused;/
    )
  })

  it('reduced-motion：停动画并停在 manifest 的 reducedFrame（静态帧，不是隐藏）', () => {
    expect(OTTER_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pixel-otter-sheet \{\s*animation: none !important;[\s\S]*?background-position-x: calc\(-1 \* var\(--otter-reduced-frame, 0\) \* var\(--otter-size\)\)/
    )
  })

  it('响应式：header 32→24（<720 隐藏）；欢迎页 128→96', () => {
    expect(OTTER_CSS).toMatch(
      /@media \(max-width: 1279px\) \{[\s\S]*?\.chat-otter \{[\s\S]*?--otter-size: 24px/
    )
    expect(OTTER_CSS).toMatch(
      /@media \(max-width: 719px\) \{[\s\S]*?\.chat-otter \{\s*display: none;/
    )
    expect(OTTER_CSS).toMatch(
      /@media \(max-width: 1279px\) \{[\s\S]*?\.welcome-otter \{[\s\S]*?--otter-size: 96px/
    )
  })

  it('氛围位（rev3 第四落点）：内容列右缘内缩 12/8、32→24（<900）、<720 隐藏、150ms 淡出', () => {
    expect(OTTER_CSS).toMatch(
      /\.welcome-ambient-otter \{[\s\S]*?position: absolute;[\s\S]*?top: 12px;[\s\S]*?right: calc\(max\(0px, \(100% - var\(--content-max-width, 800px\)\) \/ 2\) \+ 12px\)/
    )
    expect(OTTER_CSS).toContain('transition: opacity var(--motion-reveal, 150ms)')
    expect(OTTER_CSS).toMatch(
      /@media \(max-width: 899px\) \{[\s\S]*?\.welcome-ambient-otter \{[\s\S]*?top: 8px;[\s\S]*?--otter-size: 24px/
    )
    expect(OTTER_CSS).toMatch(
      /@media \(max-width: 719px\) \{[\s\S]*?\.welcome-ambient-otter \{\s*display: none;/
    )
    expect(OTTER_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.welcome-ambient-otter \{\s*transition: none;/
    )
  })
})
