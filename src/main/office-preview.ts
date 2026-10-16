/**
 * 办公档**页式预览后端**：把 doc / docx / ppt / pptx 转成 PDF 字节（工作台预览用）。
 *
 * ## 移植与适配
 *
 * 队列准入、内容寻址缓存、源一致性、取消语义、产出校验这整套取自 DeepSeek Harness 的
 * `packages/document/office-to-pdf`（MIT，commit 86a402200d95fecef4529d969836f1fe13c6cb0d，
 * 上游文件 `src/{queue,output,errors,index}.ts`）；**引擎那一段按随包 kit 的既有跑法改写**：
 * 上游用 `@deepseek-ai/libreoffice-kit` 的 Node API（`createConverter` —— 主进程内起 worker
 * 线程 + koffi FFI），这里改成**子进程跑 kit 自己的 CLI**
 * （`ELECTRON_RUN_AS_NODE=1 <process.execPath> <kit>/lib/cli.js convert …`），与
 * `mastra/tools/render-ppt.ts` / `mastra/tools/office-legacy.ts` 同一条**已被真机验证**的路：
 * 原生引擎与 FFI 不进 Electron 主进程（真崩也只崩子进程），超时/中止直接沿用 `runProcess`
 * 那套"杀进程树"。CLI 与 Node API 的能力对得上：`convert` 覆盖 doc/docx/ppt/pptx → pdf，
 * 成功时 stdout 回 `{"backend","missingFonts","outputPath"}`，失败时回 `{"code","error"}`。
 * 换成 Node API 只需改 `KitEngine`（队列、缓存、错误分类都不用动）。
 *
 * ## 不变量（这几条比功能重要）
 *
 *   1. **不认路径**：本模块只接受"已授权的源"（key / version / 可选 stat 大小 / 延迟 `read`
 *      回调）。会话根、containment、存在性全归接线层（见 `shared/office-preview.ts` 的红线
 *      说明）—— 本模块**没有**任何"按路径读用户文件"的代码路径，它成不了绕过权限的旁路。
 *   2. **原件一个字节都不动**：源只在授权的 `read` 里被读成字节；交给引擎的是**自建临时目录
 *      里的副本**，固定叫 `source.<ext>`（扩展名钉死 —— 引擎按扩展名判输入格式）。
 *   3. **产出只写自建目录，收尾只删自建目录**：`mkdtemp` 出来的
 *      `kyclaw-office-preview-XXXXXX`；不碰用户文件的目录，也不碰系统临时目录本身。
 *   4. **产出必须验**：命令退出码 0 也要真读到一份**完整 PDF**（常规文件、有上限、`%PDF-` 头、
 *      `%%EOF` 尾）才算成功 —— 引擎吐个错误页改名成 .pdf，这里就拦下。
 *   5. **全程有界**：队列长度、并发、读者数、在途源字节、缓存条数/字节、别名表都有上限；
 *      满了回 `busy`（可重试），不排无界队列、不无限攒 PDF。
 *   6. **中止、超时、失败分开报**：用户中止抛中止原因，超时回 `timeout`，引擎失败按分类回码 ——
 *      一个都不伪装成"这份文件转不了"。
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, type Stats } from 'node:fs'
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { formatSeconds, runProcess } from '../mastra/tools/exec'
import { resolveKitCli } from '../mastra/tools/render-ppt'
import {
  OFFICE_PREVIEW_FAILURE_MESSAGES,
  OFFICE_PREVIEW_INPUT_MAX_BYTES,
  OFFICE_PREVIEW_OUTPUT_MAX_BYTES,
  OFFICE_PREVIEW_TIMEOUT_MS,
  OfficePreviewError,
  officePreviewFormatSchema,
  officePreviewSourceKey,
  officePreviewSourceVersion,
  type OfficePreviewErrorCode,
  type OfficePreviewFormat,
  type OfficePreviewPriority
} from '../shared/office-preview'

/**
 * 协议里那几件**接线层也要用**的东西原样再导出一次：分类错误、人话表、源键与版本派生。
 * 为什么再导出而不是让接线层各自去 import：这个模块是"办公档预览"这件事的入口，
 * 谁的 import 面都留在这一处（shared 那份是给渲染端与跨进程看的）。
 */
export {
  OFFICE_PREVIEW_FAILURE_MESSAGES,
  OfficePreviewError,
  officePreviewSourceKey,
  officePreviewSourceVersion
}

/** 自建临时目录前缀（`mkdtemp` 再补 6 位随机；收尾只删这一个自建目录） */
export const OFFICE_PREVIEW_TEMP_PREFIX = 'kyclaw-office-preview-'

/**
 * 进程侧宽限：比引擎截止多给这么多，让引擎**先**自己报超时（它给的原因比我们猜的准）。
 * 与 `office-legacy.ts` 的 `LEGACY_RUN_GRACE_MS` 同一个口径。
 */
export const OFFICE_PREVIEW_RUN_GRACE_MS = 30_000

/**
 * 转换器（引擎侧）的配置。前一半是**队列/缓存的上限**（不进引擎），后一半会**原样传给引擎**
 * （同一个数两边不许各说各话）。
 */
export interface OfficePreviewConfig {
  /** 同时进行的转换上限（每个转换是一个 kit 子进程） */
  maxConcurrentConversions: number
  /** 等待准入的作业上限 */
  maxQueuedJobs: number
  /** 在途读者上限（含共享同一次转换的多个调用方） */
  maxReaders: number
  /** 在途源字节总量上限（按 stat 大小预留；未知大小按 maxInputBytes 预留） */
  maxSourceBytes: number
  /** 后台转换并发上限；0 = 完全不做预热 */
  maxBackgroundConversions: number
  /** 保留的 PDF 条数上限 */
  maxCachedEntries: number
  /** 保留的 PDF 字节总量上限 */
  maxCachedBytes: number
  /** 源定位别名表的上限（同一份内容被多个路径引用时的"已算过"索引） */
  maxSourceEntries: number
  /** 单次转换截止（毫秒）；不含排队时间 */
  timeoutMs: number
  /** 源字节上限 */
  maxInputBytes: number
  /** 产出 PDF 字节上限 */
  maxOutputBytes: number
  /** PDF 导出时内嵌图片的 DPI；引擎默认 144 */
  maxImageResolution: number
  /** 允许的 OOXML(DOCX/PPTX) 压缩包条目数上限 */
  maxArchiveEntries: number
  /** 允许的 OOXML 声明解压总字节上限 */
  maxUncompressedBytes: number
  /**
   * 字体根（**必须绝对路径**）。缺省 = 引擎的平台默认字体目录。
   *
   * 空数组与缺省**在引擎侧等价**：kit 的 CLI 用 `--font-directory` 传目录，不给值就等于没给，
   * 表达不出"一个目录都不要"，所以这里按"不传"处理（Node API 那边能表达，移植过来这一档语义变窄，
   * 但"用平台默认字体"本来就是我们要的）。
   */
  fontDirectories?: readonly string[]
  /** 字体族的**优先组**（每组至少两个名字；整份数组作为**一个** JSON 传给引擎）*/
  fontFallbacks?: readonly (readonly string[])[]
  /** 每个转换器索引的物理字体文件数上限 */
  maxFontFiles: number
  /** 单个字体文件字节上限 */
  maxFontFileBytes: number
  /** 单次转换加载的原始字体字节上限 */
  maxLoadedFontBytes: number
}

/** 缺省配置（`OfficePreview` 构造时与传入的片段合并） */
export const DEFAULT_OFFICE_PREVIEW_CONFIG: OfficePreviewConfig = {
  maxConcurrentConversions: 2,
  maxQueuedJobs: 8,
  maxReaders: 32,
  maxSourceBytes: 100 * 1024 * 1024,
  maxBackgroundConversions: 1,
  maxCachedEntries: 8,
  maxCachedBytes: 128 * 1024 * 1024,
  maxSourceEntries: 64,
  timeoutMs: OFFICE_PREVIEW_TIMEOUT_MS,
  maxInputBytes: OFFICE_PREVIEW_INPUT_MAX_BYTES,
  maxOutputBytes: OFFICE_PREVIEW_OUTPUT_MAX_BYTES,
  maxImageResolution: 144,
  maxArchiveEntries: 10_000,
  maxUncompressedBytes: 250 * 1024 * 1024,
  maxFontFiles: 20_000,
  maxFontFileBytes: 256 * 1024 * 1024,
  maxLoadedFontBytes: 512 * 1024 * 1024
}

/** 一次转换请求：已经授权过的源 + 调度意图 */
export interface OfficePreviewRequest {
  readonly extension: OfficePreviewFormat
  readonly priority: OfficePreviewPriority
  readonly source: {
    /** 授权范围 + 绝对路径的编码（见 `officePreviewSourceKey`）；本模块不解析它 */
    readonly key: string
    /** 源版本（见 `officePreviewSourceVersion`）；读完复检不一致就拒 */
    readonly version: string
    /** 已授权的 stat 大小；缺省按 `maxInputBytes` 预留（未知大小不等于小文件） */
    readonly bytes?: number
    /**
     * **准入之后**才被调用（排队期间不占内存）。调用方负责这次读取仍然在授权范围内、
     * 且**并发安全**（本模块只保证"按预留容量读一次、读完复检版本"）。
     *
     * @param signal 共享的转换生命周期（与某个读者自己的 signal 不是一回事）
     * @param maxBytes 预留的源容量；**最多读这么多 + 1 个溢出哨兵字节**
     * @returns 字节与**实际读到时的版本**；与请求时的版本不一致即拒绝转换
     */
    read(signal: AbortSignal, maxBytes: number): Promise<{ bytes: Uint8Array; version: string }>
  }
}

/** 一次成功的转换：调用方持有的 PDF 字节（服务 dispose 后依然有效） */
export interface OfficePreviewConversion {
  readonly pdf: Uint8Array
  readonly missingFonts: string[]
  /** 不透明的内容标识（代次 + 扩展名 + 源字节摘要）；消费者不许解析它 */
  readonly cacheKey: string
  /** 服务代次（见 `OfficePreview.generation`） */
  readonly generation: string
}

/**
 * 接线层只用到的能力（**结构类型**，不绑具体类）：`OfficePreview` 天然满足它，
 * 而接线层的单测可以给一个只实现 `convert` 的假件 —— 类里有私有字段，是拆不开的，
 * 所以"接线层要什么"单独在这里声明一次。
 */
export interface OfficePreviewService {
  convert(request: OfficePreviewRequest, signal?: AbortSignal): Promise<OfficePreviewConversion>
}

/** 引擎那条路的注入面（**只给单测与排障**，生产路径一个都不用填） */
export interface OfficePreviewDeps {
  /** 随包 kit 的 CLI 绝对路径；`null` = 明确"这台机器没有随包引擎"（单测不许跟着开发机变） */
  kitCli?: string | null
  /** 子进程那层（缺省真 `runProcess`；单测注入假件，**一个真进程都不起**） */
  run?: OfficePreviewRunner
  /** 自建临时目录（缺省真 `mkdtemp`；单测指向自己建的目录，别往共享临时目录里丢东西） */
  makeTempDir?: () => Promise<string>
}

/** 子进程注入面的入参/回包（与 `runProcess` 的形状对齐，只取本模块用到的字段） */
export interface OfficePreviewRunSpec {
  command: string
  args: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}

export interface OfficePreviewRunResult {
  spawnError: Error | null
  aborted: boolean
  timedOut: boolean
  exitCode: number | null
  text: string
}

export type OfficePreviewRunner = (spec: OfficePreviewRunSpec) => Promise<OfficePreviewRunResult>

/** 真实现：与 bash / git / render_ppt / 旧版 Office 转换同一条进程内核 */
const realRun: OfficePreviewRunner = (spec) => runProcess(spec)

/** 超时/中止这类"不是文件的问题"：按仓库惯例用 `AbortError` 名字（error-text.ts 按名字判） */
function abortedError(signal: AbortSignal, what: string): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error(`已被用户中止：${what}`)
  error.name = 'AbortError'
  return error
}

/**
 * 随包引擎在不在（**只看路径存在性，不起进程**）。接线层想在转换之前就回一句更准的退化说明时用它。
 */
export function officePreviewEngineAvailable(): boolean {
  return resolveKitCli() !== null
}

/** 引擎自己的失败分类 → 我们的分类（认不出的一律 `failed`，不硬猜） */
const KIT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'input-too-large',
  'output-too-large',
  'invalid-document',
  'unsupported-format',
  'invalid-output',
  'timeout',
  'unavailable'
])

/**
 * 引擎在输出里回的最后一行 JSON：成功（stdout）与失败（stderr）都是它。
 * `runProcess` 把两条流并进同一份 text，所以扫"最后一行以 `{` 开头的"。
 */
function lastJsonLine(text: string): Record<string, unknown> | null {
  const last = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .pop()
  if (last === undefined) return null
  try {
    const parsed: unknown = JSON.parse(last)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * 引擎失败 → 分类错误：引擎报的分类**认得就透传**，认不出（或根本没报）落到 `failed`。
 * 取不到那行 JSON 就退回输出尾部（排障时它比我们的转述有用）。
 */
function kitFailure(text: string, what: string): OfficePreviewError {
  const parsed = lastJsonLine(text)
  const rawCode = typeof parsed?.code === 'string' ? parsed.code : null
  const detail = typeof parsed?.error === 'string' ? parsed.error : null
  const code =
    rawCode !== null && KIT_FAILURE_CODES.has(rawCode)
      ? (rawCode as OfficePreviewErrorCode)
      : 'failed'
  const tail = detail ?? text.trim().split('\n').slice(-3).join(' ').slice(0, 300)
  return new OfficePreviewError(
    code,
    tail === ''
      ? `转换失败：随包 LibreOffice 报错，但没给出原因（${what}）`
      : `转换失败：随包 LibreOffice 报错（引擎的话：${tail}）`
  )
}

/** 成功那行的缺字体名单（拿不到形状就给空数组 —— 引擎没声明就等于"查不了"，不编） */
function missingFontsOf(parsed: Record<string, unknown> | null): string[] {
  const fonts = parsed?.missingFonts
  if (!Array.isArray(fonts)) return []
  return fonts.filter((font): font is string => typeof font === 'string' && font !== '')
}

/** 末段符号链接的拒绝标记：只在 POSIX 上给 O_NOFOLLOW（Windows 上 libuv 不映射这一位，行为未证） */
const NO_FOLLOW = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW

/**
 * 读一份**完整、有界、常规文件**的 PDF（自建临时目录里的产出）。
 * 拒：不存在 / 不是常规文件 / 超上限 / 截断 / 头不是 `%PDF-` / 尾不是 `%%EOF`。
 */
export async function readPreviewPdf(
  path: string,
  limit: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  signal.throwIfAborted()
  let entry: Stats
  try {
    entry = await lstat(path)
  } catch (cause) {
    throw new OfficePreviewError('invalid-output', '转换没有产出 PDF 文件', { cause })
  }
  if (!entry.isFile()) {
    throw new OfficePreviewError('invalid-output', '转换产出不是一个常规文件')
  }
  const file = await open(path, fsConstants.O_RDONLY | NO_FOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new OfficePreviewError('invalid-output', '转换产出不是一个常规文件')
    if (info.size > limit) {
      throw new OfficePreviewError('output-too-large', '转出来的 PDF 超过上限')
    }
    const bytes = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < bytes.length) {
      signal.throwIfAborted()
      const read = await file.read(bytes, length, bytes.length - length, null)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    signal.throwIfAborted()
    if (length > limit) throw new OfficePreviewError('output-too-large', '转出来的 PDF 超过上限')
    const pdf = bytes.subarray(0, length)
    if (
      length !== info.size ||
      !/^%PDF-\d\.\d/u.test(pdf.subarray(0, 8).toString('ascii')) ||
      !pdf.subarray(-1024).toString('ascii').trimEnd().endsWith('%%EOF')
    ) {
      throw new OfficePreviewError('invalid-output', '转换产出的 PDF 不完整')
    }
    return pdf
  } finally {
    await file.close()
  }
}

/**
 * 引擎适配层：**只认"字节进、PDF 字节出"**（与上游的 `convertBytes` 同一个位置）。
 *
 * 为什么把 CLI 路径做成"懒解析 + 失败即清"的可重试 promise：kit 在不在是**运行期事实**
 * （开发态 `resources/` 里可能有、打包态在 `process.resourcesPath` 下），一次探测失败不该
 * 把整个服务钉死在"不可用"上；清掉后下一次会重新探（与上游"工厂失败即重试"同义）。
 */
class KitEngine {
  private cli: Promise<string> | null = null

  constructor(
    private readonly config: OfficePreviewConfig,
    private readonly deps: OfficePreviewDeps
  ) {}

  /** 引擎的 CLI 路径（找不到 / 明确没有 → `unavailable`） */
  private cliPath(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (this.deps.kitCli !== undefined) {
      return this.deps.kitCli === null
        ? Promise.reject(
            new OfficePreviewError(
              'unavailable',
              '这台机器上没有随包渲染引擎（resources/libreoffice-kit）'
            )
          )
        : Promise.resolve(this.deps.kitCli)
    }
    if (this.cli === null) {
      this.cli = Promise.resolve()
        .then(() => resolveKitCli())
        .then((cli) => {
          if (cli === null) {
            throw new OfficePreviewError(
              'unavailable',
              '这台机器上没有随包渲染引擎（resources/libreoffice-kit）'
            )
          }
          return cli
        })
        .catch((error: unknown) => {
          this.cli = null
          throw error
        })
    }
    return this.cli
  }

  /** 会原样传给引擎的那批开关（一个数两边不许各说各话） */
  private limitArgs(): string[] {
    const config = this.config
    return [
      '--max-input-bytes',
      String(config.maxInputBytes),
      '--max-output-bytes',
      String(config.maxOutputBytes),
      '--max-image-resolution',
      String(config.maxImageResolution),
      '--max-archive-entries',
      String(config.maxArchiveEntries),
      '--max-uncompressed-bytes',
      String(config.maxUncompressedBytes),
      '--max-font-files',
      String(config.maxFontFiles),
      '--max-font-file-bytes',
      String(config.maxFontFileBytes),
      '--max-loaded-font-bytes',
      String(config.maxLoadedFontBytes)
    ]
  }

  private fontArgs(): string[] {
    const args: string[] = []
    for (const directory of this.config.fontDirectories ?? []) {
      args.push('--font-directory', directory)
    }
    // 注意：`--font-fallbacks` 是**一个** JSON 参数（整份组数组），不是可重复的开关 ——
    // kit CLI 的 `font-fallbacks` 是单值 string，重复给只有最后一个生效（实测过 parseArgs 语义）。
    const fallbacks = this.config.fontFallbacks
    if (fallbacks !== undefined && fallbacks.length > 0) {
      args.push('--font-fallbacks', JSON.stringify(fallbacks.map((group) => [...group])))
    }
    return args
  }

  /**
   * 字节 → PDF。源字节写进自建临时目录的副本，CLI 产出的 PDF 读成内存再删目录。
   * 失败一律是 `OfficePreviewError`（分类见 `OFFICE_PREVIEW_ERROR_CODES`）；中止照抛原因。
   */
  async convert(
    bytes: Uint8Array,
    extension: OfficePreviewFormat,
    signal: AbortSignal
  ): Promise<Pick<OfficePreviewConversion, 'pdf' | 'missingFonts'>> {
    signal.throwIfAborted()
    const cli = await this.cliPath(signal)
    signal.throwIfAborted()
    const directory = await (this.deps.makeTempDir ?? makePreviewTempDir)()
    try {
      const inputPath = join(directory, `source.${extension}`)
      const outputPath = join(directory, 'preview.pdf')
      // 副本只写、只读；引擎读它，原件从头到尾没被打开过写模式
      await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o600, signal })
      signal.throwIfAborted()

      const timeoutMs = this.config.timeoutMs
      const result = await (this.deps.run ?? realRun)({
        // 与 render_ppt / 旧版转换同一条跑法：Electron 自带的 Node 模式跑 kit 的 CLI，
        // 不必再随包一个独立 node.exe
        command: process.execPath,
        args: [
          cli,
          'convert',
          '--input',
          inputPath,
          '--output',
          outputPath,
          '--timeout-ms',
          String(timeoutMs),
          ...this.limitArgs(),
          ...this.fontArgs()
        ],
        // 工作目录也钉在自建临时目录里：万一有相对路径的副作用，落点也是这里
        cwd: directory,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeoutMs: timeoutMs + OFFICE_PREVIEW_RUN_GRACE_MS,
        signal
      })

      if (result.spawnError !== null) {
        throw new OfficePreviewError(
          'unavailable',
          `起不了随包的 LibreOffice（${cli}）：${result.spawnError.message}`,
          { cause: result.spawnError }
        )
      }
      if (result.aborted) throw abortedError(signal, `没有转换 source.${extension}`)
      if (result.timedOut) {
        throw new OfficePreviewError(
          'timeout',
          `转换超时（超过 ${formatSeconds(timeoutMs + OFFICE_PREVIEW_RUN_GRACE_MS)} 秒）`
        )
      }
      const parsed = lastJsonLine(result.text)
      if (result.exitCode !== 0) throw kitFailure(result.text, `source.${extension}`)
      signal.throwIfAborted()

      let pdf: Uint8Array
      try {
        pdf = await readPreviewPdf(outputPath, this.config.maxOutputBytes, signal)
      } catch (cause) {
        if (cause instanceof OfficePreviewError) throw cause
        throw new OfficePreviewError('invalid-output', '转换产出读不出来', { cause })
      }
      signal.throwIfAborted()
      return { pdf, missingFonts: missingFontsOf(parsed) }
    } finally {
      // 只删**这一次自建**的那个目录；删不掉（Windows 上句柄可能慢一拍）也不该把已经拿到的
      // 结果或真实原因顶掉（与旧版转换同口径）
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
        () => undefined
      )
    }
  }
}

/** 自建私有临时目录；收尾只删这一个（`mkdtemp` 保证建出来是新目录） */
async function makePreviewTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), OFFICE_PREVIEW_TEMP_PREFIX))
}

type Converted = Pick<OfficePreviewConversion, 'pdf' | 'missingFonts'>
type Convert = (
  bytes: Uint8Array,
  extension: OfficePreviewFormat,
  signal: AbortSignal
) => Promise<Converted>

interface Reader {
  job: Job
  readonly source: string
  readonly priority: OfficePreviewPriority
  readonly resolve: (value: OfficePreviewConversion) => void
  readonly reject: (error: unknown) => void
  readonly cleanup: () => void
}

interface Job {
  readonly request: OfficePreviewRequest
  readonly controller: AbortController
  readonly readers: Set<Reader>
  readonly sources: Set<string>
  priority: OfficePreviewPriority
  state: 'queued' | 'running' | 'finished'
}

/**
 * 一个有界的转换队列：**先准入、后读字节**，同一份内容只转一次。
 *
 * 三个索引各管一件事：
 *   - `aliases`：源定位（key+版本+扩展名）→ 内容键。授权过、stat 没变就能直接吃缓存，**不重读文件**；
 *   - `digests`：内容键 → 在途作业。两个不同路径指向同一份内容时共享同一次转换；
 *   - `sources`：源定位 → 在途作业。同一个文件被连点两次时共享同一个作业。
 *
 * 读者（reader）是调用方视角的账：任何一个读者取消只释放它自己，**最后一个**读者走了才取消共享作业；
 * 而共享作业的取消/失败会把还挂着的读者一起拒掉。运行中的引擎容量不会被"排队者取消"提前释放
 * （预留一直到真正的读/转换收尾才归还）。
 */
export class OfficePreviewQueue {
  private readonly ready = new Map<string, OfficePreviewConversion>()
  private readonly aliases = new Map<string, string>()
  private readonly sources = new Map<string, Job>()
  private readonly digests = new Map<string, Job>()
  private readonly queue: Job[] = []
  private readonly tasks = new Set<Promise<void>>()
  private readonly jobs = new Set<Job>()
  private cachedBytes = 0
  private sourceBytes = 0
  private running = 0
  private background = 0
  private readers = 0
  private disposed = false

  constructor(
    private readonly config: OfficePreviewConfig,
    private readonly generation: string,
    private readonly convert: Convert
  ) {}

  /**
   * 准入一个已经授权过的源，并按需读字节、共享转换。
   * @param request 已授权元数据 + 延迟的有界读取
   * @param signal 这一位读者的生命周期（**不是**共享作业的生命周期）
   * @returns 这一位读者自己的一份 PDF 字节；取消按信号的原因拒
   */
  async read(
    request: OfficePreviewRequest,
    signal?: AbortSignal
  ): Promise<OfficePreviewConversion> {
    signal?.throwIfAborted()
    if (this.disposed) throw this.unavailable()
    if (request.source.bytes !== undefined && request.source.bytes > this.config.maxInputBytes) {
      throw new OfficePreviewError('input-too-large', '源文件超过 maxInputBytes')
    }
    const source = JSON.stringify([request.source.key, request.source.version, request.extension])
    const alias = this.aliases.get(source)
    const cached = alias === undefined ? undefined : this.ready.get(alias)
    if (cached !== undefined) {
      // 命中即刷新 LRU 次序（Map 的插入序就是 LRU 序）
      this.ready.delete(cached.cacheKey)
      this.ready.set(cached.cacheKey, cached)
      this.aliases.delete(source)
      this.aliases.set(source, cached.cacheKey)
      return this.copy(cached)
    }
    // 最后一个读者位留给前台：后台预热不该把用户要看的那一份挤掉
    const readerLimit =
      request.priority === 'background' ? this.config.maxReaders - 1 : this.config.maxReaders
    if (this.readers >= readerLimit) throw this.busy()
    if (request.priority === 'background' && this.config.maxBackgroundConversions === 0)
      throw this.busy()
    let job = this.sources.get(source)
    if (job === undefined) {
      if (this.queue.length >= this.config.maxQueuedJobs) {
        // 队满：前台可以把排队中的**预热**挤掉，后台只能等
        const obsolete =
          request.priority === 'foreground'
            ? this.queue.find((item) => item.priority === 'background')
            : undefined
        if (obsolete === undefined) throw this.busy()
        this.fail(obsolete, this.busy())
      }
      job = {
        request,
        priority: request.priority,
        controller: new AbortController(),
        readers: new Set(),
        sources: new Set([source]),
        state: 'queued'
      }
      this.sources.set(source, job)
      this.jobs.add(job)
      this.queue.push(job)
    }
    const shared = job
    if (request.priority === 'foreground') shared.priority = 'foreground'
    this.readers++
    const promise = new Promise<OfficePreviewConversion>((resolve, reject) => {
      const abort = (): void => {
        this.release(reader)
        const reason: unknown = signal?.reason
        reject(reason instanceof Error ? reason : new Error('办公档转换已取消', { cause: reason }))
        if (reader.job.readers.size === 0) this.cancel(reader.job)
        // 取消或降级都可能让排队中的后台作业立刻变得可跑
        this.drain()
      }
      const reader: Reader = {
        job: shared,
        source,
        priority: request.priority,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort)
      }
      shared.readers.add(reader)
      signal?.addEventListener('abort', abort, { once: true })
    })
    this.drain()
    return promise
  }

  /** 取消所有读者，并等到真实的读、转换、临时目录清理都收尾 */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const job of this.jobs) this.fail(job, this.unavailable())
    this.ready.clear()
    this.aliases.clear()
    this.cachedBytes = 0
    await Promise.allSettled(this.tasks)
  }

  private busy(): OfficePreviewError {
    return new OfficePreviewError('busy', '转换队列已满（读者或作业到上限）')
  }
  private unavailable(): OfficePreviewError {
    return new OfficePreviewError('unavailable', '转换服务已停用')
  }
  private copy(result: OfficePreviewConversion): OfficePreviewConversion {
    // 每一位读者拿到**独立**的字节与字体数组：谁改自己的都不会污染别人的
    return { ...result, pdf: Uint8Array.from(result.pdf), missingFonts: [...result.missingFonts] }
  }
  private release(reader: Reader): void {
    reader.job.readers.delete(reader)
    if (reader.job.state === 'queued') {
      // 排队中的作业跟着"还在的读者"改优先级（前台读者走了就退回后台）
      reader.job.priority = [...reader.job.readers].some((other) => other.priority === 'foreground')
        ? 'foreground'
        : 'background'
    }
    if (![...reader.job.readers].some((other) => other.source === reader.source)) {
      reader.job.sources.delete(reader.source)
      if (this.sources.get(reader.source) === reader.job) this.sources.delete(reader.source)
    }
    reader.cleanup()
    this.readers--
  }
  private cancel(job: Job): void {
    job.controller.abort()
    if (job.state === 'queued') {
      this.queue.splice(this.queue.indexOf(job), 1)
      job.state = 'finished'
      this.jobs.delete(job)
    }
  }
  private fail(job: Job, error: unknown): void {
    for (const reader of job.readers) {
      this.release(reader)
      reader.reject(error)
    }
    this.cancel(job)
  }
  private reservation(job: Job): number {
    return Math.max(1, job.request.source.bytes ?? this.config.maxInputBytes)
  }

  private drain(): void {
    while (!this.disposed && this.running < this.config.maxConcurrentConversions) {
      const eligible = (job: Job): boolean =>
        this.sourceBytes + this.reservation(job) <= this.config.maxSourceBytes &&
        (job.priority === 'foreground' ||
          this.background <
            Math.min(
              this.config.maxBackgroundConversions,
              Math.max(1, this.config.maxConcurrentConversions - 1)
            ))
      const foregroundWaiting = this.queue.some((item) => item.priority === 'foreground')
      // 有前台在排队时，后台一律让路（哪怕后台自己已经在等源容量）
      const job = this.queue.find(
        (item) => (!foregroundWaiting || item.priority === 'foreground') && eligible(item)
      )
      if (job === undefined) return
      this.queue.splice(this.queue.indexOf(job), 1)
      job.state = 'running'
      const background = job.priority === 'background'
      const reserved = this.reservation(job)
      this.running++
      if (background) this.background++
      this.sourceBytes += reserved
      const task = this.execute(job, reserved)
        .catch((error: unknown) => {
          this.fail(job, error)
        })
        .finally(() => {
          this.running--
          if (background) this.background--
          this.sourceBytes -= reserved
          job.state = 'finished'
          this.jobs.delete(job)
          this.tasks.delete(task)
          this.drain()
        })
      this.tasks.add(task)
    }
  }

  private async execute(job: Job, reserved: number): Promise<void> {
    const signal = job.controller.signal
    signal.throwIfAborted()
    const input = await job.request.source.read(signal, reserved)
    signal.throwIfAborted()
    if (input.version !== job.request.source.version) {
      throw new OfficePreviewError('source-changed', '源文件在等待转换期间被改了')
    }
    if (input.bytes.byteLength > reserved) {
      throw new OfficePreviewError('input-too-large', '源文件超过预留的读取容量')
    }
    // 内容标识含扩展名：同一份字节换个扩展名就是另一次转换（引擎按扩展名判格式）
    const digest = createHash('sha256')
      .update(job.request.extension)
      .update('\0')
      .update(input.bytes)
      .digest('hex')
    const key = `${this.generation}:${digest}`
    const cached = this.ready.get(key)
    if (cached !== undefined) {
      this.ready.delete(key)
      this.ready.set(key, cached)
      this.finish(job, cached)
      return
    }
    // 同一份内容正在转换：把这位读者的账并过去（不重复读、不重复转）
    const existing = this.digests.get(key)
    if (existing !== undefined && !existing.controller.signal.aborted) {
      if (job.priority === 'foreground') existing.priority = 'foreground'
      for (const reader of job.readers) {
        reader.job = existing
        existing.readers.add(reader)
      }
      job.readers.clear()
      for (const source of job.sources) {
        existing.sources.add(source)
        this.sources.set(source, existing)
      }
      job.sources.clear()
      return
    }
    this.digests.set(key, job)
    try {
      const converted = await this.convert(input.bytes, job.request.extension, signal)
      signal.throwIfAborted()
      const result = { ...converted, cacheKey: key, generation: this.generation }
      this.retain(result)
      this.finish(job, result)
    } finally {
      if (this.digests.get(key) === job) this.digests.delete(key)
    }
  }

  private finish(job: Job, result: OfficePreviewConversion): void {
    for (const source of job.sources) this.sources.delete(source)
    if (this.ready.has(result.cacheKey)) {
      for (const source of job.sources) {
        this.aliases.delete(source)
        this.aliases.set(source, result.cacheKey)
        // 别名表自己也有上限（最老的先走）
        while (this.aliases.size > this.config.maxSourceEntries) {
          this.aliases.delete(this.aliases.keys().next().value as string)
        }
      }
    }
    for (const reader of job.readers) {
      this.release(reader)
      reader.resolve(this.copy(result))
    }
  }

  private retain(result: OfficePreviewConversion): void {
    // 超过单条缓存预算的 PDF 不留在缓存里（这一次照样回给调用方）
    if (result.pdf.byteLength > this.config.maxCachedBytes) return
    while (
      this.ready.size >= this.config.maxCachedEntries ||
      this.cachedBytes + result.pdf.byteLength > this.config.maxCachedBytes
    ) {
      const [key, oldest] = this.ready.entries().next().value as [string, OfficePreviewConversion]
      this.ready.delete(key)
      this.cachedBytes -= oldest.pdf.byteLength
      for (const [source, digest] of this.aliases) if (digest === key) this.aliases.delete(source)
    }
    this.ready.set(result.cacheKey, result)
    this.cachedBytes += result.pdf.byteLength
  }
}

/** 校验配置（`OfficePreview` 构造时一次性做完，跑起来就不再判） */
function resolveConfig(partial: Partial<OfficePreviewConfig>): OfficePreviewConfig {
  const config: OfficePreviewConfig = { ...DEFAULT_OFFICE_PREVIEW_CONFIG, ...partial }
  const counts: readonly (readonly [keyof OfficePreviewConfig, number, number])[] = [
    ['maxConcurrentConversions', 1, Number.MAX_SAFE_INTEGER],
    ['maxQueuedJobs', 1, Number.MAX_SAFE_INTEGER],
    ['maxReaders', 1, Number.MAX_SAFE_INTEGER],
    ['maxSourceBytes', 1, Number.MAX_SAFE_INTEGER],
    ['maxBackgroundConversions', 0, Number.MAX_SAFE_INTEGER],
    ['maxCachedEntries', 1, Number.MAX_SAFE_INTEGER],
    ['maxCachedBytes', 1, Number.MAX_SAFE_INTEGER],
    ['maxSourceEntries', 1, Number.MAX_SAFE_INTEGER],
    ['timeoutMs', 1, 2_147_483_647],
    ['maxInputBytes', 1, Number.MAX_SAFE_INTEGER - 1],
    ['maxOutputBytes', 1, Number.MAX_SAFE_INTEGER - 1],
    ['maxImageResolution', 1, 2_147_483_647],
    ['maxArchiveEntries', 1, Number.MAX_SAFE_INTEGER],
    ['maxUncompressedBytes', 1, Number.MAX_SAFE_INTEGER],
    ['maxFontFiles', 1, Number.MAX_SAFE_INTEGER],
    ['maxFontFileBytes', 1, Number.MAX_SAFE_INTEGER],
    ['maxLoadedFontBytes', 1, Number.MAX_SAFE_INTEGER]
  ]
  for (const [name, min, max] of counts) {
    const value = config[name] as number
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(
        `办公档预览的配置 ${name} 必须是 ${min}..${max} 的整数（拿到 ${String(value)}）`
      )
    }
  }
  for (const directory of config.fontDirectories ?? []) {
    if (!isAbsolute(directory)) throw new Error('fontDirectories 必须是绝对路径')
  }
  for (const group of config.fontFallbacks ?? []) {
    if (group.length < 2 || group.some((name) => name.trim() === '')) {
      throw new Error('fontFallbacks 的每一组至少要两个非空白字体名')
    }
  }
  if (config.maxSourceBytes < config.maxInputBytes) {
    throw new Error('maxSourceBytes 不能小于 maxInputBytes')
  }
  return config
}

/**
 * 办公档页式预览服务：**一个进程一个实例**（接线层在 `registerWorkbenchIpc` 那层建一次，
 * 关窗口/退出一并 dispose）。所有转换共用同一份准入与缓存，行为见 `OfficePreviewQueue`。
 *
 * `generation` 是这一份服务实例的代次：跨进程重启才会变。当前实现里引擎配置在构造时就固定，
 * 所以它只用于"渲染端把缓存与它绑在一起"（代次不一致 = 那些 PDF 一律作废）。
 */
export class OfficePreview {
  readonly generation: string = randomUUID()
  private readonly config: OfficePreviewConfig
  private readonly queue: OfficePreviewQueue

  constructor(config: Partial<OfficePreviewConfig> = {}, deps: OfficePreviewDeps = {}) {
    this.config = resolveConfig(config)
    const engine = new KitEngine(this.config, deps)
    this.queue = new OfficePreviewQueue(this.config, this.generation, (bytes, format, signal) =>
      engine.convert(bytes, format, signal)
    )
  }

  /** 这份服务实例的代次（渲染端缓存与它绑定；不许解析） */
  getGeneration(): string {
    return this.generation
  }

  /**
   * 把一个**已授权**的办公档转成 PDF 字节。
   * @param request 授权元数据 + 延迟有界读取（本模块不看路径，见文件头注第 1 条）
   * @param signal 调用方取消；取消按信号原因拒，其他失败按 `OfficePreviewError.code` 分类
   */
  convert(request: OfficePreviewRequest, signal?: AbortSignal): Promise<OfficePreviewConversion> {
    if (!officePreviewFormatSchema.safeParse(request.extension).success) {
      return Promise.reject(
        new OfficePreviewError(
          'unsupported-format',
          `页式预览只支持 doc / docx / ppt / pptx（拿到 ${String(request.extension)}）`
        )
      )
    }
    if (typeof request.source?.read !== 'function') {
      return Promise.reject(new Error('页式预览的源必须带一个 read(signal, maxBytes) 回调'))
    }
    return this.queue.read(request, signal)
  }

  /** 取消所有在途读者、等到真实收尾（应用退出/窗口销毁时调用） */
  dispose(): Promise<void> {
    return this.queue.dispose()
  }
}

/** 接线层用的构造入口（与 `createTerminalService` 同一风格） */
export function createOfficePreview(
  config: Partial<OfficePreviewConfig> = {},
  deps: OfficePreviewDeps = {}
): OfficePreview {
  return new OfficePreview(config, deps)
}
