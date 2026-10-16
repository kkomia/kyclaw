/**
 * 旧版 Office（.doc / .xls / .ppt —— OLE 复合文档）→ OOXML（.docx / .xlsx / .pptx）的转换器。
 *
 * 为什么要有它：read 按类型分派，但**旧版 Office 二进制一直只有"说清它是什么 + 让用户自己另存"**
 * 这一档（见 read.ts 的 ole 分支），而用户丢过来的恰恰多是这一类。转换交给**随包的 LibreOffice kit**
 * （round 68 已随包，见 render-ppt.ts 头注）：`dsoffice convert` 就支持 doc→docx / xls→xlsx / ppt→pptx
 * （kit 的 `CONVERSION_FORMATS`，`resources/libreoffice-kit/.../lib/index.js`），一次调用出目标格式文件。
 * 本模块只做"把文件换成新格式的字节"这一件事，返回 `{bytes, format}` —— 抽正文（mammoth / exceljs /
 * extractPptx）是调用方的事，这里不碰。
 *
 * ## 不变量（这几条比功能重要）
 *
 *   1. **原件一个字节都不动**：只以 `open(path,'r')` 读文件头，再把原件 `copyFile` 进**我们自己建的
 *      临时目录**；**引擎读的是那份副本**（副本固定叫 `input.<kind>`，顺带把扩展名钉死 —— 引擎按扩展名
 *      判输入格式，原件叫什么都无所谓）。引擎的锁文件 / 中间产物 / 半成品因此只会落在我们的临时目录里，
 *      用户文件的旁边不会多出任何东西。
 *   2. **输出只写自建目录**：`mkdtemp` 出来的私有目录（`kyclaw-legacy-office-XXXXXX`，在系统临时目录下），
 *      输出路径就在里面且**从不预先创建**（kit 用独占模式建文件，目标已存在即 `EEXIST` 失败）。收尾
 *      `rm` 的**只有这一个自建目录**（带 `maxRetries`：Windows 上句柄释放可能慢一拍），不碰系统临时
 *      目录本身、不碰用户文件的目录。
 *   3. **超时与中止都真的收掉进程**：走 `runProcess`（bash / git / render_ppt 共用的那份）—— 超时杀
 *      进程树；`signal` 一响按同一套杀法收。两者**分开报**：中止抛 `AbortError`（仓库口径，见
 *      error-text.ts / fetch.ts 按名字判"不是失败"），别让"用户点了停止"读成"这份文件转不了"。
 *   4. **两道闸 + 产出校验**：输入必须扩展名与 kind 一致**且**文件头是 OLE 复合文档
 *      （`D0 CF 11 E0 A1 B1 1A E1`）；产出必须大小合理、以 `PK\x03\x04` 开头、`[Content_Types].xml`
 *      **真的声明了该格式的主部件类型**、且主部件在包内（"PK 主类型"，见 OOXML_MAIN）—— 引擎要是吐出
 *      一份 PDF 改名成 .docx，这里就拦下，绝不把不是那个格式的字节交出去。
 *   5. **工作区边界不在这层**：本模块只认绝对路径（相对路径直接拒），不做 toolTarget —— 调用方
 *      （read）负责把路径归一进授权工作区（见 guard.toolTarget）与审批档位。
 *
 * ## 安全口径（宏 / 外部链接）—— **查的是引擎源码与构建清单，不是 JS 注释**
 *
 * 只复用随包引擎，**不新增任何"打开宏 / 刷新外链"的开关**，也不许将来有人加。下面每条都能在随包的
 * native 源码 / 构建清单里指到出处（`resources/libreoffice-kit/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/`，
 * 且这些文件列在 `prebuilds.json` 的 `source.files` 完整性清单里 —— 与 `bin/libreoffice-kit.exe` 同包）：
 *
 *   - **宏在加载时就被关掉，且写死在 helper 里**：`sources/engine/native/worker.cxx` 的
 *     `loadDocument()` 是 `documentLoadWithOptions(office, input, "Batch=true,EnableMacrosExecution=false")`；
 *     该文件由 `sources/engine/native/build-helper.mjs` 编译成 `bin/libreoffice-kit.exe`。同一个 worker 的
 *     参数解析（`parse()`）只认 `--operation / --program-directory / --input-path / --output-path /
 *     --scratch-directory / --profile-directory / --format / --sheet / --recalculate / --font-file /
 *     --max-output-bytes / --max-image-resolution` —— **没有任何开关能把宏打开**，JS 层想放也放不了。
 *   - **引擎根本没编 Basic / 脚本子系统**：`sources/engine/native/configure.mjs` 与 `sources/engine/core.json`
 *     的 configure 参数含 `--disable-scripting`（另有 `--disable-extensions`、`--disable-database-connectivity`、
 *     `--disable-online-update`、`--disable-dynamic-loading`）；配套补丁
 *     `…/patches/0021-windows-disabled-basic-exports.patch`、`…/patches/0022-disable-basic-manager-listener.patch`
 *     把 Basic 相关代码整段收进 `#if HAVE_FEATURE_SCRIPTING`。
 *   - **外部更新 / 外链不刷新**：补丁 `…/patches/0001-disable-external-updates.patch` 在
 *     `lo_documentLoadWithOptions` 里强制 `UpdateDocMode::NO_UPDATE`（把上游注释掉的
 *     `ACCORDING_TO_CONFIG` 换成"永不更新"）；抓外链所需的网络栈也没编进去
 *     （configure 的 `--disable-curl`、`--without-webdav`、`--without-gssapi`）。
 *   - **外链图片不加载**：补丁 `…/patches/0029-unloaded-external-blip.patch` 在 LOK 模式下直接用缓存的内嵌图
 *     返回，不取外链图片数据。
 *   - **进程自身收口**：`worker.cxx` 的 `prepareEnvironment()` 设 `LOK_HOST_ALLOWLIST=^$`（空允许表）、
 *     `SAL_DISABLE_OPENCL=1`、`SAL_ACCESSIBILITY_ENABLED=0`；kit README 另记
 *     `SAL_DISABLE_PRINTERLIST=1` / `SAL_DISABLE_DEFAULTPRINTER=1`（不起打印机驱动对话框）。
 *
 * **本轮没验的（别在这儿写"已验"）**：① 随包 `bin/libreoffice-kit.exe` 与上面这些源码是否逐字节对应
 * （没重编，只有同包的完整性清单可查）；② "带 AutoOpen 宏的真 .doc/.xls/.ppt 转换后宏确实没执行"的
 * **运行时**证据 —— 本轮不跑引擎、不跑测试，探针与夹具方案见 spec 与交接报告，由验证槽执行。
 */
import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { formatSeconds, runProcess } from './exec'
import { resolveKitCli } from './render-ppt'

/** 旧版 Office 的 OLE 复合文档头（与 read.ts 的 OLE_HEAD 同一个判据） */
const OLE_HEAD = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** 单份输入上限（与 kit 自己的 `maxInputBytes` 默认值同档；也显式传给引擎，两边不许各说各话） */
export const LEGACY_INPUT_MAX_BYTES = 64 * 1024 * 1024

/** 单份产出上限（对应 kit 的 `maxOutputBytes`；再大下游那侧的抽取上限也用不上，不如在这儿如实拒） */
export const LEGACY_OUTPUT_MAX_BYTES = 64 * 1024 * 1024

/** 引擎侧转换截止（毫秒）—— 与 kit 自己的默认 `timeoutMs` 取同一个数 */
export const LEGACY_CONVERT_TIMEOUT_MS = 120_000

/** 进程侧宽限：比引擎截止多给这么多，让引擎**先**自己报"超时"（它给的原因比我们的猜准） */
export const LEGACY_RUN_GRACE_MS = 30_000

/** 私有临时目录前缀（`mkdtemp` 会再补 6 位随机；收尾只删这一个自建目录） */
export const LEGACY_TEMP_PREFIX = 'kyclaw-legacy-office-'

/** 认得的输入种类（= 目标格式的扩展名来源） */
export type LegacyOfficeKind = 'doc' | 'xls' | 'ppt'

/** 转换出来的格式 */
export type LegacyOfficeFormat = 'docx' | 'xlsx' | 'pptx'

/** 一次转换的结果：新格式的**整份字节**（调用方拿去抽正文或落盘，本模块不写用户目录） */
export interface LegacyOfficeConversion {
  bytes: Buffer
  format: LegacyOfficeFormat
}

/**
 * 子进程那层的可注入形状（与 render-ppt 的 `RenderRunner` 同一思路）：
 * 缺省 = 真 `runProcess`；单测注入假件，**一个真进程都不起**。
 */
export interface LegacyRunSpec {
  command: string
  args: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}

export interface LegacyRunResult {
  spawnError: Error | null
  aborted: boolean
  timedOut: boolean
  exitCode: number | null
  text: string
}

export type LegacyRunner = (spec: LegacyRunSpec) => Promise<LegacyRunResult>

/**
 * 依赖注入点（**只给单测与排障用**，生产路径一个都不用填）：
 *   - `kitCli`：`null` = 明确"这台机器没有随包引擎"（单测不许跟着开发机变）；
 *   - `run`：接管子进程那一步（单测据此断言参数形状、伪造产出）；
 *   - `makeTempDir`：接管临时目录（单测指向自己建的目录，避免往系统临时目录里丢东西）；
 *   - `timeoutMs`：改引擎侧截止（单测别真等两分钟）；
 *   - `inputMaxBytes` / `outputMaxBytes`：改单份上限（单测别真造 64MB 的文件）—— **注入值会一并
 *     传给引擎**（`--max-input-bytes` / `--max-output-bytes`），两边永远是同一个数。
 */
export interface LegacyConvertDeps {
  kitCli?: string | null
  run?: LegacyRunner
  makeTempDir?: () => Promise<string>
  timeoutMs?: number
  inputMaxBytes?: number
  outputMaxBytes?: number
}

/** 输入 kind → 目标格式（这份表同时是"认得的 kind"白名单：运行时入参可能来自 JS / 测试） */
const TARGETS: Readonly<Record<string, LegacyOfficeFormat | undefined>> = {
  doc: 'docx',
  xls: 'xlsx',
  ppt: 'pptx'
}

/**
 * 每种目标格式的**主部件**与它在 `[Content_Types].xml` 里声明的 content type。
 * 判据口径与产出侧的结构自检（artifact-check.ts 的 `KINDS`）**逐字一致**：那边校验"我们生成的"包、
 * 这里校验"引擎生成的"包，但"什么才算一份真的 .docx"必须是同一个定义（两处要改就一起改）。
 */
const OOXML_MAIN: Readonly<Record<LegacyOfficeFormat, { contentType: string; primary: string }>> = {
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    primary: 'word/document.xml'
  },
  xlsx: {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    primary: 'xl/workbook.xml'
  },
  pptx: {
    contentType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    primary: 'ppt/presentation.xml'
  }
}

const CONTENT_TYPES = '[Content_Types].xml'
const ZIP_EOCD = 0x06054b50
const ZIP_CENTRAL_ENTRY = 0x02014b50
const ZIP_LOCAL_HEADER = 0x04034b50
/** zip64 的哨兵值：不认（引擎产出的是常规 zip32），认不出就走"读不出中央目录"那条人话 */
const ZIP64_COUNT_SENTINEL = 0xffff
const ZIP64_OFFSET_SENTINEL = 0xffffffff
/** EOCD 落在文件末尾 22 字节 + 最多 65535 字节注释之内 */
const EOCD_SEARCH_BYTES = 65_557

/** zip 中央目录的**索引**：条目名 + `[Content_Types].xml` 的正文（只解那一个小件） */
interface ZipIndex {
  names: readonly string[]
  contentTypes: string | null
}

/** 真实现：与 bash / git / render_ppt 同一条进程内核（超时杀进程树 + 用户中止同一套杀法） */
const realLegacyRun: LegacyRunner = (spec) => runProcess(spec)

/** 随包 kit 在不在（调用方想在**转换之前**就知道，可以据此回一句更准的退化说明；不启动任何进程） */
export function legacyConverterAvailable(): boolean {
  return resolveKitCli() !== null
}

/** 自建私有临时目录；收尾只删这一个（`mkdtemp` 保证建出来是新目录） */
async function makeLegacyTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), LEGACY_TEMP_PREFIX))
}

/** 字节数 → 人话（回执里报真实值，不四舍五入成整数；与 read.ts 的 formatSize 同一口径） */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes} 字节`
}

/** 只读地读文件头（`open(path,'r')`：原件从不以写模式打开） */
async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(length)
    const { bytesRead } = await handle.read(head, 0, length, 0)
    return head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** 认得出 OLE 复合文档头（旧版 .doc/.xls/.ppt 共用这一个头 —— 分不出是哪一件，所以 kind 由调用方给） */
function isOle(head: Buffer): boolean {
  return head.length >= OLE_HEAD.length && head.subarray(0, OLE_HEAD.length).equals(OLE_HEAD)
}

/**
 * 用户中止：名字按仓库惯例用 `AbortError`（error-text.ts / fetch.ts 都按这个名字判"不是失败"）——
 * 调用方据此回"已被用户中止"，别读成"这份文件转不了"。
 */
function abortedError(name: string): Error {
  const error = new Error(`已被用户中止：没有转换 ${name}`)
  error.name = 'AbortError'
  return error
}

/**
 * 读 zip 的**中央目录索引**（返回 null = 读不出来：不是 zip / 截断 / zip64 / 中央目录签名不对）。
 *
 * 为什么不直接用 artifact-check 的 `readZipEntries`：那份会把**整包**解压出来（它对产出物做全量结构
 * 自检，代价是值得的）；这里只回答"是不是这个格式"，为它把一份 20MB 的包连图带 XML 全 inflate 一遍
 * 不划算。所以这里只解 `[Content_Types].xml`（几十 KB 级）—— **不做 CRC 校验**，包完整性由下游抽取器
 * （mammoth / exceljs / readZipEntries）负责，这一层不重复也不越权。
 */
function readZipIndex(bytes: Buffer): ZipIndex | null {
  if (bytes.length < 22) return null
  const earliest = Math.max(0, bytes.length - EOCD_SEARCH_BYTES)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_EOCD) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) return null

  const count = bytes.readUInt16LE(eocd + 10)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  if (count === ZIP64_COUNT_SENTINEL || centralOffset === ZIP64_OFFSET_SENTINEL) return null

  const names: string[] = []
  let contentTypes: string | null = null
  let offset = centralOffset

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== ZIP_CENTRAL_ENTRY) return null
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength)

    names.push(name)
    if (name === CONTENT_TYPES) {
      contentTypes = readZipEntryText(bytes, localOffset, method, compressedSize)
    }
    offset += 46 + nameLength + extraLength + commentLength
  }

  return { names, contentTypes }
}

/** 读一个条目的正文（store / deflate 两种；其余压缩方式返回 null） */
function readZipEntryText(
  bytes: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number
): string | null {
  if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) {
    return null
  }
  // 局部头里的 name/extra 长度可能与中央目录不同，必须按局部头重新算数据起点
  const dataStart =
    localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28)
  if (dataStart + compressedSize > bytes.length) return null
  const raw = bytes.subarray(dataStart, dataStart + compressedSize)
  if (method === 0) return raw.toString('utf8')
  if (method !== 8) return null
  try {
    return inflateRawSync(raw).toString('utf8')
  } catch {
    return null
  }
}

/** 文件头的人话（看得出是文本就给那几个字符，看不出给十六进制） */
function describeHead(bytes: Buffer): string {
  const head = bytes.subarray(0, 4)
  const printable = head.length === 4 && head.every((byte) => byte >= 0x20 && byte <= 0x7e)
  if (printable) return `前 4 字节是 "${head.toString('latin1')}"`
  return `前 ${Math.min(8, bytes.length)} 字节是 ${bytes.subarray(0, 8).toString('hex')}`
}

/**
 * 校验产出是不是**它自称的那份 OOXML**（返回 null = 通过，否则是给人看的原因）。
 * 三道：① `PK\x03\x04`（zip 局部头）② `[Content_Types].xml` 声明了该格式的主部件类型 ③ 主部件在包内。
 */
function ooxmlProblem(bytes: Buffer, format: LegacyOfficeFormat): string | null {
  if (bytes.subarray(0, 4).toString('latin1') !== 'PK\x03\x04') {
    return `文件头不是 PK（zip 局部头）——${describeHead(bytes)}`
  }
  const index = readZipIndex(bytes)
  if (index === null) return '读不出 zip 中央目录（包被截断、不是常规 zip，或是 zip64）'
  const spec = OOXML_MAIN[format]
  if (index.contentTypes === null) return `包内没有 ${CONTENT_TYPES}（OOXML 必备件）`
  if (!index.contentTypes.includes(spec.contentType)) {
    return `${CONTENT_TYPES} 没有声明 .${format} 的主部件类型（${spec.contentType}）`
  }
  if (!index.names.includes(spec.primary)) return `包内没有主部件 ${spec.primary}`
  return null
}

/**
 * kit 失败时在输出里回一行 JSON（`{"code":"…","error":"…"}`，见 kit 的 `lib/cli.js` catch 块；
 * 它写的是 stderr，而 `runProcess` 把两条流并进同一份 text，所以这里扫 text 的最后一行 JSON）。
 */
function kitFailure(text: string): { code: string; error: string } | null {
  const last = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .pop()
  if (last === undefined) return null
  try {
    const parsed = JSON.parse(last) as { code?: unknown; error?: unknown }
    if (typeof parsed.error !== 'string') return null
    return { code: typeof parsed.code === 'string' ? parsed.code : 'failed', error: parsed.error }
  } catch {
    return null
  }
}

/**
 * 引擎失败 → 人话（按 kit 的 `ConversionError.code` 分档，`error` 原文一并带上 —— 排障时它比我们的
 * 转述有用）。取不到那行 JSON 就退回输出尾部（与 render-ppt 的 `kitFailureDetail` 同一口径）。
 */
function kitFailureMessage(
  text: string,
  name: string,
  kind: LegacyOfficeKind,
  outputMax: number
): string {
  const failure = kitFailure(text)
  if (failure === null) {
    const tail = text.trim().split('\n').slice(-3).join(' ').slice(0, 300)
    return tail === ''
      ? `转换失败：随包 LibreOffice 报错，但没给出原因（${name}）`
      : `转换失败：随包 LibreOffice 报错（${tail}）`
  }
  const detail = `（引擎的话：${failure.error}）`
  switch (failure.code) {
    case 'invalid-document':
      return `转换失败：引擎读不出这份 .${kind}（${name}）—— 可能已损坏、带密码，或不是真正的旧版 Office 文件${detail}`
    case 'unsupported-format':
      return `转换失败：引擎不支持这个转换方向（.${kind} → .${TARGETS[kind] ?? '?'}）${detail}`
    case 'input-too-large':
      return `转换失败：这份 .${kind} 超过引擎的单份上限（${name}）${detail}`
    case 'output-too-large':
      return `转换失败：转出来的文件超过单份 ${formatSize(outputMax)}的上限（${name}）${detail}`
    case 'timeout':
      return `转换超时：${name}${detail}`
    case 'unavailable':
      return `转换失败：这台机器上的随包 LibreOffice 起不来（安装不完整？）（${name}）${detail}`
    default:
      return `转换失败：随包 LibreOffice 转换 ${name} 时出错${detail}`
  }
}

/**
 * 把一份旧版 Office 文件（`.doc` / `.xls` / `.ppt`）转成 OOXML，返回**整份字节**。
 *
 * 失败一律抛**中文人话**（原因 + 下一步），`AbortError` 表示用户中止（不是文件的问题）。
 * 原件不会被改动、也不会在它旁边落下任何文件；产出只在本模块自建的临时目录里短暂存在，
 * 读完就被删掉（异常路径同样删）。
 *
 * 工作区边界由调用方负责：这里的 `abs` 必须已经是**归一进授权工作区**的绝对路径
 * （read 那侧的 `toolTarget`）；本模块只做格式与安全校验，不做路径授权。
 */
export async function convertLegacyOffice(
  abs: string,
  kind: LegacyOfficeKind,
  signal?: AbortSignal,
  deps: LegacyConvertDeps = {}
): Promise<LegacyOfficeConversion> {
  const target = TARGETS[kind]
  if (target === undefined) {
    throw new Error(`转换失败：不认识的 kind=${String(kind)}（只认 doc / xls / ppt）`)
  }
  const name = basename(abs)
  // 生效的上限：注入值优先（**同一个数会一并传给引擎**，两边不许各说各话）
  const inputMax = deps.inputMaxBytes ?? LEGACY_INPUT_MAX_BYTES
  const outputMax = deps.outputMaxBytes ?? LEGACY_OUTPUT_MAX_BYTES
  if (!isAbsolute(abs)) {
    throw new Error(`转换失败：只认绝对路径（拿到的是 ${abs}）—— 工作区归一由调用方做`)
  }
  // 停止键已经响了：一个副作用都不留（不建临时目录、不复制、不起进程）
  if (signal?.aborted === true) throw abortedError(name)

  const extension = extname(abs).toLowerCase()
  if (extension !== `.${kind}`) {
    throw new Error(
      `转换失败：${name} 的扩展名是 ${extension === '' ? '（没有）' : extension}，与 kind='${kind}' 对不上 —— ` +
        '不猜也不硬按 kind 转：要转就把扩展名改对（或另存一份真的 .doc / .xls / .ppt）'
    )
  }

  const sourceStat = await stat(abs).catch(() => null)
  if (sourceStat === null || !sourceStat.isFile()) {
    throw new Error(`转换失败：${name} 不存在或不是文件`)
  }
  if (sourceStat.size > inputMax) {
    throw new Error(
      `转换失败：${name} 有 ${formatSize(sourceStat.size)}，超过单份 ${formatSize(inputMax)}的上限 —— ` +
        '先只取要处理的那部分，或另存一份小一点的再转'
    )
  }
  if (!isOle(await readHead(abs, OLE_HEAD.length))) {
    throw new Error(
      `转换失败：${name} 的文件头不是旧版 Office 二进制（OLE）—— 它多半不是 Word / Excel / PowerPoint ` +
        '97-2003 文件（改过扩展名？），或者已经损坏'
    )
  }

  const cli = deps.kitCli !== undefined ? deps.kitCli : resolveKitCli()
  if (cli === null) {
    throw new Error(
      '转换失败：随包的 LibreOffice 没装上（`resources/libreoffice-kit` 不在）—— 旧版 .doc / .xls / .ppt ' +
        '转不了；让用户在 Office 里另存为 .docx / .xlsx / .pptx，或先装好随包引擎再重试'
    )
  }

  const dir = await (deps.makeTempDir ?? makeLegacyTempDir)()
  try {
    const inputCopy = join(dir, `input.${kind}`)
    const outputPath = join(dir, `output.${target}`)
    // 副本：引擎读它，原件只被读过（`COPYFILE_EXCL`：绝不覆盖任何已存在的东西）
    await copyFile(abs, inputCopy, fsConstants.COPYFILE_EXCL)

    const engineTimeout = deps.timeoutMs ?? LEGACY_CONVERT_TIMEOUT_MS
    const result = await (deps.run ?? realLegacyRun)({
      // 与 render_ppt 同一条跑法：Electron 自带的 Node 模式跑 kit 的 CLI，不必随包独立 node.exe
      command: process.execPath,
      args: [
        cli,
        'convert',
        '--input',
        inputCopy,
        '--output',
        outputPath,
        '--timeout-ms',
        String(engineTimeout),
        '--max-input-bytes',
        String(inputMax),
        '--max-output-bytes',
        String(outputMax)
      ],
      // 工作目录也钉在我们的临时目录里：万一有什么相对路径的副作用，落点也是这里
      cwd: dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: engineTimeout + LEGACY_RUN_GRACE_MS,
      signal
    })

    if (result.spawnError !== null) {
      throw new Error(`转换失败：起不了随包的 LibreOffice（${cli}）：${result.spawnError.message}`)
    }
    if (result.aborted) throw abortedError(name)
    if (result.timedOut) {
      throw new Error(
        `转换超时（超过 ${formatSeconds(engineTimeout + LEGACY_RUN_GRACE_MS)} 秒）：${name} —— ` +
          '文件太大或引擎卡住；可以只取要处理的部分再试'
      )
    }
    if (result.exitCode !== 0)
      throw new Error(kitFailureMessage(result.text, name, kind, outputMax))

    // 退出码 0 也要看真的落了什么：拿不到产出就是失败，不假装成功
    const bytes = await readFile(outputPath).catch(() => null)
    if (bytes === null) {
      throw new Error(`转换失败：命令跑完了，但没有拿到 .${target} 产出（${name}）`)
    }
    if (bytes.length === 0) {
      throw new Error(`转换失败：转出来的 .${target} 是空文件（${name}）`)
    }
    if (bytes.length > outputMax) {
      throw new Error(
        `转换失败：转出来的 .${target} 有 ${formatSize(bytes.length)}，超过单份 ` +
          `${formatSize(outputMax)}的上限（${name}）`
      )
    }
    const problem = ooxmlProblem(bytes, target)
    if (problem !== null) {
      throw new Error(
        `转换失败：转出来的文件不是真正的 .${target}（${problem}）—— 引擎产出异常（${name}）`
      )
    }

    return { bytes, format: target }
  } finally {
    // 只删**这一次自建**的那个目录；删不掉（Windows 句柄慢一拍）也不该把已经拿到的结果或真实原因顶掉
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
      () => undefined
    )
  }
}
