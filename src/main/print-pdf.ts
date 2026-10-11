/**
 * printToPDF 的真实现（模块 4 的产物导出）：把 HTML 渲染成 PDF 字节。
 *
 * 为什么落在主进程这一侧：`printToPDF` 是 Electron 的窗口能力，而工具层（src/mastra/**）刻意
 * **不 import electron**（否则整条 agent 链路在 vitest/node 里跑不起来）。装配口径与 llama 二进制
 * 路径同路数：main 算好一个函数，经 createKyclawAgent 的 toolOptions 注进工具，
 * 工具只吃 `PdfPrinter` 这个形状（见 src/mastra/tools/artifacts.ts）。
 *
 * 实现要点：
 *   - **隐藏窗口**（show: false）：不打扰用户；宽度 794px ≈ A4@96dpi，高度给一屏（打印时按页重排）。
 *   - **关掉 javascript**（webPreferences.javascript: false）：产出的 HTML 是模型写的，打印只需要
 *     排版能力；关掉脚本就少一类"产出物里夹带脚本"的意外（模板本来就只写 HTML/CSS）。
 *     也顺带不用为它装 preload —— 这个窗口不听 IPC，也不给任何 Node 能力。
 *   - HTML 先落到**系统临时目录**再 loadFile：data: URL 有长度限制，而报告可能很大；
 *     临时目录不碰用户工作区、也不碰 %APPDATA%/kyclaw，收尾时整个删掉。
 *   - A4 + 0.5in 边距 + printBackground（报告模板的背景色/表头底色要打出来）。
 *     模板里的 `@page{size:A4}` 只声明纸张；边距以这里的参数为准（preferCSSPageSize 不打开，
 *     免得同一条链路两处都能改版式）。
 *   - 收尾一律 destroy 窗口 + 删临时目录（失败不掩盖真正的错误）。
 */
import { app, BrowserWindow } from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PdfPrinter } from '../mastra/tools/artifacts'

/** A4 @96dpi 的像素宽（窗口按纸张宽度排版，打印时按页高重排） */
const PAGE_WIDTH_PX = 794
const PAGE_HEIGHT_PX = 1123

/** 边距（英寸；Electron 21+ 的 printToPDF 以英寸计） */
const MARGIN_INCH = 0.5

export const printPdf: PdfPrinter = async (html) => {
  // app 没起来时 BrowserWindow 建不出来（正常路径不会走到：工具只在服务跑起来后被调）
  if (!app.isReady()) await app.whenReady()

  const dir = await mkdtemp(join(app.getPath('temp'), 'kyclaw-print-'))
  const file = join(dir, 'report.html')
  await writeFile(file, html, 'utf8')

  const window = new BrowserWindow({
    show: false,
    width: PAGE_WIDTH_PX,
    height: PAGE_HEIGHT_PX,
    webPreferences: {
      // 打印只需要排版：不给脚本、不给 Node、不给 preload
      javascript: false,
      sandbox: true,
      contextIsolation: true
    }
  })

  try {
    await window.loadFile(file)
    return await window.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: {
        top: MARGIN_INCH,
        bottom: MARGIN_INCH,
        left: MARGIN_INCH,
        right: MARGIN_INCH
      }
    })
  } finally {
    if (!window.isDestroyed()) window.destroy()
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // 临时目录没删掉只影响磁盘占用，不该盖住"打印失败"的真实错误
    })
  }
}
