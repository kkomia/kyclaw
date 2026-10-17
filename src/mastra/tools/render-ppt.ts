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
 *   2. **渲染器是"有就用、没有就退化"，优先级写死**（round 78 后的准确口径）：
 *      **自动**：① Windows 上的**本机 PowerPoint / WPS COM**（`PowerPoint.Application`，实测可用 ——
 *      个人 PC 上通常就装了 Office / WPS 之一，用它渲染出来的字体与版式就是用户自己打开看到的那一套）
 *      → **它真渲染失败时回退到 ② 随包的 LibreOffice**（round 68，`resources/libreoffice-kit`，
 *      跨平台、不依赖用户装没装 Office）——"本地优先、失败有兜底"；
 *      **没有 COM 可用时**（非 Windows / 没装 Office / WPS）直接走 ②；
 *      **两条都没有** → ③ 只回逐页文字结构；
 *      **显式强制**（`KYCLAW_PPT_RENDERER`）可禁用自动换路或直接点名一条：点了名就只有那一条，
 *      失败就如实失败，**不悄悄换一条再冒它的名字**。
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
 * round 77 把优先级翻过来（用户口径：**个人 PC 通常装 Word / WPS / Excel 之一，产品不该只用随包引擎**）：
 * Windows 上**先**用本机 PowerPoint / WPS 的 COM，没有再退到随包的 kit。为什么：
 *   - 页图要拿来判断"用户拿到手会看到什么"，而用户是自己双击这份 pptx 打开的 —— 本机那件引擎
 *     渲染出来的字体与版式才和他看到的一致（kit 用的是随包字体，缺字会替换、版式会走样）；
 *   - 用户机器上装着的就是他要继续编辑的那件应用，渲染口径与"改一改"的动作同一个。
 * 安全性没有放松：COM 那条路的两道闸门一个字都没动 —— ① `Get-Process -Name POWERPNT, wpp` 的
 * `$before` 计数、② `$before -eq 0` 才 `Quit()`（详见 renderScript / probeScript 的注释）。
 * 也就是：**只关产品本次自己拉起来的那一个实例**，用户正开着的 PowerPoint / WPS 绝不被顺手关掉。
 * 非 Windows、或 Windows 上本机没有 Office/WPS，仍按原路走 kit（kit 还在，兜底没变）。
 *
 * round 78 补上"本地优先"的另一半（用户口径：**本地优先、失败有兜底**）：round 77 把 COM 提到第一位之后，
 * 本机 COM 一旦真导出失败（deck 被占用、幻灯片里有点像元没装、COM 半死……）就**直接退到逐页文字**，
 * 随包 kit 明明在磁盘上却不试一次 —— 那是把 round 68 的兜底白白浪费了。现在：
 *   - **自动命中的** COM 渲染失败、且随包 kit 可用 → 清掉这次派生的 outDir 再用 kit 重来一次，
 *     成功时回执**报实际的渲染器**（libreoffice）并明说"本机 PowerPoint/WPS 渲染失败，已退回随包渲染器"
 *     （**不静默**：页图来路不同，缺字/版式结论也不同）；
 *   - 两条都失败 → 回执**同时保留两条的真实原因**（不是只报后一条）；
 *   - kit 不可用 → 保持原来的退化口径（直接文字结构自检）；
 *   - **强制**（`KYCLAW_PPT_RENDERER=powerpoint`）或注入了探测/渲染的测试语义 → **不自动换路**
 *     （用户点名的那条路就是那条路）；见 `shouldFallbackToKit`。
 * 这条兜底**没有**放松任何安全闸门：换路仍在同一把 `runExclusive(outDir)` 锁内、只清我方派生的
 * outDir（不碰用户原 deck）、kit 仍写自己的 staging 再 rename 进页图目录，COM 那两道进程闸门
 * （`$before` 计数 / `$before -eq 0` 才 `Quit()`）一个字未动。
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
import { basename, dirname, join, sep } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { extractPptx } from '../../main/workbench-office'
import { resolveInsideWorkspace } from '../../main/permission/realpath'
import { runProcess } from './exec'
import {
  approvalSessionOf,
  needsApproval,
  relativeInside,
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

/**
 * 渲染器报了成功、却没落下任何页图时的原因（自动回退想换路看的就是"真的拿到图没有"）。
 * PowerPoint 与 kit 两条路共用这一句，回执口径才一致。
 */
const NO_PAGES_DETAIL = '导出命令跑完了，但没有拿到任何页图'

/** 随包 kit 渲染时的暂存目录后缀（kit 要求 `--output-dir` 是不存在的新目录，见 renderWithLibreOffice） */
const KIT_STAGING_SUFFIX = '.libreoffice-tmp'

/**
 * 渲染器：**探测顺序就是优先级**（详见文件头注）。
 *   - `'powerpoint'`：Windows 上本机装的 PowerPoint / WPS（COM）；
 *   - `'libreoffice'`：随包的 kit（跨平台兜底，不依赖用户装没装 Office）；
 *   - `'none'`：两条都没有 —— 只会回逐页文字结构。
 */
export type PptRenderer = 'powerpoint' | 'libreoffice' | 'none'

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

/**
 * 一条渲染通路：把 `deck` 逐页导成 PNG 写进 `outDir`（目录由调用方先清空再建）。
 * 真实现是 `renderWithPowerPoint` / `renderWithLibreOffice`；测试与排障按需注入。
 * 第三个参数是用户中止信号（round 73）：真实现把它传给 `runProcess`（子进程会被收掉）；
 * 注入件可以忽略它（老注入点一个都不用改）。
 */
export type RenderTarget = (
  deck: string,
  outDir: string,
  signal?: AbortSignal
) => Promise<RenderOutcome>

export interface RendererDeps {
  /** 探测渲染器（缺省 = 真探测；测试注入） */
  detect?: () => PptRenderer
  /**
   * 跑一次渲染（缺省 = 按探测结果跑真实现；测试注入）。
   * **注入它就等于接管了"跑哪条路"**：注入什么就跑什么，本轮新加的"COM 失败自动退回 kit"
   * 在这条路上**不生效**（见 `shouldFallbackToKit` 的 `injectedRender`）。
   */
  render?: RenderTarget
  /** 平台（缺省 = process.platform） */
  platform?: NodeJS.Platform
  /**
   * 随包 kit 的 CLI 绝对路径。缺省 = 真去找（见 kitRootCandidates）；
   * **测试注入 `null`** 表示"这台机器没有随包渲染器"，免得探测结果随开发机变。
   */
  kitCli?: string | null
  /**
   * 本机 PowerPoint / WPS 在不在（缺省 = 真探测，见 `localOfficeAvailable`）。
   * **测试注入**：单测既不该真去拉 COM（本机装了 WPS 就会起一个 `wpp.exe`），
   * 也不该让结论随开发机有没有装 Office 而变 —— 给假件即可（`() => true` / `() => false`）。
   */
  localOffice?: () => boolean
  /**
   * 本机 COM 那条路的真实现（缺省 = `renderWithPowerPoint`）。**只在没注入 `render` 时**才被看到。
   * 单测注入它 + `kitRender`，就能验"COM 失败 → 退回 kit"而不碰真 Office/WPS。
   */
  comRender?: RenderTarget
  /**
   * 随包 kit 那条路的真实现（缺省 = `renderWithLibreOffice` + 探测到的 CLI；找不到 CLI 且没注入
   * 这里时，这条路不可用）。注入了它就当"这台机器有 kit"，**不再看 `kitCli`**。
   */
  kitRender?: RenderTarget
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
 * 随包 kit 那条路的**可跑目标**（`null` = 这条路不可用）。
 *   - 注入了 `kitRender` 就直接用它（单测：既不用真有 kit，也不启进程）；
 *   - 否则要有 CLI 才算可用（`kitCliFor` 找到了就绑上 `renderWithLibreOffice`）。
 * 主路（探测命中 libreoffice）与 round 78 的兜底回退**共用**这一份 —— 两条路对"kit 在不在"
 * 的判断必须是同一个，否则会出现"主路说没有、回退以为有"这种自相矛盾。
 */
function kitTargetFor(options: RendererDeps): RenderTarget | null {
  if (options.kitRender !== undefined) return options.kitRender
  const cli = kitCliFor(options)
  if (cli === null) return null
  return (deck, outDir, signal) => renderWithLibreOffice(deck, outDir, cli, signal)
}

/**
 * 环境变量**强制指定**的渲染器（`null` = 没强制，走自动探测）。
 * 抽出来单独一份是为了让"这次是自动探测还是用户点名"可判：自动探测出来的 COM 才有资格
 * 在失败时回退到 kit（见 `shouldFallbackToKit`），**点名的没有**。
 */
export function forcedRenderer(): PptRenderer | null {
  const forced = process.env[RENDERER_ENV]?.trim().toLowerCase()
  if (forced === 'none' || forced === 'off') return 'none'
  if (forced === 'libreoffice' || forced === 'kit' || forced === 'soffice') return 'libreoffice'
  if (forced === 'powerpoint') return 'powerpoint'
  return null
}

/**
 * 找一个能用的 PPT 渲染器，**按优先级**（顺序就是文件头注里那三条）：
 *   0. 环境变量显式指定（测试 / 排障）；
 *   1. **Windows 上的本机 PowerPoint / WPS COM**（round 77 起是第一位）：个人 PC 上通常就装了
 *      Office / WPS 之一，用它渲染出来的页图与用户自己双击打开看到的一致（见 `comPowerPoint`）；
 *   2. 没命中才轮到**随包的 LibreOffice kit**（跨平台兜底：不依赖用户装没装 Office）；
 *   3. 两条都没有 → `'none'`。结论缓存起来，后续调用不再付这份代价（COM 探测要起 PowerShell）。
 *
 * **非 Windows 且没有随包 kit** 才是 `'none'`（本实现的 COM 那条路只有 Windows 有）；
 * 有 kit 的机器上，任何平台都会回 `'libreoffice'`（除非 Windows 上 COM 先命中）——
 * 这正是 round 68 要的："没有 PowerPoint"不等于"不能渲染"。
 */
export function detectRenderer(options: RendererDeps = {}): PptRenderer {
  const forced = forcedRenderer()
  if (forced !== null) return forced

  if (cachedRenderer !== null) return cachedRenderer

  if ((options.platform ?? process.platform) === 'win32' && localOfficeAvailable(options)) {
    cachedRenderer = 'powerpoint'
    return cachedRenderer
  }

  if (kitCliFor(options) !== null) {
    cachedRenderer = 'libreoffice'
    return cachedRenderer
  }

  cachedRenderer = 'none'
  return cachedRenderer
}

/**
 * 探测结果是 COM（本机 PowerPoint / WPS）时，**失败要不要自动换到随包的 kit**（round 78）。
 *
 * 纯函数（不读盘、不读 env —— `forced` 由调用方给），三条判据缺一不可：
 *   - 探测命中的就是 `'powerpoint'`（libreoffice / none 没什么可换的）；
 *   - **不是**被环境变量点名的（`forced === null`）：用户点了 PowerPoint，就该只有 PowerPoint，
 *     失败如实失败 —— 换一条再冒它的名字，回执里的渲染器名与尺寸都会说谎；
 *   - **没有**注入 `render`（`injectedRender === false`）：注入了就是把"跑哪条路"整个接管了，
 *     老注入点（单测 / 排障）的语义不能被悄悄改掉。
 *
 * 至于"kit 到底在不在"，由调用方另判（`kitTargetFor` 给 null 就不换路）。
 */
export function shouldFallbackToKit(options: {
  renderer: PptRenderer
  forced: PptRenderer | null
  injectedRender: boolean
}): boolean {
  return options.renderer === 'powerpoint' && options.forced === null && !options.injectedRender
}

/** 本机有没有 PowerPoint / WPS：注入了就用注入的（测试），否则真探测 */
function localOfficeAvailable(options: RendererDeps): boolean {
  return options.localOffice !== undefined ? options.localOffice() : comPowerPoint()
}

/**
 * 真探测"本机有没有 PowerPoint / WPS"（能不能走 COM）。三步，**代价从小到大**：
 *   0. 逃生门 `KYCLAW_POWERPOINT` 指到哪算哪（排障用，只看文件在不在）；
 *   1. 扫 Office 的常见安装位置（纯路径判断、不起进程，绝大多数装了 MS Office 的机器在这里就命中）；
 *   2. 都没中才真问一次 COM（`New-Object -ComObject PowerPoint.Application`）—— MSI / 商店版 Office
 *      装在别处、以及 **WPS**（装在 `%LOCALAPPDATA%\Kingsoft\...`，扫 Program Files 扫不到）靠它兜住；
 *      一件都没装时它是**快速失败**（注册表里查不到 ProgID），不会真的拉起 Office。
 */
function comPowerPoint(): boolean {
  const explicit = process.env[POWERPOINT_ENV]?.trim() ?? ''
  if (explicit !== '' && existsSync(explicit)) return true

  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432
  ].filter((root): root is string => typeof root === 'string' && root !== '')

  for (const root of roots) {
    for (const suffix of POWERPOINT_RELATIVE_PATHS) {
      if (existsSync(join(root, ...suffix.split('/')))) return true
    }
  }

  return comProbePowerPoint()
}

/**
 * 可能出现"PowerPoint COM 由谁承载"的进程名：MS Office 是 `POWERPNT`，WPS 演示是 `wpp`。
 * 只数 `POWERPNT` 会在 WPS 机器上**恒为 0** —— 下面那道"只关自己起的那一个"的闸门就形同虚设
 * （排障实测：这台机器的本地服务器正是 `wpp.exe /Automation`）。
 */
const POWERPOINT_PROCESS_NAMES = 'POWERPNT, wpp'

/**
 * 起哪个 PowerShell：**绝对路径优先，不靠 PATH**。
 *
 * 排障实测（round 76）：这台机器（以及不少被改过 PATH 的机器）的系统 PATH 里**没有**
 * `%SystemRoot%\System32\WindowsPowerShell\v1.0` —— 裸名 `powershell.exe` 交给 `spawnSync`
 * 直接 `ENOENT`（**进程根本没起**），COM 探测于是恒判"没有 PowerPoint"，`render_ppt` 整条 COM
 * 路被误关（操作者的导出脚本用的是全路径，所以它成功、产品失败）。Windows PowerShell 5.1 的
 * 落点是固定的：存在就用它（System32 = 64 位；本机实测 64/32 两个视图都能拉起 WPS 的
 * `PowerPoint.Application`），只有找不到才退回裸名。
 */
export function powershellCommand(): string {
  const root = process.env.SystemRoot ?? process.env.windir
  if (typeof root === 'string' && root !== '') {
    const absolute = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(absolute)) return absolute
  }
  return 'powershell.exe'
}

/** 探测那条 spawn 的可注入形状（回归测试换成记录器 / 假件；缺省 = 真 `spawnSync`） */
export type ProbeSpawn = (
  command: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; encoding: 'utf8' }
) => { status: number | null; stdout?: string }

const realProbeSpawn: ProbeSpawn = (command, args, options) => spawnSync(command, args, options)

/**
 * 探测脚本：起一次 COM 判"PowerPoint 在不在"。
 * `$before` 把 WPS 的 `wpp` 也算进"本来就在跑"——否则在 WPS 机器上它恒为 0，
 * 下面那道"只关自己起的那一个"的闸门等于没装（会顺手退出用户正开着的 WPS）。
 */
export function probeScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$before = @(Get-Process -Name ${POWERPOINT_PROCESS_NAMES} -ErrorAction SilentlyContinue).Count`,
    'try { $app = New-Object -ComObject PowerPoint.Application } catch { exit 3 }',
    // 只关我们自己起的那一个：本来就在跑的 PowerPoint/WPS 不能被我们顺手关掉（用户可能正开着文件）
    'if ($before -eq 0) { try { $app.Quit() } catch { } }',
    "Write-Output 'ok'"
  ].join('\n')
}

/**
 * 真问一次 COM：PowerPoint 在不在这个系统上（覆盖非标准安装位置）。
 * **同步**跑（探测只发生一次，且要就地判结论）：失败一律当"没有"，不抛。
 * `run` 只为回归测试可注入（默认真 `spawnSync`）——探测与渲染都经 `powershellCommand()`，
 * 起的是**同一个**绝对路径。
 */
export function comProbePowerPoint(run: ProbeSpawn = realProbeSpawn): boolean {
  const result = run(
    powershellCommand(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', probeScript()],
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
 *   - `$before` 那道闸：`New-Object -ComObject` 在 PowerPoint/WPS 已经运行时是**附着到既有实例**，
 *     此时 `Quit()` 会把用户正开着的窗口一起关掉。只有"本来没在跑"才允许退出；进程名要算上
 *     WPS 的 `wpp`（只数 `POWERPNT` 在 WPS 机器上恒为 0，那道闸门等于没装）。
 */
export function renderScript(deck: string, outDir: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    // 不声明输出编码时，管道里拿到的是系统 ANSI（本机 936）——中文错误信息会变乱码
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$deck = ${psQuote(deck)}`,
    `$out = ${psQuote(outDir)}`,
    `$before = @(Get-Process -Name ${POWERPOINT_PROCESS_NAMES} -ErrorAction SilentlyContinue).Count`,
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

/** 渲染那条子进程的可注入形状（回归测试记录 command；缺省 = 真 `runProcess`） */
export interface RenderRunSpec {
  command: string
  args: readonly string[]
  timeoutMs: number
  signal?: AbortSignal
}

export interface RenderRunResult {
  spawnError: Error | null
  aborted: boolean
  timedOut: boolean
  exitCode: number | null
  text: string
}

export type RenderRunner = (spec: RenderRunSpec) => Promise<RenderRunResult>

const realRenderRun: RenderRunner = (spec) => runProcess(spec)

/**
 * 跑一次真渲染：PowerPoint COM 写 PNG 到 outDir（目录由调用方建好、清空）。
 * 起法与探测同源（都经 `powershellCommand()`）；`run` 只为回归测试可注入（默认真 `runProcess`）。
 */
export async function renderWithPowerPoint(
  deck: string,
  outDir: string,
  signal?: AbortSignal,
  run: RenderRunner = realRenderRun
): Promise<RenderOutcome> {
  const result = await run({
    command: powershellCommand(),
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
  // 两条路都没有才是这个原因：本机没有 PowerPoint / WPS，随包 LibreOffice 也没装上
  const why = detail === '' ? '本机没有检测到 PowerPoint / WPS，随包的渲染器也没装上' : detail
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
      const { abs: deck, root } = toolTarget(ctx, input.path, session)

      if (!/\.pptx$/i.test(deck)) {
        throw new Error(`render_ppt 只渲染 .pptx（给的是 ${basename(deck)}）`)
      }
      const deckStat = await statOrNull(ctx, deck)
      if (deckStat === null || !deckStat.isFile()) {
        throw new Error(`render_ppt 失败：${input.path} 不存在（先确认产出落在哪个路径）`)
      }

      const rel = (target: string): string => relativeInside(root, target)

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
      const outDirResolved = resolveInsideWorkspace(root, outDirCandidate)
      if (!outDirResolved.ok) {
        throw new Error(
          `render_ppt 拒绝写页图：派生目录不在工作区内（${outDirResolved.reason}）——` +
            '页图只会落在 deck 旁边的 `<deck 名>_页图/` 里'
        )
      }
      const outDir = outDirResolved.abs
      const outRel = rel(outDir)

      // 页图目录是**我们派生的**：先整个清掉再重建，免得上一版多出来的页留在里面冒充这一次的产出。
      // 整段（清目录 → 渲染 → [失败则清掉重来一遍] → 收页图清单）都在同一把锁里：两次 render_ppt
      // 撞同一个 deck 时，后一次不会在前一次刚清完目录、还没导出完的时候插进来；round 78 的换路
      // 也在这把锁内 —— 否则两次调用各自清一次目录，页图是谁的、算谁的，就说不清了。
      const kitTarget = kitTargetFor(options)
      /**
       * 真正跑的那个实现：**注入的 render 优先**（单测与排障）→ 探测命中的那个走真实现。
       * 探测说 `'libreoffice'` 却找不到 CLI，只可能是被人为硬指的（`KYCLAW_PPT_RENDERER` /
       * 注入的 detect）：这时如实退化，**不悄悄改用 PowerPoint** —— 回执里的渲染器名会跟着说谎。
       * 真实现（两条都是）把 `signal` 传给 `runProcess`：用户点停止时渲染子进程会被收掉。
       */
      const render: RenderTarget | null =
        options.render ??
        (renderer === 'libreoffice'
          ? kitTarget
          : renderer === 'powerpoint'
            ? (options.comRender ?? renderWithPowerPoint)
            : null)

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

      /**
       * 自动命中的 COM 失败时的兜底（round 78，判据见 `shouldFallbackToKit`）：只有"自动探测出来的
       * PowerPoint"才换路（点名的 / 注入了 render 的都不换）。kit 那条路不可用（没装 / 没注入）
       * 就不换，保持原来的退化口径。
       */
      const fallback =
        shouldFallbackToKit({
          renderer,
          forced: forcedRenderer(),
          injectedRender: options.render !== undefined
        }) && kitTarget !== null
          ? kitTarget
          : null

      const outcome = await ctx.state.runExclusive(outDir, async () => {
        /** 一次尝试：先清掉/重建我方派生的页图目录，再让这条渲染器往里写（失败可整条重来） */
        const attempt = async (
          target: RenderTarget
        ): Promise<{ rendered: RenderOutcome; pages: RenderPptResult['pages'] }> => {
          await ctx.fs.remove(outDir, { recursive: true }).catch(() => undefined)
          await ctx.fs.mkdir(outDir)
          const rendered = await target(deck, outDir, signal)
          if (!rendered.ok) return { rendered, pages: [] }

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
        }

        const first = await attempt(render)
        // 中止不是"失败"（round 73）：用户点了停止就到此为止，**不要**再换一条路接着渲
        if (fallback === null || first.rendered.aborted === true) {
          return { ...first, renderer, downgraded: '' }
        }
        // 成不成看两条：命令退出码 + 真的拿到了页图（跑完了却一张都没有，等于失败）
        if (first.rendered.ok && first.pages.length > 0) {
          return { ...first, renderer, downgraded: '' }
        }

        const firstDetail = first.rendered.ok ? NO_PAGES_DETAIL : first.rendered.detail
        const second = await attempt(fallback)
        if (second.rendered.aborted === true) return { ...second, renderer, downgraded: '' }
        if (second.rendered.ok && second.pages.length > 0) {
          return {
            ...second,
            // 页图来自 kit：**报实际的渲染器**，别让模型以为看的是本机 PowerPoint 出的图
            renderer: 'libreoffice' as PptRenderer,
            downgraded:
              `注意：**本机 PowerPoint/WPS 渲染失败，已退回随包渲染器**（${firstDetail}）——` +
              '下面是随包渲染器（LibreOffice）出的页图；缺字与版式口径跟本机 PowerPoint 不一定是同一套。'
          }
        }
        // 两条都没成：**两条的真实原因都留下**（只报后一条会让人以为是 kit 的锅）
        const secondDetail = second.rendered.ok ? NO_PAGES_DETAIL : second.rendered.detail
        return {
          rendered: {
            ok: false,
            detail: `本机 PowerPoint/WPS 渲染失败：${firstDetail}；随包渲染器也没成：${secondDetail}`
          },
          pages: [] as RenderPptResult['pages'],
          renderer,
          downgraded: ''
        }
      })

      const pages: RenderPptResult['pages'] = outcome.pages
      // 用户中止（round 73）：与"渲染器失败"分开报 —— 别让模型据此判断"这台机器渲染不了"
      if (outcome.rendered.aborted === true) {
        return {
          message: abortedMessage(outline),
          renderer: outcome.renderer,
          pages: [],
          attached: [],
          outline
        }
      }
      if (!outcome.rendered.ok || pages.length === 0) {
        const detail =
          outcome.rendered.ok && pages.length === 0 ? NO_PAGES_DETAIL : outcome.rendered.detail
        return {
          message: degradedMessage(detail, outline),
          renderer: outcome.renderer,
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
      // 换过路就先说清楚（round 78）：页图来路不同，缺字与版式结论也不同，**不许静默**
      const notes: string[] =
        outcome.downgraded === ''
          ? []
          : [
              outcome.downgraded,
              '（这不影响你继续看图核——但"本机字体/版式完全一致"这句话这次不成立。）',
              ''
            ]
      notes.push(
        size === undefined
          ? `已渲染 ${pages.length} 页，页图在 ${outRel}/。`
          : `已渲染 ${pages.length} 页（${size.width}×${size.height}），页图在 ${outRel}/。`,
        asked.length === 0
          ? `上面直接附了第 ${attached.join('、')} 页的**图**给你看。`
          : `上面直接附了你点名的第 ${attached.join('、')} 页的图。`
      )
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
        renderer: outcome.renderer,
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
