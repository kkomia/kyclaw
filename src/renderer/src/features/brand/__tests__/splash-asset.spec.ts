import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OTTER_STATES } from '../otter-states'

/**
 * 像素海獭资产 · splash 内联与预算契约（v5 / task-72；设计稿 §5.1/§5.5/§7.1）。
 *
 * v5 = **32×32 栅格**（尺寸体系不变：32/64/96/128/192/256/512，最小 32）：
 * 去狗感（短须/小耳/圆脸）、胡须随头动（生成器逐帧 dy；产品消费 sprite sheet PNG，SVG 仅在
 * 设计文档/预览里，v5 已同步 32 viewBox）、去抱石（前爪并拢浮水 + 水面 + 尾卷）。
 * 子集 launch-v2：35 文件（34 资产 + manifest）45,919 B；splash 用 data URI 内联（首屏零请求）、
 * 无外链、reduced-motion 静态、旧 Kimi 蓝 mark 已退场。
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
  grid: number
  totalBytes: number
  fileCount: number
  usage: Record<string, { sizes: number[]; states: string[] }>
  states: Record<string, { frames: number; frameMs: number; reducedFrame: number; bytes: number }>
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

describe('像素海獭资产子集（v5 launch-v2，35 文件 45,919 B）', () => {
  it('v5 资产身份：manifest 栅格/目标目录/usage 对得上（设计方四处）', () => {
    // manifest 的 version/name 文案仍写着 v4（设计工具元数据；产品不消费，v5 内容按字节/帧规格钉）
    expect(MANIFEST.version).toContain('32×32')
    expect(MANIFEST.grid).toBe(32)
    expect(MANIFEST.target).toBe('src/renderer/src/assets/pixel-otter/')
    expect(MANIFEST.fileCount).toBe(34)
    expect(MANIFEST.totalBytes).toBe(38148)
    // 四处落点：splash / 输入卡右上角状态灯 / 欢迎页报头 / 初始页报头 lockup（32 栅格尺寸体系）
    for (const surface of ['splash', 'inputCard', 'welcomeLogo', 'headerLockup']) {
      expect(MANIFEST.usage[surface], `manifest 缺 ${surface}`).toBeTruthy()
    }
    expect(MANIFEST.usage.inputCard.sizes).toEqual([32])
    expect(MANIFEST.usage.welcomeLogo.sizes).toEqual([96, 128])
    expect(MANIFEST.usage.splash.sizes).toEqual([128, 256])
    // 状态帧规格（idle 8×120ms / loading 6×80ms / think 6×120 / type 4×80 / float 6×120 / wave 6×100）
    expect(MANIFEST.states.idle).toMatchObject({ frames: 8, frameMs: 120, reducedFrame: 0 })
    expect(MANIFEST.states.loading).toMatchObject({ frames: 6, frameMs: 80, reducedFrame: 0 })
    expect(MANIFEST.states.think).toMatchObject({ frames: 6, frameMs: 120, reducedFrame: 2 })
    // v5 每状态字节（office-planner 交付值；换装必须逐状态对得上）
    expect(MANIFEST.states.idle.bytes).toBe(2380)
    expect(MANIFEST.states.think.bytes).toBe(2016)
    expect(MANIFEST.states.type.bytes).toBe(1972)
    expect(MANIFEST.states.loading.bytes).toBe(9532)
    expect(MANIFEST.states.float.bytes).toBe(11675)
    expect(MANIFEST.states.wave.bytes).toBe(10573)
  })

  it('只含四处用到的 6 个状态 × 浅/深（不把全量 v5 资产塞进产品）', () => {
    const names = ASSETS.map((file) => file.path).join('\n')

    for (const state of Object.keys(OTTER_STATES)) {
      expect(names, `缺 ${state} 的浅/深资产`).toContain(`sheets/light/otter-${state}`)
      expect(names, `缺 ${state} 的浅/深资产`).toContain(`sheets/dark/otter-${state}`)
    }
    // 未接的状态不进产品
    for (const excluded of ['idle-rare', 'success', 'error', 'sleep', 'hover', 'drag']) {
      expect(names).not.toContain(`otter-${excluded}`)
    }
    // 逐帧 PNG 不随包（都走 sheet + reduced 静态帧）
    expect(ASSETS.every((file) => !/frames\//.test(file.path))).toBe(true)
  })

  it('体积预算：≤ 48 KB（34 资产文件 38,148 B + manifest；设计稿实测 45,919 B）', () => {
    const assetsOnly = ASSETS.filter((file) => file.path !== 'manifest.json')
    const manifest = ASSETS.find((file) => file.path === 'manifest.json')
    const totalBytes = ASSETS.reduce((sum, file) => sum + file.bytes, 0)

    expect(ASSETS.length).toBe(35)
    expect(assetsOnly).toHaveLength(34)
    // 像素资产字节数必须与设计稿子集一致（新增/删帧会破坏预算）
    expect(assetsOnly.reduce((sum, file) => sum + file.bytes, 0)).toBe(38148)
    expect(manifest?.bytes ?? 0).toBeLessThanOrEqual(9 * 1024)
    expect(totalBytes).toBeLessThanOrEqual(48 * 1024)
  })

  it('浅/深 sprite 档位与 reduced 静态帧齐全（32 栅格：1x / @3x / @4x）', () => {
    const names = ASSETS.map((file) => file.path)
    // 输入卡状态灯 / headerLockup：1x（cell=32）
    expect(names).toContain('sheets/light/otter-idle.sheet.png')
    expect(names).toContain('sheets/light/otter-think.sheet.png')
    expect(names).toContain('sheets/dark/otter-type.sheet.png')
    // 欢迎页 logo：96 = @3x、128 = @4x（两档各一份）
    expect(names).toContain('sheets/light/otter-float.sheet@3x.png')
    expect(names).toContain('sheets/dark/otter-float.sheet@4x.png')
    expect(names).toContain('sheets/light/otter-wave.sheet@3x.png')
    expect(names).toContain('sheets/dark/otter-wave.sheet@4x.png')
    // splash：loading @4x（128 = 32×4）
    expect(names).toContain('sheets/light/otter-loading.sheet@4x.png')
    expect(names).toContain('sheets/dark/otter-loading.sheet@4x.png')
    // reduced 静态帧（stills）保留：设计交接单帧口径，运行时由 sheet 固定帧表达
    expect(names).toContain('stills/light/otter-think-32.png')
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
    // base64 两条 v5 loading sheet（@4x，6 帧 ×128）≈ 6.6 KB；index.html 总大小受控
    expect(statSync(INDEX_PATH).size).toBeLessThan(20 * 1024)
    expect(INDEX_HTML).not.toMatch(/url\(\s*['"]?https?:/i)
    expect(INDEX_HTML).not.toMatch(/<img[^>]+src=["']https?:/i)
    expect(INDEX_HTML).not.toContain('@import')
  })

  it('内联的是 v5 @4x loading sheet：768×128（6 帧 ×128）、字节数与 v5 资产一致', () => {
    const uris = INDEX_HTML.match(/url\('(data:image\/png;base64,[^']+)'\)/g) ?? []
    expect(uris).toHaveLength(2)
    const decodedSizes: number[] = []
    for (const uri of uris) {
      expect(pngSizeOf(uri)).toEqual({ width: 768, height: 128 })
      const base64 = uri.slice(uri.indexOf('base64,') + 'base64,'.length, -2)
      decodedSizes.push(Buffer.from(base64, 'base64').length)
    }
    // v5 是 2,461 / 2,457 B（v4 是 2,494/2,490 B）—— 换装后旧串必须已被替换
    expect(decodedSizes.sort()).toEqual([2457, 2461])
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

  it('v5：CSS 不再按落点写死尺寸（无 .chat-otter/.welcome-otter 覆写；尺寸只由 --otter-size 驱动）', () => {
    expect(OTTER_CSS).toContain('width: var(--otter-size)')
    expect(OTTER_CSS).not.toMatch(/\.chat-otter\s*\{/)
    expect(OTTER_CSS).not.toMatch(/\.welcome-otter\s*\{/)
    expect(OTTER_CSS).not.toContain('--otter-size: 24px')
  })
})
