/**
 * R93 图片适配聚焦探针（**真实应用级**、gated）：反馈 001 / 002 的真机布局验证。
 *
 * ── 验的是什么 ────────────────────────────────────────────────────────────────
 *   · **根因回归**：右栏预览的 jpg 曾经被非等比拉伸（`.dsh-media-surface` 没定位，
 *     img 的绝对定位百分比落到 `.dsh-zoom-frame` 视口上）。这里在真 Electron 里用
 *     **自产的有效 JPG**（渲染端 canvas 现场编码）打开，逐处量 `getBoundingClientRect`
 *     与 `naturalWidth/Height` 的对账 —— 图片必须永远等比。
 *   · **默认完整 contain、不放大**：整幅落在滚动口里（四边都在视口内），小图 = 100%。
 *   · **四边 16px**：`.dsh-media-frame` 的 computed padding 逐边 16；
 *     受限的那条边与滚动口的间距 ≈ 16（左右或上下）。
 *   · **放大滚动**：固定倍率放大后滚动口的 `scrollHeight > clientHeight`，scrollTop 真的推得动。
 *   · **三处宿主**：右栏（预览标签）/ 文件树内联（BottomSheet）/ 放大（整屏）都验；
 *     另有窄窗一档（面板变窄也不变形）。
 *   · **菜单**：缩放菜单里的 fit 项写「适应窗口」。
 *   · **001 返工**：± 控件常驻、Ctrl+滚轮、放大后拖拽平移（三处宿主）；旋转 90° 后
 *     仍按 contain 重算四边 16px；拖到滚动口四边能正确 clamp。
 *   · **真实 PDF 选文**：Office 转换后的新阅读器（同一个 ZoomViewport）里，鼠标拖拽
 *     选文不被平移接管（复用 R90 的 报告.docx 夹具；随包 kit 不在时该条 skip）。
 *
 * ── 为什么要有这个文件（而不是只跑单测）─────────────────────────────────────
 *   jsdom 不做布局、也不解码图片；R90 的图片夹具只有 SVG/ICO，**恰好看不出拉伸**。
 *   这一条拿 canvas 现场编出 640×360 / 360×640 / 120×80 三张真 JPG（尺寸非正方、景物有结构），
 *   在真渲染进程里 `<img>` 解码后读 `naturalWidth/Height` 与几何 —— 不伪造 DOM、不 mock 布局。
 *
 * ── 跑法 ─────────────────────────────────────────────────────────────────────
 *   KYCLAW_R93_IMAGE_FIT=1 node_modules/.bin/playwright test e2e/_r93-image-fit.spec.ts
 * 证据落盘：`.superpowers/image-fit/`（截图 + 夹具尺寸清单）。门没开时整个文件 skip。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createInteractiveApp, startInteractiveProvider } from './fixtures/interactive'
import { writeR90Fixtures } from './fixtures/r90'

const ENABLED = process.env.KYCLAW_R93_IMAGE_FIT === '1'
const EVIDENCE_DIR = resolve('.superpowers', 'image-fit')
/** 真实 PDF 选文回归用的随包转换器（Office → 新阅读器）；不在就如实 skip。 */
const KIT_CLI = resolve(
  'resources',
  'libreoffice-kit',
  'node_modules',
  '@deepseek-ai',
  'libreoffice-kit',
  'lib',
  'cli.js'
)

/** 三张自产夹具的尺寸（非正方；竖/横/小各一）。 */
const LANDSCAPE = { name: '横图.jpg', width: 640, height: 360 }
const PORTRAIT = { name: '竖图.jpg', width: 360, height: 640 }
const SMALL = { name: '小图.jpg', width: 120, height: 80 }

interface Rect {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

interface Geometry {
  natural: { w: number; h: number }
  rotation: string | null
  fit: string | null
  mode: string | null
  percent: string | null
  zoomWidthVar: string
  framePadding: { top: string; right: string; bottom: string; left: string }
  frame: Rect | null
  scrollport:
    | (Rect & {
        clientWidth: number
        clientHeight: number
        scrollWidth: number
        scrollHeight: number
        scrollTop: number
      })
    | null
  surface: Rect | null
  image: Rect | null
}

/**
 * 在渲染端现场编一张**真 JPG**（canvas.toDataURL('image/jpeg')）：尺寸就是给的宽高，
 * 画面有渐变 + 边框 + 尺寸文字（有结构才看得出拉伸）。返回 base64 解码后的字节。
 */
async function makeJpeg(page: Page, width: number, height: number): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('canvas 2d 上下文不可用')
      const gradient = context.createLinearGradient(0, 0, w, h)
      gradient.addColorStop(0, '#1a7f37')
      gradient.addColorStop(1, '#f6f6f4')
      context.fillStyle = gradient
      context.fillRect(0, 0, w, h)
      const line = Math.max(3, Math.round(Math.min(w, h) / 20))
      context.lineWidth = line
      context.strokeStyle = '#b3261e'
      context.strokeRect(line / 2, line / 2, w - line, h - line)
      context.fillStyle = '#0b0b0c'
      context.font = `${String(Math.round(h / 6))}px sans-serif`
      context.fillText(`${String(w)}x${String(h)}`, Math.round(w * 0.08), Math.round(h * 0.6))
      return canvas.toDataURL('image/jpeg', 0.9)
    },
    [width, height] as const
  )
  const prefix = 'data:image/jpeg;base64,'
  expect(dataUrl.startsWith(prefix), 'canvas 编出来的不是 JPEG data URL').toBe(true)
  return Buffer.from(dataUrl.slice(prefix.length), 'base64')
}

/** JPEG 的身份证：SOI + 段头（自产件也得真像一张 JPG）。 */
function assertJpegMagic(bytes: Buffer, name: string): void {
  expect(bytes.length, `${name} 字节数太少`).toBeGreaterThan(200)
  expect(bytes[0], `${name} 缺 SOI`).toBe(0xff)
  expect(bytes[1], `${name} 缺 SOI`).toBe(0xd8)
  expect(bytes[2], `${name} 缺段头`).toBe(0xff)
}

/**
 * 量一个宿主里的图片几何。宿主 = `file-preview`（内联，同屏至多一个）或
 * `preview-tool`（预览标签；同屏可能有多张，**按 `data-relative` 认那一张** ——
 * 别的标签的 `visibility` 过渡会让"看得见吗"短暂为真，不能只看可见性）。
 * 全部读真实 DOM 的 rect 与 natural 尺寸 —— 不注入任何值。
 */
async function geometryOf(page: Page, hostTestId: string, relative?: string): Promise<Geometry> {
  return page.evaluate(
    ([testId, file]) => {
      const selector =
        file === ''
          ? `[data-testid="${testId}"]`
          : `[data-testid="${testId}"][data-relative="${file}"]`
      const host = document.querySelector(selector)
      if (host === null) throw new Error(`宿主不在：${selector}`)
      const frame = host.querySelector('[data-testid="dsh-zoom-frame"]')
      const scrollport = host.querySelector('[data-dsh-zoom-scrollport]')
      const surface = host.querySelector('[data-testid="image-frame"]')
      const image = host.querySelector('.dsh-media-image')
      const mediaFrame = host.querySelector('.dsh-media-frame')
      const rectOf = (node: Element | null): Rect | null => {
        if (node === null) return null
        const r = node.getBoundingClientRect()
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          left: r.left
        }
      }
      const padding =
        mediaFrame === null
          ? { top: '', right: '', bottom: '', left: '' }
          : {
              top: getComputedStyle(mediaFrame).paddingTop,
              right: getComputedStyle(mediaFrame).paddingRight,
              bottom: getComputedStyle(mediaFrame).paddingBottom,
              left: getComputedStyle(mediaFrame).paddingLeft
            }
      const scroller = scrollport as HTMLElement | null
      return {
        natural:
          image instanceof HTMLImageElement
            ? { w: image.naturalWidth, h: image.naturalHeight }
            : { w: 0, h: 0 },
        // data-rotation 在 `.dsh-media-root`（`file-preview-image`）上，不在宿主外壳上
        rotation:
          host.querySelector('[data-testid="file-preview-image"]')?.getAttribute('data-rotation') ??
          null,
        fit: frame === null ? null : frame.getAttribute('data-dsh-zoom-fit'),
        mode: frame === null ? null : frame.getAttribute('data-dsh-zoom-mode'),
        percent: host.querySelector('[data-testid="dsh-zoom-value"]')?.textContent ?? null,
        zoomWidthVar:
          (surface as HTMLElement | null)?.style.getPropertyValue('--dsh-zoom-width') ?? '',
        framePadding: padding,
        frame: rectOf(mediaFrame),
        scrollport:
          scroller === null
            ? null
            : {
                ...(rectOf(scroller) as Rect),
                clientWidth: scroller.clientWidth,
                clientHeight: scroller.clientHeight,
                scrollWidth: scroller.scrollWidth,
                scrollHeight: scroller.scrollHeight,
                scrollTop: scroller.scrollTop
              },
        surface: rectOf(surface),
        image: rectOf(image)
      }
    },
    [hostTestId, relative ?? ''] as const
  )
}

/** 等这个宿主里的图真解码完成（data-loaded=true）+ 控件挂出来。 */
async function waitImageReady(host: Locator): Promise<void> {
  const root = host.getByTestId('file-preview-image').first()
  await expect(root).toBeVisible({ timeout: 30_000 })
  await expect(root).toHaveAttribute('data-loaded', 'true', { timeout: 30_000 })
  await expect(root.getByTestId('dsh-zoom-value')).toBeAttached({ timeout: 30_000 })
}

/** 等比（长宽比）对账：显示盒的长宽比要与 natural 的长宽比一致（±2%）。 */
function expectSameAspect(geometry: Geometry, label: string): void {
  const image = geometry.image
  expect(image, `${label}：没有图片盒`).not.toBeNull()
  const natural = geometry.natural
  expect(natural.w, `${label}：natural 宽是 0（没真解码）`).toBeGreaterThan(0)
  expect(natural.h, `${label}：natural 高是 0（没真解码）`).toBeGreaterThan(0)
  const shown = (image as Rect).width / (image as Rect).height
  // 90°/270° 时显示盒是转过来的（宽高对调），两种比法都认
  const upright = natural.w / natural.h
  const sideways = geometry.rotation === '90' || geometry.rotation === '270'
  const expected = sideways ? 1 / upright : upright
  expect(
    Math.abs(shown / expected - 1),
    `${label}：显示盒 ${String(Math.round((image as Rect).width))}×${String(
      Math.round((image as Rect).height)
    )} 的长宽比 ${shown.toFixed(3)} 与 natural 的 ${expected.toFixed(3)} 不一致（被拉伸）`
  ).toBeLessThan(0.02)
}

/** 整幅落在滚动口里（contain 的"完整看得见"）。 */
function expectContained(geometry: Geometry, label: string): void {
  const image = geometry.image as Rect
  const port = geometry.scrollport
  expect(port, `${label}：没有滚动口`).not.toBeNull()
  const p = port as Rect
  const slack = 1.5
  expect(image.left, `${label}：左边探出滚动口`).toBeGreaterThanOrEqual(p.left - slack)
  expect(image.top, `${label}：上边探出滚动口`).toBeGreaterThanOrEqual(p.top - slack)
  expect(image.right, `${label}：右边探出滚动口`).toBeLessThanOrEqual(p.right + slack)
  expect(image.bottom, `${label}：下边探出滚动口`).toBeLessThanOrEqual(p.bottom + slack)
}

/**
 * contain 的期望倍率按量到的滚动口现算，再与显示面对账；四边 16px 的判据：
 * computed padding 逐边 16，且**受限的那条边**与滚动口的间距 ≈ 16（另一条边居中，只会更宽）。
 * 不用"哪个方向受限"写死 —— 面板宽高、图片横竖都可能是变量，判据得跟着量出来的数走。
 */
function expectContainScale(geometry: Geometry, label: string): void {
  expect(geometry.framePadding, `${label}：.dsh-media-frame 的 padding 不是四边 16`).toEqual({
    top: '16px',
    right: '16px',
    bottom: '16px',
    left: '16px'
  })
  const surface = geometry.surface as Rect
  const port = geometry.scrollport as Rect & { clientWidth: number; clientHeight: number }
  const natural = geometry.natural
  // 90°/270° 时外接框宽高对调，contain 的"原始宽高"要按转过来的方向算
  const sideways = geometry.rotation === '90' || geometry.rotation === '270'
  const footprint = sideways ? { w: natural.h, h: natural.w } : natural
  const widthTerm = (port.clientWidth - 32) / footprint.w
  const heightTerm = (port.clientHeight - 32) / footprint.h
  const expected = Math.min(1, widthTerm, heightTerm)
  expect(
    Math.abs(surface.width / footprint.w - expected),
    `${label}：显示面宽比 ${(surface.width / footprint.w).toFixed(3)} 不是 contain 的 ${expected.toFixed(3)}`
  ).toBeLessThan(0.01)
  expect(
    Math.abs(surface.height / footprint.h - expected),
    `${label}：显示面高比 ${(surface.height / footprint.h).toFixed(3)} 不是 contain 的 ${expected.toFixed(3)}`
  ).toBeLessThan(0.01)
  // 面板上的百分比就是现算的 contain 倍率（不成比例地放大/缩小会在这里露出来）
  const percent = Number.parseFloat(geometry.percent ?? 'NaN')
  expect(
    Math.abs(percent - expected * 100),
    `${label}：缩放控件的 ${String(geometry.percent)} 与 contain 倍率 ${(expected * 100).toFixed(1)}% 对不上`
  ).toBeLessThanOrEqual(1)
  const gaps = {
    left: surface.left - port.left,
    right: port.right - surface.right,
    top: surface.top - port.top,
    bottom: port.bottom - surface.bottom
  }
  if (expected >= 1) {
    // 100% 档（小图不放大）：两条边都居中，间距只会 ≥ 16
    for (const [side, gap] of Object.entries(gaps)) {
      expect(gap, `${label}：${side} 留白 ${gap.toFixed(1)} 小于 16`).toBeGreaterThanOrEqual(15)
    }
    return
  }
  if (widthTerm <= heightTerm) {
    expect(
      Math.abs(gaps.left - 16),
      `${label}：左留白 ${gaps.left.toFixed(1)} 不是 16（宽受限）`
    ).toBeLessThan(1.5)
    expect(
      Math.abs(gaps.right - 16),
      `${label}：右留白 ${gaps.right.toFixed(1)} 不是 16`
    ).toBeLessThan(1.5)
  } else {
    expect(Math.abs(gaps.top - 16), `${label}：上留白 ${gaps.top.toFixed(1)} 不是 16`).toBeLessThan(
      1.5
    )
    expect(
      Math.abs(gaps.bottom - 16),
      `${label}：下留白 ${gaps.bottom.toFixed(1)} 不是 16（高受限）`
    ).toBeLessThan(1.5)
  }
}

/** 打开右栏的文件工具（与 R90 同一套稳定路径）。 */
async function openFilesTool(page: Page): Promise<void> {
  const panel = page.locator('[data-testid="workbench-panel"][data-kind="files"]')
  if ((await page.getByTestId('workbench-close').count()) === 0) {
    await page.getByTestId('work-panel-toggle').click()
    await expect(page.getByTestId('workbench-close')).toBeVisible({ timeout: 10_000 })
  }
  if ((await panel.count()) === 0) {
    const empty = page.getByTestId('workbench-empty-action-files')
    if ((await empty.count()) > 0 && (await empty.isVisible())) {
      await empty.click()
    } else {
      await page.keyboard.press('Control+Shift+E')
    }
  } else if ((await panel.getAttribute('data-active')) !== 'true') {
    await page.locator('[id^="workbench-tab-files-"]').first().click()
  }
  await expect(panel).toHaveAttribute('data-active', 'true', { timeout: 10_000 })
  await expect(page.getByTestId('files-root')).toBeVisible({ timeout: 30_000 })
}

/**
 * 点文件树里的某一行：`inline` = 单击看内联预览；`tab` = 右键 → 在新标签页中查看。
 *
 * 每次都先 `openFilesTool` 把文件标签切回前台：预览标签是 `absolute inset-0`，正压在文件行
 * 上面；而非活动标签带 `visibility` 的**过渡**——只做一次"看得见吗"的判断会在过渡窗口里
 * 误判（实测踩过：判定"可见"，点在半透明的那一层上被挡）。切前台之后由 Playwright 自己
 * 重试到点击真正落到行上。
 */
async function clickFile(page: Page, name: string, mode: 'inline' | 'tab'): Promise<void> {
  await openFilesTool(page)
  const row = page.locator(`[data-testid="file-row"][data-kind="file"][data-relative="${name}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  if (mode === 'inline') {
    await row.click()
    return
  }
  await row.click({ button: 'right' })
  await page.getByTestId('workbench-context-menu-preview').click()
}

/**
 * 某份文件的预览标签（store 按 path 去重 → 同一份文件最多一张标签，按 `data-relative` 认它）。
 * 不用"当前可见的那张"：标签切换带 `visibility` 过渡，旧标签会在过渡窗口里短暂"还可见"。
 */
function tabHost(page: Page, relative: string): Locator {
  return page.locator(`[data-testid="preview-tool"][data-relative="${relative}"]`)
}

/** 关掉内联预览那张底页（换到右栏验之前清场，免得两个宿主同屏互相干扰视线）。 */
async function closeInlineSheet(page: Page): Promise<void> {
  const sheet = page.getByTestId('file-preview')
  if ((await sheet.count()) > 0) {
    await sheet.getByRole('button', { name: '关闭' }).click()
    await expect(sheet).toHaveCount(0)
  }
}

/**
 * 把浮动缩放面板露出来（露头式：鼠标离开底部 72px 露头区 420ms 后收起，pointer-events:none）。
 * 与 R90 的 revealZoomControls 同一手法，按宿主定位（同屏可能有多个滚动口）。
 */
async function revealZoomControls(page: Page, host: Locator): Promise<Locator> {
  const frame = host.getByTestId('dsh-zoom-frame')
  const controls = host.getByTestId('dsh-zoom-controls')
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await controls.getAttribute('data-dsh-zoom-visible')) === 'true') break
    const box = await frame.boundingBox()
    if (box === null) break
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight
    }))
    const x = box.x + box.width / 2
    const y = Math.min(box.y + box.height - 16, viewport.height - 4)
    await page.mouse.move(x, y)
    await page.waitForTimeout(120)
  }
  await expect(controls).toHaveAttribute('data-dsh-zoom-visible', 'true', { timeout: 5000 })
  return controls
}

/** 点一个缩放按钮（先露头、再发真鼠标点击；生效与否由调用方断言）。 */
async function clickZoomButton(
  page: Page,
  host: Locator,
  testId: 'dsh-zoom-in' | 'dsh-zoom-out' | 'dsh-zoom-percent'
): Promise<void> {
  await revealZoomControls(page, host)
  // 面板入场是 180ms 的过渡：按钮还在动的那一下点击会被吞掉（R90 实测），先等它站定
  await page.waitForTimeout(260)
  const button = host.getByTestId(testId)
  const box = await button.boundingBox()
  if (box === null) throw new Error(`${testId} 没有盒子（面板没挂出来？）`)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  // 面板点完 420ms 后可能收起（pointer-events:none）；下一位调用方自己会再露头
  await page.waitForTimeout(120)
}

/** 放大一档，点到百分比真的变了为止（面板收起 / 过渡吞点击时重试；真不生效就抛）。 */
async function zoomInApplied(page: Page, host: Locator, attempt = 0): Promise<void> {
  const before = await host.getByTestId('dsh-zoom-value').textContent()
  await clickZoomButton(page, host, 'dsh-zoom-in')
  try {
    await expect
      .poll(async () => host.getByTestId('dsh-zoom-value').textContent(), { timeout: 2000 })
      .not.toBe(before)
  } catch (error) {
    if (attempt >= 3) throw error
    await zoomInApplied(page, host, attempt + 1)
  }
}

/** 缩放控件的当前百分比（数字）。 */
async function zoomPercentOf(host: Locator): Promise<number> {
  return Number.parseFloat((await host.getByTestId('dsh-zoom-value').textContent()) ?? '0')
}

/**
 * 001 返工：图片的缩放控件**常驻**。把鼠标停在图片中心（不在底部 72px 露头区），
 * 等过文档那套 420ms 收起延迟后，± 按钮仍然可见——不是"从来没触发过收起"的假阳性。
 */
async function expectControlsPersistent(page: Page, host: Locator): Promise<void> {
  const frame = host.getByTestId('dsh-zoom-frame')
  const box = await frame.boundingBox()
  if (box === null) throw new Error('缩放视口没有盒子（还没布局？）')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(700)
  const controls = host.getByTestId('dsh-zoom-controls')
  await expect(controls).toHaveAttribute('data-dsh-zoom-visible', 'true')
  await expect(controls.getByTestId('dsh-zoom-in')).toBeVisible()
  await expect(controls.getByTestId('dsh-zoom-out')).toBeVisible()
}

/**
 * 001 返工：Ctrl + 滚轮缩放。真鼠标滚轮 + 真 Control 修饰键（不是派发合成事件）；
 * 每格约 ×1.49（delta 被夹到 40、exp(0.4)），百分比必须真的涨。
 */
async function ctrlWheelZoom(page: Page, host: Locator, notches = 1): Promise<void> {
  const before = await zoomPercentOf(host)
  const frame = host.getByTestId('dsh-zoom-frame')
  const box = await frame.boundingBox()
  if (box === null) throw new Error('缩放视口没有盒子（还没布局？）')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  for (let notch = 0; notch < notches; notch += 1) {
    await page.mouse.wheel(0, -120)
  }
  await page.keyboard.up('Control')
  await expect.poll(async () => zoomPercentOf(host), { timeout: 5000 }).toBeGreaterThan(before)
}

/** 把某个图片宿主的倍率切回「适应窗口」（复用真实菜单，不直接改 state）。 */
async function ensureFit(page: Page, host: Locator): Promise<void> {
  const frame = host.getByTestId('dsh-zoom-frame')
  if ((await frame.getAttribute('data-dsh-zoom-mode')) === 'fit-width') return
  await clickZoomButton(page, host, 'dsh-zoom-percent')
  const item = page.getByRole('menuitem', { name: '适应窗口' })
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  await expect(frame).toHaveAttribute('data-dsh-zoom-mode', 'fit-width', { timeout: 5000 })
}

/** 读滚动口的平移量与溢出（拖拽前后的对账都读真 DOM）。 */
async function panStateOf(port: Locator): Promise<{
  left: number
  top: number
  maxLeft: number
  maxTop: number
  overflowX: boolean
  overflowY: boolean
}> {
  return port.evaluate((node) => {
    const scroller = node as HTMLElement
    return {
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
      maxLeft: Math.max(0, scroller.scrollWidth - scroller.clientWidth),
      maxTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      overflowX: scroller.scrollWidth > scroller.clientWidth + 1,
      overflowY: scroller.scrollHeight > scroller.clientHeight + 1
    }
  })
}

/** 从滚动口中心向某个方向拖一次；坐标留在滚动口内，避免把事件发到视口外。 */
async function dragPanOnce(page: Page, host: Locator, direction: 'min' | 'max'): Promise<void> {
  const box = await host.locator('[data-dsh-zoom-scrollport]').boundingBox()
  if (box === null) throw new Error('滚动口没有盒子（还没布局？）')
  const inset = 24
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  const dx = direction === 'min' ? box.width / 2 - inset : -(box.width / 2 - inset)
  const dy = direction === 'min' ? box.height / 2 - inset : -(box.height / 2 - inset)
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + dx, startY + dy, { steps: 6 })
  await page.mouse.up()
}

/**
 * 001 返工：放大后按住左键拖拽平移。往左上拖 → 看内容右下方的局部，scrollLeft/Top 变大。
 * 只用真有溢出的方向断言（另一个方向本来就无处可滚）。
 */
async function dragPan(page: Page, host: Locator): Promise<void> {
  const port = host.locator('[data-dsh-zoom-scrollport]')
  const before = await panStateOf(port)
  expect(before.overflowX || before.overflowY, '放大后滚动口没有可拖拽的溢出').toBe(true)
  const box = await port.boundingBox()
  if (box === null) throw new Error('滚动口没有盒子（还没布局？）')
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  const dx = before.overflowX ? -160 : 0
  const dy = before.overflowY ? -120 : 0
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + dx, startY + dy, { steps: 12 })
  await page.mouse.up()
  const after = await panStateOf(port)
  if (before.overflowX) {
    await expect
      .poll(async () => (await panStateOf(port)).left, { timeout: 3000 })
      .toBeGreaterThan(before.left)
  }
  if (before.overflowY) {
    await expect
      .poll(async () => (await panStateOf(port)).top, { timeout: 3000 })
      .toBeGreaterThan(before.top)
  }
  expect(after.left).toBeGreaterThanOrEqual(before.left)
  expect(after.top).toBeGreaterThanOrEqual(before.top)
}

/** 取证截图：先让标签/面板的淡入过渡走完（只影响截图，不参与任何断言）。 */
async function snap(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(320)
  await page.screenshot({ path: join(EVIDENCE_DIR, name) })
}

test.describe.serial('R93 · 图片适配（真应用：自产 JPG + 右栏/内联/整屏三处布局）', () => {
  test.describe.configure({ timeout: 240_000 })
  test.skip(!ENABLED, 'KYCLAW_R93_IMAGE_FIT=1 才跑（需先 build）')

  let provider: Awaited<ReturnType<typeof startInteractiveProvider>>
  let app: Awaited<ReturnType<typeof createInteractiveApp>>
  let sessionRoot = ''

  test.beforeAll(async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    provider = await startInteractiveProvider()
    app = await createInteractiveApp(provider.url)
    app.app.process().stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text !== '') console.log(`[r93:main-stderr] ${text}`)
    })

    provider.enqueue({ text: 'R93 就绪' })
    await app.page.getByTestId('composer-input').fill('R93 准备')
    await app.page.getByTestId('composer-send').click()
    await expect(app.page.locator('[data-testid^="session-item-"]').first()).toBeVisible({
      timeout: 30_000
    })
    await openFilesTool(app.page)

    // 夹具写进产品自己的会话根（无项目会话落在 tasks/<threadId 前 8 位>，别自己推路径）
    sessionRoot = (await app.page.getByTestId('files-root').getAttribute('title')) ?? ''
    expect(sessionRoot, '文件树没给出根路径').not.toBe('')

    // 复用 R90 的夹具写出器：只为真实 PDF（Office → 新阅读器）选文回归准备 报告.docx
    // （它会顺带写整套 R90 夹具；临时工作区，不碰用户文件）。
    const r90 = await writeR90Fixtures(sessionRoot, {
      sentinelUrl: 'http://127.0.0.1:9/'
    })
    console.log(
      `[r93] R90 夹具: ${String(r90.written.length)} 份，跳过 ${String(r90.skipped.length)} 份`
    )

    // 自产三张真 JPG：渲染端 canvas 现场编码（Chromium 的 JPEG 编码器出的就是真件）
    for (const probe of [LANDSCAPE, PORTRAIT, SMALL]) {
      const bytes = await makeJpeg(app.page, probe.width, probe.height)
      assertJpegMagic(bytes, probe.name)
      writeFileSync(join(sessionRoot, probe.name), bytes)
      console.log(
        `[r93] 自产 ${probe.name}: ${String(bytes.length)} B (${String(probe.width)}×${String(probe.height)})`
      )
    }
    writeFileSync(
      join(EVIDENCE_DIR, 'fixtures.json'),
      `${JSON.stringify({ sessionRoot, probes: [LANDSCAPE, PORTRAIT, SMALL] }, null, 2)}\n`,
      'utf8'
    )

    await app.page.getByTestId('files-refresh').click()
    for (const probe of [LANDSCAPE, PORTRAIT, SMALL]) {
      await expect(
        app.page.locator(
          `[data-testid="file-row"][data-kind="file"][data-relative="${probe.name}"]`
        )
      ).toBeVisible({ timeout: 30_000 })
    }
    await expect(
      app.page.locator(`[data-testid="file-row"][data-kind="file"][data-relative="报告.docx"]`)
    ).toBeVisible({ timeout: 30_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    await provider?.close()
  })

  test('右栏（预览标签）：横图 / 竖图都等比 contain（按受限边缩），四边 16px', async () => {
    // 横图：窗口 1280×800 下右栏很窄 → 宽受限（左右各 16）
    await clickFile(app.page, LANDSCAPE.name, 'tab')
    const landscapeTab = tabHost(app.page, LANDSCAPE.name)
    await waitImageReady(landscapeTab)
    const landscape = await geometryOf(app.page, 'preview-tool', LANDSCAPE.name)
    expect(landscape.natural).toEqual({ w: LANDSCAPE.width, h: LANDSCAPE.height })
    expect(landscape.fit).toBe('contain')
    expect(landscape.mode).toBe('fit-width')
    expectSameAspect(landscape, '右栏横图')
    expectContained(landscape, '右栏横图')
    expectContainScale(landscape, '右栏横图')
    console.log('[r93] 右栏横图几何:', JSON.stringify(landscape))

    // 竖图：同一个右栏，量出来的受限边由数字说话（16px 判据跟着量到的宽高走）
    await clickFile(app.page, PORTRAIT.name, 'tab')
    const portraitTab = tabHost(app.page, PORTRAIT.name)
    await waitImageReady(portraitTab)
    const portrait = await geometryOf(app.page, 'preview-tool', PORTRAIT.name)
    expect(portrait.natural).toEqual({ w: PORTRAIT.width, h: PORTRAIT.height })
    expectSameAspect(portrait, '右栏竖图')
    expectContained(portrait, '右栏竖图')
    expectContainScale(portrait, '右栏竖图')
    console.log('[r93] 右栏竖图几何:', JSON.stringify(portrait))
    await snap(app.page, 'tab-portrait.png')

    // 小图：装得下就不放大（100%，显示盒 = natural）
    await clickFile(app.page, SMALL.name, 'tab')
    const smallTab = tabHost(app.page, SMALL.name)
    await waitImageReady(smallTab)
    const small = await geometryOf(app.page, 'preview-tool', SMALL.name)
    expect(small.natural).toEqual({ w: SMALL.width, h: SMALL.height })
    expect(small.percent).toBe('100%')
    expect(Math.abs((small.image as Rect).width - SMALL.width)).toBeLessThan(1)
    expect(Math.abs((small.image as Rect).height - SMALL.height)).toBeLessThan(1)
    expectSameAspect(small, '右栏小图')
    console.log('[r93] 右栏小图几何:', JSON.stringify(small))
  })

  test('文件树内联：确定高度的 contain（竖图整幅在视口里，宿主不再内容撑高）', async () => {
    await closeInlineSheet(app.page).catch(() => undefined)
    await clickFile(app.page, PORTRAIT.name, 'inline')
    const sheet = app.page.getByTestId('file-preview')
    await expect(sheet).toBeVisible({ timeout: 30_000 })
    await waitImageReady(sheet)

    const geometry = await geometryOf(app.page, 'file-preview')
    expect(geometry.natural).toEqual({ w: PORTRAIT.width, h: PORTRAIT.height })
    expect(geometry.fit).toBe('contain')
    expectSameAspect(geometry, '内联竖图')
    expectContained(geometry, '内联竖图')
    // "确定高度"的可见证据：滚动口真的有可视高度，且整张图（含 16px 留白）装在里面
    const port = geometry.scrollport as Rect & { clientHeight: number }
    expect(port.clientHeight, '内联滚动口没有可视高度（高度链断了）').toBeGreaterThan(80)
    expect((geometry.image as Rect).height).toBeLessThanOrEqual(port.clientHeight + 1.5)
    // 内联那种"内容撑高"的旧口径下，图会把它自己撑到一千多像素、外层的 70% 上限再裁 —— 这里不会再出现
    const innerHeight = await app.page.evaluate(() => window.innerHeight)
    expect((geometry.frame as Rect).height).toBeLessThan(innerHeight)
    console.log('[r93] 内联竖图几何:', JSON.stringify(geometry))
    await snap(app.page, 'inline-portrait.png')
  })

  test('放大（整屏）：等比 contain 保持（右栏 → 整屏不改口径）', async () => {
    // 上一轮内联预览还开着：先关掉，避免截图里两个宿主叠在一起（测试取证卫生）
    await closeInlineSheet(app.page).catch(() => undefined)
    // 整屏开关只在宽窗形态下存在（与 R90 同一前置）
    await app.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1400, height: 900 })
    })
    await expect
      .poll(async () => app.page.evaluate(() => window.innerWidth), { timeout: 10_000 })
      .toBeGreaterThan(1200)

    await clickFile(app.page, LANDSCAPE.name, 'tab')
    const tab = tabHost(app.page, LANDSCAPE.name)
    await waitImageReady(tab)

    const fullscreen = app.page.getByTestId('workbench-fullscreen')
    await expect(fullscreen).toBeVisible({ timeout: 10_000 })
    await fullscreen.click()
    await expect(fullscreen).toHaveAccessibleName('回到窗口化', { timeout: 10_000 })

    await waitImageReady(tab)
    const geometry = await geometryOf(app.page, 'preview-tool', LANDSCAPE.name)
    expect(geometry.fit).toBe('contain')
    expectSameAspect(geometry, '整屏横图')
    expectContained(geometry, '整屏横图')
    // 整屏更宽：横图多半变成"高受限"或仍宽受限，但绝不允许超过 100%（不放大）—— 由 helper 逐条对账
    expectContainScale(geometry, '整屏横图')
    console.log('[r93] 整屏横图几何:', JSON.stringify(geometry))
    await snap(app.page, 'fullscreen-landscape.png')

    // 复位：别把"整屏"留给后面的用例
    await fullscreen.click()
    await expect(fullscreen).toHaveAccessibleName('面板全屏', { timeout: 10_000 })
    // 顺手把窗口收窄一档 —— 下一条（窄窗）就从这里接着来
    await app.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 980, height: 760 })
    })
    await expect
      .poll(async () => app.page.evaluate(() => window.innerWidth), { timeout: 10_000 })
      .toBeLessThan(1080)
  })

  test('窄窗：面板变窄仍等比 contain（按受限边缩，判据跟着量到的宽高走）', async () => {
    await clickFile(app.page, LANDSCAPE.name, 'tab')
    const landscapeTab = tabHost(app.page, LANDSCAPE.name)
    await waitImageReady(landscapeTab)
    const landscape = await geometryOf(app.page, 'preview-tool', LANDSCAPE.name)
    expectSameAspect(landscape, '窄窗横图')
    expectContained(landscape, '窄窗横图')
    expectContainScale(landscape, '窄窗横图')
    console.log('[r93] 窄窗横图几何:', JSON.stringify(landscape))

    await clickFile(app.page, PORTRAIT.name, 'tab')
    const portraitTab = tabHost(app.page, PORTRAIT.name)
    await waitImageReady(portraitTab)
    const portrait = await geometryOf(app.page, 'preview-tool', PORTRAIT.name)
    expectSameAspect(portrait, '窄窗竖图')
    expectContained(portrait, '窄窗竖图')
    expectContainScale(portrait, '窄窗竖图')
    console.log('[r93] 窄窗竖图几何:', JSON.stringify(portrait))
    await snap(app.page, 'narrow-portrait.png')
  })

  test('放大滚动：固定倍率超出视口后滚动口真的能滚；旋转 90° 仍等比', async () => {
    await clickFile(app.page, PORTRAIT.name, 'tab')
    const tab = tabHost(app.page, PORTRAIT.name)
    await waitImageReady(tab)

    const before = await geometryOf(app.page, 'preview-tool', PORTRAIT.name)
    const percentBefore = Number.parseFloat(before.percent ?? '100')

    // 放大两档（露头 → 点击；×1.25 一档，从 contain 倍率起走；过渡吞点击会自动重试）
    await zoomInApplied(app.page, tab)
    await zoomInApplied(app.page, tab)
    await expect
      .poll(
        async () =>
          Number.parseFloat(
            (await geometryOf(app.page, 'preview-tool', PORTRAIT.name)).percent ?? '0'
          ),
        { timeout: 5000 }
      )
      .toBeGreaterThan(percentBefore)

    const zoomed = await geometryOf(app.page, 'preview-tool', PORTRAIT.name)
    expect(zoomed.mode).toBe('fixed')
    expectSameAspect(zoomed, '放大后的竖图')
    const port = zoomed.scrollport as Rect & {
      scrollHeight: number
      clientHeight: number
      scrollTop: number
    }
    console.log('[r93] 放大后竖图几何:', JSON.stringify(zoomed))
    expect(
      port.scrollHeight,
      `放大后滚动高度 ${String(port.scrollHeight)} 没超过可视高 ${String(port.clientHeight)}（没得滚）`
    ).toBeGreaterThan(port.clientHeight)

    // 真滚一下：推到最底，读回来必须 > 0（滚动口真的可滚，不是摆设）
    const scrolled = await tab.locator('[data-dsh-zoom-scrollport]').evaluate((node) => {
      const scroller = node as HTMLElement
      scroller.scrollTop = 1_000_000
      return scroller.scrollTop
    })
    expect(scrolled, 'scrollTop 推不动（滚动口不可滚）').toBeGreaterThan(0)
    await snap(app.page, 'zoom-scroll.png')

    // 旋转 90°：外接框对调，显示盒随即转过来 —— 长宽比仍与 natural 一致（转的是 transform）
    await tab.getByTestId('image-rotate-right').click()
    await expect(tab.getByTestId('file-preview-image')).toHaveAttribute('data-rotation', '90')
    const rotated = await geometryOf(app.page, 'preview-tool', PORTRAIT.name)
    const natural = rotated.natural
    expectSameAspect(rotated, '旋转 90° 后的竖图')
    // 显示盒的宽高对调（竖图 → 横着放）
    expect((rotated.image as Rect).width).toBeGreaterThan((rotated.image as Rect).height)
    expect(rotated.zoomWidthVar).toBe(`${String(natural.h)}px`)
    console.log('[r93] 旋转 90° 后几何:', JSON.stringify(rotated))
    await snap(app.page, 'rotated.png')
  })

  test('菜单：fit 那一项写「适应窗口」', async () => {
    await clickFile(app.page, SMALL.name, 'tab')
    const tab = tabHost(app.page, SMALL.name)
    await waitImageReady(tab)

    await clickZoomButton(app.page, tab, 'dsh-zoom-percent')
    const item = app.page.getByRole('menuitem', { name: '适应窗口' })
    await expect(item).toBeVisible({ timeout: 10_000 })
    await expect(item).toHaveAttribute('aria-current', 'page')
    await app.page.keyboard.press('Escape')
    await expect(item).toHaveCount(0, { timeout: 5000 })
  })

  test('旋转 90° 后仍是 contain：整幅在视口内、四边 16px、比例不变', async () => {
    await clickFile(app.page, LANDSCAPE.name, 'tab')
    const tab = tabHost(app.page, LANDSCAPE.name)
    await waitImageReady(tab)

    await tab.getByTestId('image-rotate-right').click()
    await expect(tab.getByTestId('file-preview-image')).toHaveAttribute('data-rotation', '90')
    // fit 倍率按旋转后的 footprint 重算（落盘 effect 在 paint 后）：等"面宽 = 旋转后原始宽 ×
    // contain 倍率"真的成立。不按百分比判 —— 方形视口下转 90° 的 fit 倍率可能恰好不变。
    await expect
      .poll(
        async () => {
          const current = await geometryOf(app.page, 'preview-tool', LANDSCAPE.name)
          const surface = current.surface
          const port = current.scrollport as
            (Rect & { clientWidth: number; clientHeight: number }) | null
          if (surface === null || port === null) return Number.NaN
          const natural = current.natural
          const expected = Math.min(
            1,
            (port.clientWidth - 32) / natural.h,
            (port.clientHeight - 32) / natural.w
          )
          return Math.abs(surface.width / (natural.h * expected) - 1)
        },
        { timeout: 5000 }
      )
      .toBeLessThan(0.01)

    const rotated = await geometryOf(app.page, 'preview-tool', LANDSCAPE.name)
    expect(rotated.fit).toBe('contain')
    expect(rotated.mode).toBe('fit-width')
    expectSameAspect(rotated, '旋转 90° 后的横图')
    expectContained(rotated, '旋转 90° 后的横图')
    // 转 90° 后 footprint 是 360×640：percent 与 surface 都按它重算，四边 16px 跟着受限边
    expectContainScale(rotated, '旋转 90° 后的横图')
    const image = rotated.image as Rect
    expect(image.height).toBeGreaterThan(image.width)
    console.log('[r93] 旋转 90° 后 contain 几何:', JSON.stringify(rotated))
    await snap(app.page, 'rotation-contain.png')

    // 复位，别把旋转留给后面的用例
    await tab.getByTestId('image-rotate-left').click()
    await expect(tab.getByTestId('file-preview-image')).toHaveAttribute('data-rotation', '0')
  })

  /* ── 001 返工：可见 ± 按钮 / Ctrl+滚轮 / 放大后拖拽平移（三处宿主一致） ─────── */

  test('右栏：缩放 ± 按钮常驻（鼠标离开也不收起）', async () => {
    await clickFile(app.page, LANDSCAPE.name, 'tab')
    const tab = tabHost(app.page, LANDSCAPE.name)
    await waitImageReady(tab)
    await expectControlsPersistent(app.page, tab)
    // 比例口径不受影响：仍是 contain 的 fit 模式
    const geometry = await geometryOf(app.page, 'preview-tool', LANDSCAPE.name)
    expect(geometry.mode).toBe('fit-width')
    expectSameAspect(geometry, '右栏常驻控件')
    console.log('[r93] 常驻控件可见（右栏）:', geometry.percent)
  })

  test('右栏：Ctrl+滚轮放大，随后鼠标拖拽平移局部', async () => {
    const tab = tabHost(app.page, LANDSCAPE.name)
    await waitImageReady(tab)

    // 两格滚轮：窄右栏里的横图一定放大到超出视口（宽受限）
    await ctrlWheelZoom(app.page, tab, 2)
    const zoomed = await geometryOf(app.page, 'preview-tool', LANDSCAPE.name)
    expect(zoomed.mode).toBe('fixed')
    expectSameAspect(zoomed, 'Ctrl+滚轮放大后的横图')
    console.log('[r93] Ctrl+滚轮后（右栏）:', zoomed.percent)

    await dragPan(app.page, tab)
    const dragged = await geometryOf(app.page, 'preview-tool', LANDSCAPE.name)
    expectSameAspect(dragged, '拖拽平移后的横图')
    // 拖拽只改滚动位置，不改倍率
    expect(dragged.percent).toBe(zoomed.percent)
    await snap(app.page, 'pan-tab.png')
    console.log(
      '[r93] 拖拽平移后（右栏）:',
      await panStateOf(tab.locator('[data-dsh-zoom-scrollport]'))
    )
  })

  test('内联 / 整屏：常驻控件、Ctrl+滚轮与拖拽同样可用（三处一致）', async () => {
    // ── 内联（文件树底页） ──
    await closeInlineSheet(app.page).catch(() => undefined)
    await clickFile(app.page, LANDSCAPE.name, 'inline')
    const sheet = app.page.getByTestId('file-preview')
    await expect(sheet).toBeVisible({ timeout: 30_000 })
    await waitImageReady(sheet)
    await expectControlsPersistent(app.page, sheet)
    await ctrlWheelZoom(app.page, sheet, 2)
    await dragPan(app.page, sheet)
    const inline = await geometryOf(app.page, 'file-preview')
    expectSameAspect(inline, '内联：拖拽平移后的横图')
    await snap(app.page, 'pan-inline.png')
    console.log('[r93] 内联平移后:', await panStateOf(sheet.locator('[data-dsh-zoom-scrollport]')))
    await closeInlineSheet(app.page)

    // ── 整屏（大窗口下的放大视图） ──
    await app.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1400, height: 900 })
    })
    await expect
      .poll(async () => app.page.evaluate(() => window.innerWidth), { timeout: 10_000 })
      .toBeGreaterThan(1200)

    await clickFile(app.page, LANDSCAPE.name, 'tab')
    const tab = tabHost(app.page, LANDSCAPE.name)
    await waitImageReady(tab)
    const fullscreen = app.page.getByTestId('workbench-fullscreen')
    await expect(fullscreen).toBeVisible({ timeout: 10_000 })
    await fullscreen.click()
    await expect(fullscreen).toHaveAccessibleName('回到窗口化', { timeout: 10_000 })
    await waitImageReady(tab)

    await expectControlsPersistent(app.page, tab)
    // 整屏更宽、且这个标签可能还带着右栏那轮的倍率：三格滚轮确保横图超出视口
    await ctrlWheelZoom(app.page, tab, 3)
    await dragPan(app.page, tab)
    const full = await geometryOf(app.page, 'preview-tool', LANDSCAPE.name)
    expectSameAspect(full, '整屏：拖拽平移后的横图')
    await snap(app.page, 'pan-fullscreen.png')
    console.log('[r93] 整屏平移后:', await panStateOf(tab.locator('[data-dsh-zoom-scrollport]')))

    // 复位：把"整屏"还给后面的收尾（本文件就此结束，但别留一个奇怪的窗口态）
    await fullscreen.click()
    await expect(fullscreen).toHaveAccessibleName('面板全屏', { timeout: 10_000 })
  })

  test('拖拽到四边 clamp：到 0 / 到 max 都不再越界', async () => {
    await clickFile(app.page, PORTRAIT.name, 'tab')
    const tab = tabHost(app.page, PORTRAIT.name)
    await waitImageReady(tab)

    // 这个标签在前面的用例里转过 90°、也缩放过：先复位，再切回适应窗口。
    const rotation = await tab.getByTestId('file-preview-image').getAttribute('data-rotation')
    if (rotation === '90') await tab.getByTestId('image-rotate-left').click()
    if (rotation === '270') await tab.getByTestId('image-rotate-right').click()
    await expect(tab.getByTestId('file-preview-image')).toHaveAttribute('data-rotation', '0')
    await ensureFit(app.page, tab)

    // 竖图放大四档：无论右栏多宽，宽、高两个方向都必须出现溢出，才能验四边。
    await ctrlWheelZoom(app.page, tab, 4)
    const port = tab.locator('[data-dsh-zoom-scrollport]')
    const before = await panStateOf(port)
    expect(before.overflowX, '宽度没有溢出，验不了左右边界').toBe(true)
    expect(before.overflowY, '高度没有溢出，验不了上下边界').toBe(true)
    console.log('[r93] clamp 起点:', JSON.stringify(before))

    // 往右下拖 → 滚动位置递减，应该在 0 处停住（不能变负、也不能反弹）
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await dragPanOnce(app.page, tab, 'min')
    }
    const min = await panStateOf(port)
    expect(min.left, `左边界没 clamp：${String(min.left)}`).toBeLessThanOrEqual(1)
    expect(min.top, `上边界没 clamp：${String(min.top)}`).toBeLessThanOrEqual(1)
    await snap(app.page, 'pan-clamp-min.png')

    // 往左上拖 → 滚动位置递增，应该在 max 处停住（scrollWidth/Height 已扣掉可视区）
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await dragPanOnce(app.page, tab, 'max')
    }
    const max = await panStateOf(port)
    expect(
      Math.abs(max.left - max.maxLeft),
      `右边界没 clamp：left=${String(max.left)} max=${String(max.maxLeft)}`
    ).toBeLessThanOrEqual(1)
    expect(
      Math.abs(max.top - max.maxTop),
      `下边界没 clamp：top=${String(max.top)} max=${String(max.maxTop)}`
    ).toBeLessThanOrEqual(1)
    console.log('[r93] clamp 到边:', JSON.stringify(max))
    await snap(app.page, 'pan-clamp.png')
  })

  test('真实 PDF（Office → 新阅读器）：鼠标拖拽选文不被平移接管', async () => {
    test.skip(!existsSync(KIT_CLI), '随包 LibreOffice kit 不在，跳过真实 PDF 选文回归')

    await clickFile(app.page, '报告.docx', 'tab')
    const tab = tabHost(app.page, '报告.docx')
    // 办公档转 PDF 用的是同一个 DshPdfViewer / ZoomViewport；这一步必须真转换成功
    await expect(tab.getByTestId('dsh-pdf-viewer')).toHaveAttribute('data-state', 'loaded', {
      timeout: 120_000
    })
    await expect(tab.getByTestId('dsh-pdf-page-surface').first()).not.toHaveAttribute('hidden', {
      timeout: 30_000
    })
    // 同一个 ZoomViewport：PDF 的滚动口不该带图片那侧的 pan 开关
    await expect(tab.locator('[data-dsh-zoom-scrollport]')).not.toHaveAttribute(
      'data-dsh-pan-enabled'
    )
    const layer = tab.locator('[data-testid="dsh-pdf-page-text"] .textLayer').first()
    await expect(layer).toBeAttached({ timeout: 30_000 })

    // 1) 文字层真的有内容：程序化选整层，拿到可读文本
    const layerText = await layer.evaluate((node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return selection?.toString() ?? ''
    })
    expect(layerText.trim().length, '文字层没选中任何东西').toBeGreaterThan(0)
    expect(layerText).toContain('R90')

    // 2) 清掉选区，用**真鼠标拖拽**横向扫过一行：PDF 没有 pan 接管，应该产生原生选区
    await app.page.evaluate(() => window.getSelection()?.removeAllRanges())
    const spans = layer.locator('span')
    const count = await spans.count()
    let target: Locator | undefined
    for (let index = 0; index < count; index += 1) {
      const candidate = spans.nth(index)
      const text = (await candidate.textContent())?.trim() ?? ''
      const box = await candidate.boundingBox()
      // pdf.js 可能按字符拆 span：只要这一格有字、有可拖的宽度就行（选中一个字也算选文）
      if (text.length >= 1 && box !== null && box.width > 5) {
        target = candidate
        break
      }
    }
    if (target === undefined) throw new Error('文字层没有可拖拽选中的 span')
    const box = await target.boundingBox()
    if (box === null) throw new Error('文字 span 没有盒子')
    await app.page.mouse.move(box.x + 2, box.y + box.height / 2)
    await app.page.mouse.down()
    await app.page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 })
    await app.page.mouse.up()

    const selected = await app.page.evaluate(() => window.getSelection()?.toString() ?? '')
    console.log('[r93] PDF 鼠标选文:', JSON.stringify(selected.slice(0, 40)))
    expect(selected.trim().length, '真实鼠标拖拽没有产生选区（PDF 选文被接管？）').toBeGreaterThan(
      0
    )
    await snap(app.page, 'pdf-selection.png')
  })
})
