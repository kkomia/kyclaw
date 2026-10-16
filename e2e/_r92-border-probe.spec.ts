import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInteractiveApp, startInteractiveProvider } from './fixtures/interactive'

/**
 * R92 边框可见度探针（不进常规 e2e 闸门；只在 KYCLAW_BORDER_PROBE=1 时运行）：
 *
 *   pnpm build && KYCLAW_BORDER_PROBE=1 pnpm exec playwright test e2e/_r92-border-probe.spec.ts
 *
 * 用户口径（本轮反馈）：「整个系统的圆角边框在自然状态下颜色太浅，快看不出边框轮廓」。
 * 浅不浅只能看**画出来的像素**——所以在真 Electron 宿主里取窗口表面（`webContents.capturePage()`），
 * 按 CSS→设备像素的比例**横切扫过左边框**（-2 … +2 CSS px，步长 0.25；边框落在哪一枚设备像素上
 * 由取整决定，单点取样会漏），取最暗的那一枚当"边框像素"，两侧当"内侧/外侧底色"。
 *
 * 取样对象（覆盖三档语义色在各处的实际落点）：
 *   初始页     composer 输入卡（`--border-surface`）· capability 能力胶囊与 kbd 键帽（`--border-hairline`）
 *   设置页     field 表单控件（`--border-field`）· settings-card 圆角面板（`border-surface-border`）
 * 外加三档语义色的解析值（getComputedStyle）与浏览器算出来的 border-width —— 像素读数与 token 值
 * 对得上才算证据。
 *
 * 两遍取像（这是本探针的核心）：
 *   dpr-native  原生缩放（本机 2.25）：设计稿口径下边框本来长什么样；
 *   dpr-1       把 zoomFactor 打到 1/dpr（等效 1x 屏）：同一条边框在 1x 屏上落在几个设备像素、
 *               有多淡 —— 用户报"快看不出"时要先分清是**色浅**还是**线细**，两遍读数一比就知道。
 *               （2026-10-16 实测：0.5px 在两种缩放下都只占 1 个设备像素 —— 2.25x 下等于
 *               0.44 CSS px，细到几乎看不见；1x 下被抬到 1 CSS px，与 Kimi 实况同宽。
 *               这就是"用户说浅、量出来的颜色其实不比 Kimi 浅（#d3d3d3 ≥ #dedede）"的谜底。）
 *
 * 覆盖浅/深两档主题；截图落 `.superpowers/r92-borders/<时间戳>/`，用隔离实例（临时
 * userData / home / 工作区 + 本地 stub provider，不读凭据、不碰用户 profile）。
 */
const enabled = process.env.KYCLAW_BORDER_PROBE === '1'
const evidenceRoot = resolve('.superpowers/r92-borders')

const THEMES = ['light', 'dark'] as const

/** 初始页（输入卡 + 能力胶囊 + 左栏键帽） */
const HERO_TARGETS: Array<[string, string]> = [
  ['composer', '[data-testid="composer"]'],
  [
    'capability',
    '[data-testid^="composer-capability-"]:not([data-testid="composer-capability-row"])'
  ],
  ['kbd', 'kbd']
]

/** 设置页（表单控件 + 圆角面板） */
const SETTINGS_TARGETS: Array<[string, string]> = [
  ['field', '[class*="border-(--border-field)"]'],
  ['settings-card', '[class~="border-surface-border"][class~="rounded-panel"]']
]

interface Point {
  name: string
  x: number
  y: number
}

interface Reading {
  name: string
  x: number
  y: number
  hex: string
  rgb: string
}

interface BoxMeasurement {
  name: string
  missing: boolean
  left: number
  midY: number
  borderColor: string
  borderWidth: string
  backgroundColor: string
}

interface PageMeasurement {
  innerWidth: number
  devicePixelRatio: number
  vars: Record<string, string>
  boxes: BoxMeasurement[]
}

/** 取窗口表面 → 解码 → 按 CSS 坐标读像素（BGRA；比例由 位图宽 / 视口 CSS 宽 推出） */
async function samplePixels(
  app: Awaited<ReturnType<typeof createInteractiveApp>>,
  points: Point[],
  cssWidth: number
): Promise<Reading[]> {
  return app.app.evaluate(
    async ({ BrowserWindow, nativeImage }, payload) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('没有窗口')
      const image = await win.webContents.capturePage()
      const decoded = nativeImage.createFromBuffer(image.toPNG())
      const size = decoded.getSize()
      const bitmap = decoded.toBitmap()
      const scale = size.width / payload.cssWidth
      return payload.points.map(({ name, x, y }) => {
        const px = Math.min(size.width - 1, Math.max(0, Math.round(x * scale)))
        const py = Math.min(size.height - 1, Math.max(0, Math.round(y * scale)))
        const offset = (py * size.width + px) * 4
        const b = bitmap[offset] ?? 0
        const g = bitmap[offset + 1] ?? 0
        const r = bitmap[offset + 2] ?? 0
        const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
        return { name, x, y, hex, rgb: `rgb(${r}, ${g}, ${b})` }
      })
    },
    { points, cssWidth }
  )
}

const luminance = (hex: string): number => {
  const value = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [value >> 16, (value >> 8) & 255, value & 255]
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
}

test.describe('round 92 · 边框可见度读数', () => {
  test.skip(!enabled, '只在 KYCLAW_BORDER_PROBE=1 时运行（隔离实例取证，不进常规 e2e 闸门）')
  test.setTimeout(300_000)

  test('浅/深色 × 原生 dpr / 等效 1x：边框的实际像素 + 语义 token 值', async () => {
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    const page = app.page
    const outDir = join(evidenceRoot, `run-${Date.now()}`)
    mkdirSync(outDir, { recursive: true })

    /** 等某个元素的几何连续三次读数量到同一个值，再放两帧 + 一档快时长（残影教训，见 _r81-ui-layout-shots） */
    const settle = async (selector: string): Promise<void> => {
      await page.waitForFunction(
        (target) => {
          const el = document.querySelector(target)
          if (!(el instanceof HTMLElement)) return true
          const store = window as unknown as { __borderSettle?: { key: string; hits: number } }
          const rect = el.getBoundingClientRect()
          const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.height)}`
          const current = store.__borderSettle
          store.__borderSettle =
            current !== undefined && current.key === key
              ? { key, hits: current.hits + 1 }
              : { key, hits: 1 }
          return store.__borderSettle.hits >= 3
        },
        selector,
        { polling: 100, timeout: 15_000 }
      )
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
      await page.waitForTimeout(250)
    }

    const setTheme = async (theme: (typeof THEMES)[number]): Promise<void> => {
      await page.evaluate(async (next) => {
        if (!window.kyclaw) throw new Error('缺少生产桥')
        await window.kyclaw.settings.update({ theme: next })
      }, theme)
      await page.reload()
      // hash 会跟着 reload 活下来（上一遍可能停在设置页）——先回对话页再等输入卡
      await page.evaluate(() => {
        window.location.hash = '#/chat'
      })
      await page.getByTestId('composer-input').waitFor({ timeout: 30_000 })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? ''))
        .toBe(theme)
    }

    const setZoom = async (factor: number): Promise<void> => {
      await app.app.evaluate(({ BrowserWindow }, value) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) throw new Error('没有窗口')
        win.webContents.setZoomFactor(value)
      }, factor)
      await page.waitForTimeout(400)
    }

    /** 量几何与 token 解析值（取样前后各调一次，两次一致才认账） */
    const measurePage = (targets: Array<[string, string]>): Promise<PageMeasurement> =>
      page.evaluate((entries) => {
        const root = getComputedStyle(document.documentElement)
        const boxes = entries.map(([name, selector]) => {
          const el = document.querySelector(selector)
          const empty = {
            name,
            missing: true,
            left: 0,
            midY: 0,
            borderColor: '',
            borderWidth: '',
            backgroundColor: ''
          }
          if (!(el instanceof HTMLElement)) return empty
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return {
            name,
            missing: false,
            left: rect.left,
            midY: rect.top + rect.height / 2,
            borderColor: style.borderTopColor,
            borderWidth: style.borderTopWidth,
            backgroundColor: style.backgroundColor
          }
        })
        return {
          innerWidth: window.innerWidth,
          devicePixelRatio: window.devicePixelRatio,
          vars: {
            '--border-hairline': root.getPropertyValue('--border-hairline').trim(),
            '--border-surface': root.getPropertyValue('--border-surface').trim(),
            '--border-field': root.getPropertyValue('--border-field').trim(),
            '--hairline-width': root.getPropertyValue('--hairline-width').trim(),
            '--bg-canvas': root.getPropertyValue('--bg-canvas').trim(),
            '--bg-primary': root.getPropertyValue('--bg-primary').trim(),
            '--bg-secondary': root.getPropertyValue('--bg-secondary').trim()
          },
          boxes
        }
      }, targets)

    /** 一遍：量几何 → 取像扫边框 → 再量一次对账 → 存图 */
    const readOnce = async (
      theme: string,
      label: string,
      targets: Array<[string, string]>
    ): Promise<void> => {
      const measured = await measurePage(targets)
      const present = measured.boxes.filter((box) => !box.missing)
      // 横切扫过左边框（-2 … +2 CSS px，步长 0.25）
      const offsets = Array.from({ length: 17 }, (_, index) => -2 + index * 0.25)
      const points: Point[] = present.flatMap((box) =>
        offsets.map((offset) => ({
          name: `${box.name}@${offset}`,
          x: box.left + offset,
          y: box.midY
        }))
      )
      const readings = await samplePixels(app, points, measured.innerWidth)
      const recheck = await measurePage(targets)
      for (const box of present) {
        const after = recheck.boxes.find((candidate) => candidate.name === box.name)
        if (after === undefined) continue
        if (Math.abs(after.left - box.left) > 0.5 || Math.abs(after.midY - box.midY) > 0.5) {
          console.log(
            `[borders] WARN ${theme}/${label} ${box.name} 取像期间几何变了：${box.left.toFixed(2)} → ${after.left.toFixed(2)}`
          )
        }
      }
      await page.screenshot({ path: join(outDir, `${theme}-${label}.png`), fullPage: true })
      console.log(
        `[borders] ${theme}/${label} dpr=${measured.devicePixelRatio} vars=${JSON.stringify(measured.vars)}`
      )
      for (const box of present) {
        const line = readings.filter((reading) => reading.name.startsWith(`${box.name}@`))
        const darkest = line.reduce((best, current) =>
          luminance(current.hex) < luminance(best.hex) ? current : best
        )
        console.log(
          `[borders] ${theme}/${label} ${box.name} w=${box.borderWidth} color=${box.borderColor} bg=${box.backgroundColor} 最暗=${darkest.hex}(L=${luminance(darkest.hex)}) 扫描=${line.map((reading) => reading.hex).join(' ')}`
        )
      }
    }

    try {
      for (const theme of THEMES) {
        await setTheme(theme)
        await expect(page.getByTestId('composer-capability-row')).toBeVisible()
        await settle('[data-testid="composer"]')
        await readOnce(theme, 'hero-dpr-native', HERO_TARGETS)
        const native = await measurePage(HERO_TARGETS)
        await setZoom(1 / native.devicePixelRatio)
        await readOnce(theme, 'hero-dpr-1', HERO_TARGETS)
        await setZoom(1)

        // 设置页（归档栏：一个真的 Input + 几块圆角面板）——表单控件那一档的另一处落点
        await page.evaluate(() => {
          window.location.hash = '#/settings/archived'
        })
        await page.getByTestId('settings-page').waitFor({ timeout: 15_000 })
        await settle('[data-testid="settings-page-column"]')
        await readOnce(theme, 'settings', SETTINGS_TARGETS)
      }
    } finally {
      await app.close()
      await provider.close()
    }
  })
})
