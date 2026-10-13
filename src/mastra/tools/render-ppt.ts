/**
 * render_ppt：把 .pptx 逐页渲染成 PNG，并把**页图直接交给模型看**（交付前自检）。
 *
 * 为什么需要它：这一轮实测的差距不在"写不出来"，而在**从头到尾没看过自己的产出** ——
 * 缺来源、占位页、"—"空值、版式失衡，全是"看到图就能发现、只看文本发现不了"的问题。
 * 所以这个工具的产出分两份：**页图**（进模型上下文）+ **逐页文字**（用来核对措辞与空值）。
 *
 * 三条硬口径：
 *   1. **渲染不出来不抛异常、不假装成功**：回一段人话 + 结构自检（逐页文字），让模型退化成
 *      "只核文字"，并在回执里说清为什么退化、缺什么。
 *   2. **渲染器是"有就用、没有就退化"，优先级写死**：① 随包的 LibreOffice（round 68，
 *      `resources/libreoffice-kit`，跨平台、**不依赖用户装没装 Office**）→ ② Windows 上的
 *      PowerPoint COM（`PowerPoint.Application`，实测可用）→ ③ 都没有就只回逐页文字结构。
 *      **不把 Office 列成依赖**，也不去 PATH 上找系统的 `soffice`。
 *   3. **页图写进会话工作区**（`<deck 名>_页图/`）：用户能在工作台里自己翻，模型也能再引用；
 *      只动这个由我们派生的目录，不碰用户的文件。**这条正是它免审的前提**（权限分级把它按
 *      只读档放行，见 `main/permission/classify.ts`）：派生目录若解析到工作区外（有人把它
 *      做成了指向外面的链接）就整体拒绝、一个文件都不写。
 *
 * round 73 补一条：**用户点停止 = 这次渲染停**。`context.abortSignal` 一路传进
 * `runProcess`（渲染子进程按 exec 那套杀法收掉）；信号在开始前就响的话**一个文件都不动**
 * （不清、不建页图目录），回执走 abortedMessage —— "已被用户中止"不是"渲染器失败"。
 *
 * 为什么随包 LibreOffice（round 68 实测口径，见 `.superpowers/sdd/.../_r68-*`）：
 *   - 它是 DeepSeek Harness 开源的 `@deepseek-ai/libreoffice-kit`（MPL-2.0）：预编译引擎 + 一层
 *     Node 包装，一次调用出**全量页图 + `manifest.json`**（带 `sourceSha256`、每页像素尺寸、
 *     `missingFonts`）。在此之前只有 PowerPoint COM 一条路 —— 非 Windows 或没装 Office 的机器上
 *     视觉自检直接做不了，技能里那条"能不能渲染"的部署事实也就跟着失真。
 *   - **跑法**：`ELECTRON_RUN_AS_NODE=1 <process.execPath> <cli.js> render …`（实测可用）。这样不必
 *     像 dsh 那样再随包一个独立 `node.exe`（它为此多背了几十 MB）：dsh 那边有
 *     `packaged applications must supply a standalone Node executable` 这条约束，而 kit 0.1.5 自身
 *     没有这种检查（`lib/*.js` 里 grep 不到 `isSea` / `process.versions.electron` / `process.execPath`），
 *     实测 Electron 44（Node 24.21）下 `capabilities --json` 与真渲染都通，**连 build:unpack 出来的
 *     kyclaw.exe 也一样**（命令与原始输出见 `_r68-libreoffice-real.spec.ts`）。
 *   - 浏览器侧没有可信的 PPT 高保真渲染（工作台预览因此只给文字提要，见 PptxPreview 头注）。
 *
 * 模型看图的链路口径（**已实测**，见 `__tests__/render-ppt.spec.ts` 与探针
 * `.superpowers/sdd/.../_r68-probe/tool-image-shapes.mjs`）：
 *   `toModelOutput` 回 `{type:'content', value:[{type:'text'…}, {type:'file', mediaType:'image/png',
 *   data:{type:'url', url:'data:image/png;base64,…'}}]}` —— AI SDK 会把 `file` 翻成 tool 消息里
 *   的 `image_url`，真 provider（deepseek-flash）确实读到了图。**别用 `image-url`**：那是废弃形状，
 *   AI SDK 7 会抛 `Invalid URL`（实测）。
 *
 * 输出形状为什么是对象而不是字符串：`toModelOutput` 只拿得到工具的 output，要读盘把页图转成
 * data URL 就得知道绝对路径。对象里**不含图片字节**（界面上的工具卡会把 output 序列化后截 600 字，
 * 塞 base64 进去会把卡片撑爆）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { extractPptx } from '../../main/workbench-office'
import { resolveInsideWorkspace } from '../../main/permission/realpath'
import { runProcess } from './exec'
import {
  approvalSessionOf,
  needsApproval,
  sessionKey,
  statOrNull,
  toolTarget,
  type ToolContext
} from './guard'

/** PowerPoint COM 那条路的导出分辨率（16:9，`Export` 强制定死宽高）。
 *  1600×900 的页图约 880 tokens/页（实测），够看清版式又不至于太贵 */
export const RENDER_WIDTH = 1600
export const RENDER_HEIGHT = 900

/**
 * 随包 LibreOffice 的渲染 dpi（96 = 幻灯片尺寸的 1:1）。
 * kit 只能按 dpi 缩放、不能像 COM 那样点定死宽高，所以给个常数：**我们生成的 16:9 deck 是
 * 10in×5.625in，144dpi 出来正好 1440×810** —— 与 COM 那条路的 1600×900 同一量级
 * （实测同一份 6 页 deck：kit 1441×811 / COM 1600×900，逐页对看无差）。实际尺寸从 kit 的
 * `manifest.json` 读，回执里报的是**实测值**而不是这个常数。
 */
export const LIBREOFFICE_DPI = 144

/** 一次调用最多**附几张图**给模型看（渲染仍然全量落盘；页数多时让模型分批指定 pages） */
export const MAX_ATTACHED_PAGES = 12

/** 渲染超时：渲染器冷启动 + 大份演示文稿都要时间（实测 PowerPoint 6 页 8s、LibreOffice 6 页 9s） */
export const RENDER_TIMEOUT_MS = 180_000

/** 页图目录的后缀（派生目录，只由我们重建） */
const PAGES_DIR_SUFFIX = '_页图'

/** 随包 kit 渲染时的暂存目录后缀（kit 要求 `--output-dir` 是不存在的新目录，见 renderWithLibreOffice） */
const KIT_STAGING_SUFFIX = '.libreoffice-tmp'

/**
 * 渲染器：**探测顺序就是优先级**（详见文件头注）。
 *   - `'libreoffice'`：随包的 kit（跨平台，不依赖用户装没装 Office）；
 *   - `'powerpoint'`：Windows 上的 PowerPoint COM；
 *   - `'none'`：两条都没有 —— 只会回逐页文字结构。
 */
export type PptRenderer = 'libreoffice' | 'powerpoint' | 'none'

/** 强制指定渲染器（测试与排障用）：'libreoffice' | 'powerpoint' | 'none' */
const RENDERER_ENV = 'KYCLAW_PPT_RENDERER'

/** 直接指向 POWERPNT.EXE 的排障逃生门（非标准安装位置） */
const POWERPOINT_ENV = 'KYCLAW_POWERPOINT'

/** 直接指向**随包 kit 根目录**的逃生门（排障用：换一份 kit、或指到别处的安装） */
const KIT_DIR_ENV = 'KYCLAW_LIBREOFFICE_KIT'

/** 随包 kit 的入口（相对 kit 根目录；`pnpm fetch:libreoffice-kit` 落的 npm 平铺布局） */
const KIT_CLI_RELATIVE = join('node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')

/** kit 根目录名（extraResources 把它放在 `<resources>/libreoffice-kit`，仓库里在 `resources/`） */
const KIT_DIR_NAME = 'libreoffice-kit'

/** Office 的常见安装位置（相对各 Program Files 根） */
const POWERPOINT_RELATIVE_PATHS = [
  'Microsoft Office/root/Office16/POWERPNT.EXE',
  'Microsoft Office/Office16/POWERPNT.EXE',
  'Microsoft Office/root/Office15/POWERPNT.EXE',
  'Microsoft Office/Office15/POWERPNT.EXE',
  'Microsoft Office/root/Office14/POWERPNT.EXE',
  'Microsoft Office/Office14/POWERPNT.EXE'
]

export interface RendererDeps {
  /** 探测渲染器（缺省 = 真探测；测试注入） */
  detect?: () => PptRenderer
  /**
   * 跑一次渲染（缺省 = 按探测结果跑真实现；测试注入）。
   * 第三个参数是用户中止信号（round 73）：真实现把它传给 `runProcess`（子进程会被收掉）；
   * 注入件可以忽略它（老注入点一个都不用改）。
   */
  render?: (deck: string, outDir: string, signal?: AbortSignal) => Promise<RenderOutcome>
  /** 平台（缺省 = process.platform） */
  platform?: NodeJS.Platform
  /**
   * 随包 kit 的 CLI 绝对路径。缺省 = 真去找（见 kitRootCandidates）；
   * **测试注入 `null`** 表示"这台机器没有随包渲染器"，免得探测结果随开发机变。
   */
  kitCli?: string | null
}

/** 一次渲染的结论：成不成、为什么、以及渲染器自报的页图尺寸与缺字 */
export interface RenderOutcome {
  ok: boolean
  /** 失败原因（人话；ok 时为空串） */
  detail: string
  /**
   * 被用户中止（round 73；与"渲染器失败"分开报 —— 回执要说"已被用户中止"，
   * 不能让它读成"这台机器渲染不了"）。缺省/undefined = 不是中止。
   */
  aborted?: boolean
  /** 页图像素尺寸（**渲染器实测**，不是我们要求的；拿不到就不写） */
  size?: { width: number; height: number }
  /** 渲染器报告的缺失字体（`undefined` = 它没给这个信息；空数组 = 查过且没缺） */
  missingFonts?: string[]
}

/** 探测结果缓存（一次进程只探一次；COM 探测要起一个 PowerShell，别每轮都来） */
let cachedRenderer: PptRenderer | null = null

/** 清缓存（测试用） */
export function resetRendererCache(): void {
  cachedRenderer = null
}

/**
 * 随包 kit 的根目录候选（按优先级；第一个真的有 CLI 的为准）。
 * 三个来源对应三种跑法，**都是路径存在性判断，不起进程**：
 *   1. 环境变量显式指定（排障 / 内测换一份 kit）；
 *   2. **打包态**：extraResources 把仓库的 `resources/libreoffice-kit` 原样放到
 *      `<install>/resources/libreoffice-kit`，即 `process.resourcesPath/libreoffice-kit`
 *      （与 llama / skills 同一个范式，见 `src/main/index.ts`）；
 *   3. **开发态**：仓库里那份（`pnpm fetch:libreoffice-kit` 落的，不入库）—— 先看进程工作目录
 *      （`electron-vite dev` / vitest 的工作目录就是仓库根），再从本模块所在目录往上找
 *      （打包成 CJS 后模块目录是 `out/main`，往上两层就是仓库根）。
 */
function kitRootCandidates(): string[] {
  const candidates: string[] = []
  const explicit = process.env[KIT_DIR_ENV]?.trim()
  if (explicit !== undefined && explicit !== '') candidates.push(explicit)
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(join(process.resourcesPath, KIT_DIR_NAME))
  }
  candidates.push(join(process.cwd(), 'resources', KIT_DIR_NAME))
  for (const ancestor of moduleAncestors()) {
    candidates.push(join(ancestor, 'resources', KIT_DIR_NAME))
  }
  return candidates
}

/**
 * 本模块所在目录往上几层。electron-vite 把主进程打成 CJS，`__dirname` 就是 `out/main`；
 * 但这段代码也会在测试的 ESM 里跑（那里没有 `__dirname`），所以先 `typeof` 探一下再走。
 */
function moduleAncestors(): string[] {
  if (typeof __dirname !== 'string' || __dirname === '') return []
  const out: string[] = []
  let dir = __dirname
  for (let level = 0; level < 3; level += 1) {
    dir = dirname(dir)
    out.push(dir)
  }
  return out
}

/**
 * 找随包 kit 的 CLI（找不到回 null）。
 * 只看文件在不在：**探测不启动任何进程**（真起一次要几秒），AI 真的渲染时起不来会在回执里说清。
 */
export function resolveKitCli(): string | null {
  for (const root of kitRootCandidates()) {
    const cli = join(root, ...KIT_CLI_RELATIVE.split(sep))
    if (existsSync(cli)) return cli
  }
  return null
}

/** 探测时用的 kit CLI：注入了就用注入的（`null` = 明确表示"没有"），否则真去找 */
function kitCliFor(options: RendererDeps): string | null {
  return options.kitCli !== undefined ? options.kitCli : resolveKitCli()
}

/**
 * 找一个能用的 PPT 渲染器，**按优先级**（顺序就是文件头注里那三条）：
 *   0. 环境变量显式指定（测试 / 排障）；
 *   1. **随包的 LibreOffice kit**（跨平台；只看文件在不在，不起进程）——放第一位是因为它可预期：
 *      用户装没装 Office、在哪个平台都不影响它；
 *   2. 没 kit 才轮到 Windows 的 PowerPoint COM：先扫 Office 常见安装位置（不起进程，绝大多数
 *      机器在这里就命中），没中才真问一次 COM（`New-Object -ComObject PowerPoint.Application`）——
 *      MSI / 商店版 Office 装在别处时靠它兜住，没装 Office 时它是**快速失败**（注册表查不到）；
 *   3. 两条都没有 → `'none'`。结论缓存起来，后续调用不再付这份代价。
 *
 * **非 Windows 且没有随包 kit** 才是 `'none'`（本实现的第二条路只有 COM）；有 kit 的机器上，
 * 任何平台都回 `'libreoffice'` —— 这正是 round 68 要的："没有 PowerPoint"不等于"不能渲染"。
 */
export function detectRenderer(options: RendererDeps = {}): PptRenderer {
  const forced = process.env[RENDERER_ENV]?.trim().toLowerCase()
  if (forced === 'none' || forced === 'off') return 'none'
  if (forced === 'libreoffice' || forced === 'kit' || forced === 'soffice') return 'libreoffice'
  if (forced === 'powerpoint') return 'powerpoint'

  if (cachedRenderer !== null) return cachedRenderer

  if (kitCliFor(options) !== null) {
    cachedRenderer = 'libreoffice'
    return cachedRenderer
  }

  if ((options.platform ?? process.platform) !== 'win32') {
    cachedRenderer = 'none'
    return cachedRenderer
  }

  const explicit = process.env[POWERPOINT_ENV]?.trim() ?? ''
  if (explicit !== '' && existsSync(explicit)) {
    cachedRenderer = 'powerpoint'
    return cachedRenderer
  }

  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432
  ].filter((root): root is string => typeof root === 'string' && root !== '')

  for (const root of roots) {
    for (const suffix of POWERPOINT_RELATIVE_PATHS) {
      if (existsSync(join(root, ...suffix.split('/')))) {
        cachedRenderer = 'powerpoint'
        return cachedRenderer
      }
    }
  }

  cachedRenderer = comProbePowerPoint() ? 'powerpoint' : 'none'
  return cachedRenderer
}

/**
 * 真问一次 COM：PowerPoint 在不在这个系统上（覆盖非标准安装位置）。
 * **同步**跑（探测只发生一次，且要就地判结论）：失败一律当"没有"，不抛。
 */
function comProbePowerPoint(): boolean {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$before = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue).Count',
    'try { $app = New-Object -ComObject PowerPoint.Application } catch { exit 3 }',
    // 只关我们自己起的那一个：本来就在跑的 PowerPoint 不能被我们顺手关掉（用户可能正开着文件）
    'if ($before -eq 0) { try { $app.Quit() } catch { } }',
    "Write-Output 'ok'"
  ].join('\n')

  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 30_000, windowsHide: true, encoding: 'utf8' }
  )
  return result.status === 0 && String(result.stdout).includes('ok')
}

/** PowerShell 单引号字符串里的撇号要写两遍 */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * 渲染脚本：PowerPoint COM 逐页导出 PNG。
 *
 * 两处**刻意**的写法：
 *   - `Presentations.Open(deck, ReadOnly:=$true, Untitled:=$false, WithWindow:=$false)`：不开窗口、
 *     不改原文件（只读）——自检不该打扰用户，也不该动被检查的那份产出。
 *   - `$before` 那道闸：`New-Object -ComObject` 在 PowerPoint 已经运行时是**附着到既有实例**，
 *     此时 `Quit()` 会把用户正开着的 PowerPoint 一起关掉。只有"本来没在跑"才允许退出。
 */
function renderScript(deck: string, outDir: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    // 不声明输出编码时，管道里拿到的是系统 ANSI（本机 936）——中文错误信息会变乱码
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$deck = ${psQuote(deck)}`,
    `$out = ${psQuote(outDir)}`,
    '$before = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue).Count',
    '$app = $null',
    '$pres = $null',
    'try {',
    '  $app = New-Object -ComObject PowerPoint.Application',
    '  $pres = $app.Presentations.Open($deck, $true, $false, $false)',
    `  $pres.Export($out, 'PNG', ${RENDER_WIDTH}, ${RENDER_HEIGHT})`,
    '} finally {',
    '  if ($pres -ne $null) { try { $pres.Close() } catch { } }',
    '  if ($app -ne $null -and $before -eq 0) { try { $app.Quit() } catch { } }',
    '}',
    "Write-Output 'ok'"
  ].join('\n')
}

/** 跑一次真渲染：PowerPoint COM 写 PNG 到 outDir（目录由调用方建好、清空） */
async function renderWithPowerPoint(
  deck: string,
  outDir: string,
  signal?: AbortSignal
): Promise<RenderOutcome> {
  const result = await runProcess({
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', renderScript(deck, outDir)],
    timeoutMs: RENDER_TIMEOUT_MS,
    signal
  })

  if (result.spawnError !== null) {
    return { ok: false, detail: `起不了 PowerShell：${result.spawnError.message}` }
  }
  if (result.aborted) {
    return { ok: false, aborted: true, detail: '渲染已被用户中止' }
  }
  if (result.timedOut) {
    return { ok: false, detail: `渲染超时（超过 ${RENDER_TIMEOUT_MS / 1000} 秒）` }
  }
  if (result.exitCode !== 0) {
    const reason = result.text.trim().split('\n').slice(-3).join(' ').slice(0, 300)
    return { ok: false, detail: reason === '' ? `退出码 ${result.exitCode}` : reason }
  }
  // 尺寸是 `Export(out, 'PNG', 1600, 900)` 里**我们强制的**，不是它自报的 —— 如实按它说
  return { ok: true, detail: '', size: { width: RENDER_WIDTH, height: RENDER_HEIGHT } }
}

/** kit 的 `manifest.json` 里我们真正用到的字段（其余字段不解析，免得跟着上游 schema 起落） */
interface KitManifest {
  missingFonts?: unknown
  images?: unknown
}

/**
 * 从 kit 的 manifest 里取"页图尺寸"与"缺字"。
 * 读不出/字段形状不对就都不给（回执里就不说尺寸）—— 自检工具不该因为上游多一个字段就崩。
 */
function readKitManifest(text: string): Pick<RenderOutcome, 'size' | 'missingFonts'> {
  try {
    const manifest = JSON.parse(text) as KitManifest
    const out: Pick<RenderOutcome, 'size' | 'missingFonts'> = {}
    const first = Array.isArray(manifest.images) ? (manifest.images[0] as unknown) : undefined
    if (typeof first === 'object' && first !== null) {
      const { width, height } = first as { width?: unknown; height?: unknown }
      if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
        out.size = { width, height }
      }
    }
    if (Array.isArray(manifest.missingFonts)) {
      out.missingFonts = manifest.missingFonts.filter(
        (name): name is string => typeof name === 'string'
      )
    }
    return out
  } catch {
    return {}
  }
}

/**
 * kit 失败时在 **stdout** 上回一行 `{"code":"…","error":"…"}` 的 JSON（实测三种：输入不存在 /
 * 输出目录已存在 / 不是 OOXML），退出码 1。取出来当人话原因；不是 JSON 就退回原文尾部。
 */
function kitFailureDetail(text: string): string {
  const last = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .pop()
  if (last !== undefined) {
    try {
      const parsed = JSON.parse(last) as { code?: unknown; error?: unknown }
      if (typeof parsed.error === 'string') {
        return typeof parsed.code === 'string'
          ? `LibreOffice 渲染器报错：${parsed.error}（${parsed.code}）`
          : `LibreOffice 渲染器报错：${parsed.error}`
      }
    } catch {
      // 不是 JSON 就往下走原文
    }
  }
  const tail = text.trim().split('\n').slice(-3).join(' ').slice(0, 300)
  return tail === '' ? 'LibreOffice 渲染器没有给出原因' : `LibreOffice 渲染器报错：${tail}`
}

/**
 * 跑一次真渲染：随包的 LibreOffice kit 写 PNG 到 outDir（目录由调用方建好、清空）。
 *
 * 两个**实测出来**的要点：
 *   1. **怎么起它**：`ELECTRON_RUN_AS_NODE=1 <process.execPath> <cli.js> render …` —— 用 Electron
 *      自带的 Node 模式跑，不必随包一个独立 `node.exe`（dsh 的 kit 0.1.2 要求必须给独立 Node 才能
 *      在打包应用里跑，0.1.5 已经没有那条约束；实测 Electron 44 / Node 24 下 `capabilities --json`
 *      与真渲染都通）。`process.execPath` 在开发态是 electron.exe、打包态是 kyclaw.exe，同一份代码。
 *   2. **输出目录必须是"不存在的新目录"**：kit 自己 `mkdir`（非递归）+ `manifest.json` 用 `wx`
 *      独占写，目录已存在就直接 `EEXIST` 失败（实测）。我们的页图目录是"先清空再重建"的，所以
 *      先渲到**同级暂存目录**，再把页图 rename 进页图目录（同盘 rename = 挪指针），最后删掉暂存。
 *      这样失败的中间产物不会留在用户的页图目录里，也不会在会话工作区乱丢文件。
 *
 * 它一次调用出**全量**页图（`pages` 默认 all，上限 100 页）——与 PowerPoint 那条路的"渲染全量、
 * 只附几页给模型"一致。
 */
async function renderWithLibreOffice(
  deck: string,
  outDir: string,
  cli: string,
  signal?: AbortSignal
): Promise<RenderOutcome> {
  const staging = `${outDir}${KIT_STAGING_SUFFIX}`
  await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  try {
    const result = await runProcess({
      command: process.execPath,
      args: [
        cli,
        'render',
        '--input',
        deck,
        '--output-dir',
        staging,
        '--dpi',
        String(LIBREOFFICE_DPI)
      ],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: RENDER_TIMEOUT_MS,
      signal
    })

    if (result.spawnError !== null) {
      return {
        ok: false,
        detail: `起不了随包的 LibreOffice（${cli}）：${result.spawnError.message}`
      }
    }
    if (result.aborted) {
      return { ok: false, aborted: true, detail: '渲染已被用户中止' }
    }
    if (result.timedOut) {
      return { ok: false, detail: `渲染超时（超过 ${RENDER_TIMEOUT_MS / 1000} 秒）` }
    }
    if (result.exitCode !== 0) {
      return { ok: false, detail: kitFailureDetail(result.text) }
    }

    const manifest = await readFile(join(staging, 'manifest.json'), 'utf8')
      .then(readKitManifest)
      .catch(() => ({}) as Pick<RenderOutcome, 'size' | 'missingFonts'>)

    // 只搬 PNG（manifest 是我们派生的目录里的外来物，页图目录的契约就是"一页一张 PNG"）
    await mkdir(outDir, { recursive: true })
    let moved = 0
    for (const entry of await readdir(staging, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.png$/i.test(entry.name)) continue
      await rename(join(staging, entry.name), join(outDir, entry.name))
      moved += 1
    }
    if (moved === 0) {
      return { ok: false, detail: '导出命令跑完了，但 kit 没有给出任何页图' }
    }
    return { ok: true, detail: '', ...manifest }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** `幻灯片12.PNG` / `Slide12.PNG` → 12（取名字里最后一个整数；认不出给 0） */
export function pageNumberOf(name: string): number {
  const matched = /(\d+)(?=\.[^.]+$)/.exec(name)
  return matched === null ? 0 : Number(matched[1])
}

/** 页图清单：只认 PNG，按页码排（PowerPoint 的文件名前缀随 Office 语言变，不能按名字比大小） */
export function sortPageFiles(names: readonly string[]): string[] {
  return names
    .filter((name) => /\.png$/i.test(name))
    .sort((left, right) => {
      const diff = pageNumberOf(left) - pageNumberOf(right)
      return diff === 0 ? left.localeCompare(right) : diff
    })
}

export const renderPptInputSchema = z.object({
  path: z.string().min(1).describe('Path to the .pptx, relative to the session workspace'),
  pages: z
    .array(z.number().int().min(1))
    .optional()
    .describe(
      `Which page images to show you this call, e.g. [2,5]; defaults to the first ${MAX_ATTACHED_PAGES} pages`
    )
})

export type RenderPptInput = z.infer<typeof renderPptInputSchema>

const pageEntrySchema = z.object({
  /** 页码（1 起） */
  index: z.number(),
  /** 工作区相对路径（给模型与用户看） */
  path: z.string(),
  /** 绝对路径（toModelOutput 读盘用；也是回执里能直接用的那个） */
  abs: z.string(),
  bytes: z.number()
})

export const renderPptResultSchema = z.object({
  /** 一句话回执（模型看到的正文；界面上的工具卡也显示它） */
  message: z.string(),
  renderer: z.enum(['libreoffice', 'powerpoint', 'none']),
  /** 页图目录（工作区相对路径；渲染不出来时没有） */
  dir: z.string().optional(),
  /** 落盘的页图（全量，不只附给你的那几页） */
  pages: z.array(pageEntrySchema),
  /** 这一次**附给模型看**的页码 */
  attached: z.array(z.number()),
  /** 逐页文字（渲染不出来时的结构自检，也是措辞/空值的核对底稿） */
  outline: z.array(
    z.object({ index: z.number(), title: z.string().optional(), lines: z.array(z.string()) })
  )
})

export type RenderPptResult = z.infer<typeof renderPptResultSchema>

/** 逐页文字拼成紧凑清单（页码 + 标题 + 正文行） */
function outlineText(outline: RenderPptResult['outline']): string {
  return outline
    .map((slide) => {
      const head = `第 ${slide.index} 页：${slide.title ?? '（没有标题）'}`
      return slide.lines.length === 0 ? head : `${head}\n   ${slide.lines.join('\n   ')}`
    })
    .join('\n')
}

/** 渲染不出来时的回执（人话 + 为什么 + 退化成什么；绝不假装成功） */
function degradedMessage(detail: string, outline: RenderPptResult['outline']): string {
  // 两条路都没有才是这个原因：随包 LibreOffice 没装上 + 本机也没有 PowerPoint
  const why = detail === '' ? '本机既没有随包渲染器，也没有检测到 PowerPoint' : detail
  return [
    `没能渲染页图（${why}）。`,
    '这次只做了**结构自检**：下面是这份演示文稿逐页的真实文字，请逐页核一遍——',
    '有没有无信息页（"谢谢观看"这类套话）、有没有"待定/—"这类占位、有没有写了却拿不出出处的说法、',
    '页数与你要的是否一致。核完把不合格的改掉再交付，**不要**在没看过产出的情况下说"已完成"。',
    '',
    outlineText(outline)
  ].join('\n')
}

/**
 * 用户中止时的回执（round 73）：与 bash / git 同一口径 —— 明说是"被中止"，
 * **不能**走 degradedMessage（那会读成"渲染器不行"，下一轮就可能得出"这台机器渲染不了"的错误结论）。
 */
function abortedMessage(outline: RenderPptResult['outline']): string {
  const lines = [
    '已被用户中止：这次没有渲染页图（你点了停止，渲染没有开始或已终止）。',
    '这不是渲染器的问题，别据此判断"本机渲染不了"；要接着自检就再调一次 render_ppt。'
  ]
  if (outline.length > 0) {
    lines.push(
      '',
      '下面是中止前已经读出来的逐页文字（可以先用它核措辞与空值）：',
      outlineText(outline)
    )
  }
  return lines.join('\n')
}

export async function createRenderPptTool(
  ctx: ToolContext,
  options: RendererDeps = {}
): Promise<Tool<RenderPptInput, RenderPptResult>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'render_ppt',
    // 描述刻意短：细节（什么时候必须调、看什么）在 pptx 技能手册里
    description:
      'Render .pptx pages to PNGs and show you the images (pre-delivery check); no renderer means ' +
      'page text plus the reason. Read-only.',
    inputSchema: renderPptInputSchema,
    outputSchema: renderPptResultSchema,
    /**
     * 免审（round 68 修订）：`classifyToolCall('render_ppt')` 是**只读档** —— 它是"把已有 deck
     * 逐页导成页图给模型看"的派生只读动作，写入只落在 `<deck 名>_页图/`。判定仍走 guard 这一处
     * （分类是唯一的事实来源），不是就地 return false。
     * **免审不等于免封**：执行路径照样先 toolTarget（越界 fail closed）、派生目录再单独过一遍
     * 引擎（见下面的 outDirResolved），两条都不通就一个文件都不写。
     */
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'render_ppt', input, approvalSessionOf(approval)),
    execute: async (input, context): Promise<RenderPptResult> => {
      const session = sessionKey(context)
      const { abs: deck, workspace } = toolTarget(ctx, input.path, session)

      if (!/\.pptx$/i.test(deck)) {
        throw new Error(`render_ppt 只渲染 .pptx（给的是 ${basename(deck)}）`)
      }
      const deckStat = await statOrNull(ctx, deck)
      if (deckStat === null || !deckStat.isFile()) {
        throw new Error(`render_ppt 失败：${input.path} 不存在（先确认产出落在哪个路径）`)
      }

      const rel = (target: string): string => relative(workspace.path, target).split(sep).join('/')

      // 结构自检的底稿：渲染成不成功都读（措辞与空值只有文字能核）
      let outline: RenderPptResult['outline'] = []
      try {
        outline = extractPptx(await ctx.fs.readFile(deck)).slides
      } catch {
        // 读不出结构不是致命错误：渲染成功时页图本身就够看；两条都没拿到会在下面如实说
      }

      const renderer = (options.detect ?? (() => detectRenderer(options)))()
      if (renderer === 'none') {
        return {
          message: degradedMessage('', outline),
          renderer: 'none',
          pages: [],
          attached: [],
          outline
        }
      }

      // 用户点停止（round 73）：信号在渲染开始之前就响了 —— 一个文件都不动（页图目录不清、不建、
      // 不渲染）。"停止"最不该有的结果就是"还是把你的页图目录清了一遍"。
      const signal = context.abortSignal
      if (signal?.aborted === true) {
        return { message: abortedMessage(outline), renderer, pages: [], attached: [], outline }
      }

      // 页图目录 = deck 旁边的派生目录。**写入只允许落在这里**，所以先过一遍引擎：
      // deck 本身已经被 toolTarget 归一进工作区，dirname 必定在里面；但派生目录可能是别人
      // 预先做好的链接（指到工作区外），那时免审就等于"可以在工作区外建目录/写盘"。
      // 越界一律拒绝，**下面一行都不执行**（不删、不建、不渲染）。
      const outDirCandidate = join(
        dirname(deck),
        `${basename(deck).replace(/\.pptx$/i, '')}${PAGES_DIR_SUFFIX}`
      )
      const outDirResolved = resolveInsideWorkspace(workspace.path, outDirCandidate)
      if (!outDirResolved.ok) {
        throw new Error(
          `render_ppt 拒绝写页图：派生目录不在工作区内（${outDirResolved.reason}）——` +
            '页图只会落在 deck 旁边的 `<deck 名>_页图/` 里'
        )
      }
      const outDir = outDirResolved.abs
      const outRel = rel(outDir)

      // 页图目录是**我们派生的**：先整个清掉再重建，免得上一版多出来的页留在里面冒充这一次的产出。
      // 整段（清目录 → 渲染 → 收页图清单）都在同一把锁里：两次 render_ppt 撞同一个 deck 时，
      // 后一次不会在前一次刚清完目录、还没导出完的时候插进来。
      const kitCli = renderer === 'libreoffice' ? kitCliFor(options) : null
      /**
       * 真正跑的那个实现：**注入的 render 优先**（单测与排障）→ 探测命中的那个走真实现。
       * 探测说 `'libreoffice'` 却找不到 CLI，只可能是被人为硬指的（`KYCLAW_PPT_RENDERER` /
       * 注入的 detect）：这时如实退化，**不悄悄改用 PowerPoint** —— 回执里的渲染器名会跟着说谎。
       * 真实现那条路（两条都是）把 `signal` 传给 `runProcess`：用户点停止时渲染子进程会被收掉。
       */
      const render:
        ((deckPath: string, dir: string, abort?: AbortSignal) => Promise<RenderOutcome>) | null =
        options.render ??
        (renderer === 'libreoffice'
          ? kitCli === null
            ? null
            : (deckPath, dir, abort) => renderWithLibreOffice(deckPath, dir, kitCli, abort)
          : renderWithPowerPoint)

      if (render === null) {
        return {
          message: degradedMessage(
            '探测指定了随包的 LibreOffice 渲染器，但没找到它（`resources/libreoffice-kit` 没装上）',
            outline
          ),
          renderer,
          pages: [],
          attached: [],
          outline
        }
      }

      const outcome = await ctx.state.runExclusive(outDir, async () => {
        await ctx.fs.remove(outDir, { recursive: true }).catch(() => undefined)
        await ctx.fs.mkdir(outDir)
        const rendered = await render(deck, outDir, signal)
        if (!rendered.ok) return { rendered, pages: [] as RenderPptResult['pages'] }

        const names = sortPageFiles((await ctx.fs.readdir(outDir)).map((entry) => entry.name))
        const pages = await Promise.all(
          names.map(async (name, position) => {
            const abs = join(outDir, name)
            const stat = await statOrNull(ctx, abs)
            return {
              index: pageNumberOf(name) || position + 1,
              path: `${outRel}/${name}`,
              abs,
              bytes: stat?.size ?? 0
            }
          })
        )
        return { rendered, pages }
      })

      const pages: RenderPptResult['pages'] = outcome.pages
      // 用户中止（round 73）：与"渲染器失败"分开报 —— 别让模型据此判断"这台机器渲染不了"
      if (outcome.rendered.aborted === true) {
        return { message: abortedMessage(outline), renderer, pages: [], attached: [], outline }
      }
      if (!outcome.rendered.ok || pages.length === 0) {
        const detail =
          outcome.rendered.ok && pages.length === 0
            ? '导出命令跑完了，但没有拿到任何页图'
            : outcome.rendered.detail
        return {
          message: degradedMessage(detail, outline),
          renderer,
          pages: [],
          attached: [],
          outline
        }
      }

      // 附给模型看的页码：显式 pages 优先；不填就看头 MAX_ATTACHED_PAGES 页
      const asked = input.pages ?? []
      const pool = asked.length === 0 ? pages : pages.filter((page) => asked.includes(page.index))
      const visible = pool.slice(0, MAX_ATTACHED_PAGES)
      const attached = visible.map((page) => page.index)
      const skipped = pool.length - visible.length

      const size = outcome.rendered.size
      const notes: string[] = [
        size === undefined
          ? `已渲染 ${pages.length} 页，页图在 ${outRel}/。`
          : `已渲染 ${pages.length} 页（${size.width}×${size.height}），页图在 ${outRel}/。`,
        asked.length === 0
          ? `上面直接附了第 ${attached.join('、')} 页的**图**给你看。`
          : `上面直接附了你点名的第 ${attached.join('、')} 页的图。`
      ]
      // 缺字只有渲染器知道（PPTX 里声明的字体在本机找不到）：页图会"看着像但字形不对"，
      // 不说清楚的话模型会当成版式问题去改设计。有才说，空数组不占篇幅。
      const missingFonts = outcome.rendered.missingFonts ?? []
      if (missingFonts.length > 0) {
        notes.push(
          `注意：渲染器报告本机**缺这些字体**：${missingFonts.join('、')} —— 页图里对应的文字` +
            '可能不是你写的那套字形，版式也可能被替换字体挤歪。这属于"字体没落地"，按它如实说，' +
            '别当成版式问题去改设计。'
        )
      }
      if (skipped > 0) {
        notes.push(
          `还有 ${skipped} 页没附（一次最多 ${MAX_ATTACHED_PAGES} 页）：要看再调一次并指定 pages。`
        )
      }
      notes.push(
        '逐页看着真图核一遍：有没有无信息页（套话/致谢充数）、有没有"待定/—"这类占位、',
        '事实性说法有没有写出处、版式有没有失衡或连排同一种。**不合格就改完再渲染一次**，',
        '只改一两处也走最小改动，别为了一个小瑕疵把整份重生成。',
        ''
      )
      if (outline.length > 0) {
        notes.push('逐页文字（核对措辞与空值用）：', outlineText(outline))
      }

      return {
        message: notes.join('\n'),
        renderer,
        dir: outRel,
        pages,
        attached,
        outline
      }
    },
    /**
     * 把页图翻成模型能看的 `file` 内容块。**两个坑都是实测出来的**（见文件头注与
     * `_r68-vision-tool.spec.ts`）：
     *   1. 形状必须是 `{type:'file', mediaType, data:{type:'data', data:<base64>}}`。
     *      `image-url` 是废弃形状（AI SDK 7 抛 Invalid URL）；`{type:'url', url:'data:…'}`
     *      在**真 DeepSeek 端点**上会被 `validateDeepSeekImageUrl` 拒掉 —— 它限制图片 URL
     *      不超过 8192 字符，而我们一张 1600×900 的页图 base64 就有几万字符
     *      （实测报错：`DeepSeek image URLs must not exceed 8192 characters.`）。
     *      走 `data`（内联字节）这条不分支就不做那个长度校验。
     *   2. `data` 里放 **base64 字符串**而不是 Uint8Array：这份 modelOutput 会被 Mastra 存进
     *      `providerMetadata`（JSON 落库），Uint8Array 过一遍 JSON 会变成 `{"0":137,…}` 这种
     *      数字键对象。base64 字符串是 JSON 安全的。
     *
     * 单页读不出来就跳过它 —— 正文里已经列了页图路径，不值得为一张图把整次调用判失败。
     */
    toModelOutput: async (result: RenderPptResult) => {
      const value: unknown[] = [{ type: 'text', text: result.message }]
      for (const page of result.pages) {
        if (!result.attached.includes(page.index)) continue
        try {
          const bytes = await ctx.fs.readFile(page.abs)
          value.push({
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'data', data: Buffer.from(bytes).toString('base64') }
          })
        } catch {
          // 读不到就跳过（页图路径已经在 message 里了）
        }
      }
      return { type: 'content', value }
    }
  })
}
