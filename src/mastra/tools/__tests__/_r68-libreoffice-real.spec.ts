// @vitest-environment node
/**
 * R68 探针 E：**随包 LibreOffice 渲染器真链路** —— 真起进程、真出页图、真与 PowerPoint 对比。
 *
 * 它回答三件在单测里证明不了的事（单测里 renderer 与 render 都是注入的假件）：
 *   ① `ELECTRON_RUN_AS_NODE=1 <electron> <cli.js>` 这条跑法到底通不通（不通就得像 dsh 那样
 *      再随包一个独立 node.exe，多背几十 MB）；
 *   ② `render_ppt` 走**真实现**（不注入 detect / render）能不能出页图、页数对不对、
 *      文件是不是页图目录里的新文件；
 *   ③ 同一份 deck 走 PowerPoint COM 出来的页图，页数与尺寸差多少（观感差异靠人看证据目录里的图）。
 *
 * 用法（真起进程、真渲染，约 20 秒）：
 *   KYCLAW_R68_KIT_REAL=1 pnpm exec vitest run src/mastra/tools/__tests__/_r68-libreoffice-real.spec.ts
 *
 * 证据落在 `.superpowers/sdd/2026-10-10-kyclaw-mvp/_r68-probe/_r68-libreoffice/`（不入库）。
 * 机器上没有 `resources/libreoffice-kit`（没跑过 `pnpm fetch:libreoffice-kit`）时整组跳过。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderPptx } from '../ppt'
import {
  createRenderPptTool,
  detectRenderer,
  resolveKitCli,
  resetRendererCache
} from '../render-ppt'
import { callTool, createBed } from './helpers'

const enabled = process.env.KYCLAW_R68_KIT_REAL === '1'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(
  repoRoot,
  '.superpowers',
  'sdd',
  '2026-10-10-kyclaw-mvp',
  '_r68-probe',
  '_r68-libreoffice'
)
/** Electron 自带的那个可执行文件（打包态里它是 kyclaw.exe —— 同一个 `process.execPath` 位置） */
const electronExe = join(
  repoRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

/** 装出来的应用里的 resources/（`pnpm build:unpack` 之后指过来，验打包态路径解析） */
const packagedResources = process.env.KYCLAW_R68_KIT_PACKAGED

const kitCli = resolveKitCli()
const canRun = enabled && kitCli !== null && existsSync(electronExe)

/** 用产出物自己的生成器造一份真 pptx（6 页，含中文与数字，与单测同一形状） */
async function buildDeck(path: string): Promise<number> {
  const deck = await renderPptx({
    title: '随包渲染器探针',
    slides: [
      { title: '封面', bullets: ['随包 LibreOffice 渲染器探针', 'round 68'] },
      { title: '国内要闻', bullets: ['PSL 利率下调 0.25 个百分点', '新能源车销量 182.3 万辆'] },
      { title: '关键指标', stats: [{ value: '182.3 万辆', label: '9 月新能源车销量' }] },
      { title: '风险提示', bullets: ['数据口径以官方发布为准'] }
    ]
  })
  writeFileSync(path, deck.data)
  return deck.slides
}

describe.skipIf(!canRun)('随包 LibreOffice 渲染器（真链路探针）', () => {
  it('① ELECTRON_RUN_AS_NODE 跑得起来：capabilities --json 回 native 后端（不需要独立 node.exe）', () => {
    const result = spawnSync(electronExe, [kitCli as string, 'capabilities', '--json'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 120_000
    })
    console.log('[probe] electron:', electronExe)
    console.log('[probe] cli:', kitCli)
    // 这一行是"跑在哪个宿主里"的证据：vitest 自己也可能跑在 electron-as-node 里
    console.log('[probe] host execPath:', process.execPath, 'electron:', process.versions.electron)
    console.log('[probe] exit:', result.status)
    console.log('[probe] stdout:', String(result.stdout).slice(0, 600))
    console.log('[probe] stderr:', String(result.stderr).slice(0, 600))

    expect(result.status).toBe(0)
    const capabilities = JSON.parse(String(result.stdout)) as {
      runtime: { version: string; backend: string }
    }
    expect(capabilities.runtime.backend).toBe('native')
    expect(capabilities.runtime.version).toBe('0.1.5')
  })

  it('② render_ppt 走真实现（不注入 detect/render）：出页图、页数对、落在派生的页图目录', async () => {
    const bed = createBed({ mode: 'full' })
    mkdirSync(evidenceDir, { recursive: true })
    try {
      const slides = await buildDeck(join(bed.root, '探针.pptx'))

      resetRendererCache()
      // round 77 起 Windows 上本机 COM 是第一优先级：这条探针要证的**是 kit 那条路**，
      // 所以显式声明"本机没有 Office/WPS"（不给这个注入，装了 WPS 的机器上就会判成 powerpoint）。
      const detected = detectRenderer({ localOffice: () => false })
      console.log('[probe] detectRenderer(localOffice=false) =', detected)
      expect(detected).toBe('libreoffice')

      const tool = await createRenderPptTool(bed.ctx, { localOffice: () => false })
      const result = (await callTool(tool, { path: '探针.pptx' })) as {
        renderer: string
        dir: string
        pages: Array<{ index: number; path: string; abs: string; bytes: number }>
        attached: number[]
        message: string
      }

      console.log('[probe] renderer =', result.renderer)
      console.log('[probe] dir =', result.dir)
      console.log(
        '[probe] pages =',
        result.pages.map((page) => `${page.index}:${page.bytes}B`).join(' ')
      )
      console.log('[probe] message head:', result.message.split('\n').slice(0, 2).join(' | '))

      expect(result.renderer).toBe('libreoffice')
      expect(result.dir).toBe('探针_页图')
      expect(result.pages).toHaveLength(slides)
      expect(result.pages.map((page) => page.index)).toEqual(
        Array.from({ length: slides }, (_unused, index) => index + 1)
      )
      // 真 PNG（不是空文件）：每页都得有几十 KB 量级
      for (const page of result.pages) expect(page.bytes).toBeGreaterThan(4_000)
      // 回执里报的是**实测**尺寸，不是 COM 那条路的 1600×900
      expect(result.message).toMatch(/已渲染 \d+ 页（\d+×\d+）/)

      // 证据：首页页图 + 回执（人目检用）
      copyFileSync(result.pages[0]?.abs as string, join(evidenceDir, 'kit-page-0001.png'))
      writeFileSync(join(evidenceDir, 'kit-message.txt'), result.message, 'utf8')
    } finally {
      bed.dispose()
    }
  }, 240_000)

  it('③ 同一份 deck 走 PowerPoint COM：页数一致、尺寸是 Export 定死的 1600×900', async () => {
    const bed = createBed({ mode: 'full' })
    mkdirSync(evidenceDir, { recursive: true })
    try {
      const slides = await buildDeck(join(bed.root, '探针.pptx'))
      // 只硬指 detect（这台机器上 PowerPoint 装在哪由它自己扫），render 走真实现 = PowerShell COM
      const tool = await createRenderPptTool(bed.ctx, { detect: () => 'powerpoint' })
      const result = (await callTool(tool, { path: '探针.pptx' })) as {
        renderer: string
        pages: Array<{ index: number; abs: string; bytes: number }>
        message: string
      }

      console.log('[probe] COM pages =', result.pages.length, 'renderer =', result.renderer)
      expect(result.renderer).toBe('powerpoint')
      expect(result.pages).toHaveLength(slides)
      expect(result.message).toContain('1600×900')
      copyFileSync(result.pages[0]?.abs as string, join(evidenceDir, 'com-page-0001.png'))
    } finally {
      bed.dispose()
    }
  }, 240_000)
})

describe.skipIf(!enabled || packagedResources === undefined)(
  '打包态：extraResources 落位的 kit 能被探测到（不用真装一次）',
  () => {
    it('把 process.resourcesPath 指到装出来的 resources/ 时，任何平台都认它是渲染器', () => {
      const before = process.resourcesPath
      Object.defineProperty(process, 'resourcesPath', {
        value: packagedResources,
        configurable: true,
        writable: true
      })
      try {
        resetRendererCache()
        const cli = resolveKitCli()
        console.log('[probe] packaged resources =', packagedResources)
        console.log('[probe] packaged cli =', cli)
        expect(cli).toBe(
          join(
            packagedResources as string,
            'libreoffice-kit',
            'node_modules',
            '@deepseek-ai',
            'libreoffice-kit',
            'lib',
            'cli.js'
          )
        )
        // 打包态那一支排在开发态前面：cwd 还是仓库，也得先认 resourcesPath 里那份
        expect(detectRenderer({ platform: 'linux' })).toBe('libreoffice')
      } finally {
        Object.defineProperty(process, 'resourcesPath', {
          value: before,
          configurable: true,
          writable: true
        })
        resetRendererCache()
      }
    })
  }
)
