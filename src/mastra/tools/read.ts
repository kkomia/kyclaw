/**
 * read 工具（round 71 起**按类型分派**，0.1.2 扩到**办公八格式**）：读授权工作区内的文件；
 * 011 起 `skill` 参数还能读**已注册技能目录内**的配套资源（只读信任根，见 `skill-read.ts`）。
 *
 * 为什么要有分派：用户实测反馈——丢来 PDF / Word / 图片时，模型吃不到原始输入，只能去 bash 里
 * 想办法或先转格式。现在一条 read 调用就能拿到内容，路径也**最省 token**（不必先转成中间格式）：
 *
 * **支持的格式表（这一轮就这些，不多不少）**：纯文本 / 图片 / `.pdf` / `.docx` / `.xlsx` / `.pptx` /
 * `.csv` / 旧版 `.doc` / `.xls` / `.ppt`。**启用宏的版本**（`.docm` / `.xlsm` / `.pptm` 这一族）与
 * **模板·放映变体**（`.dotx` / `.ppsx` 这一族）、`.xlsb` 一律**明确拒绝**（不假读、不宣称支持），
 * 各自给一句"是什么 / 为什么不读 / 下一步"（见 `UNSUPPORTED_OFFICE_EXTENSION`）。
 *
 *   - 文本（默认档）：原样 UTF-8，offset/limit 行窗口，>256KB 只读前 256KB 并附提示。
 *     **截断点收在 UTF-8 字符边界上**（StringDecoder 丢弃尾部不完整的多字节序列），不切出半个汉字。
 *   - `.pdf`：主进程的 PDF 文字层抽取（`src/main/pdf.ts`）——与"用户把 PDF 当附件发"那条路
 *     **同一份实现**，所以同一份文档走哪条路进来，模型看到的东西一样。**没有 OCR**：抽不到文字层
 *     就说"没有文字层"，不假装认出了扫描件的字。
 *   - `.docx`：主进程的 Word 抽取（`mammoth` → markdown，`src/main/workbench-office.ts`），
 *     内嵌图片只留"（图片已省略）"占位（不要把 base64 巨图灌进上下文）。
 *   - `.xlsx`：read 专用的表格抽取（`extractXlsxForRead`）——逐行带**行列定位**（`行 3: …` 从 A 列起）、
 *     公式写成 `=公式 → 结果`（**缓存的 0 与"没有缓存结果"必须分开**：exceljs 的 `cell.text` 会把两者
 *     都吞成空串）、日期走 UTC 稳定格式（不随宿主机时区挪一天）、**不吞首尾空格**（带引号显示）、
 *     合并区域只显示主人那一格。
 *   - `.pptx`：read 专用的逐页文字抽取（`extractPptxForRead`）——页序按 **presentation 关系**
 *     （文件名数字序只是多数情况下的巧合），图片 / 图表 / SmartArt **明说"内容没有读"**，
 *     绝不把图片页当成空白页。
 *   - `.csv`：表格档。先解编码（BOM → UTF-16LE/BE、严格 UTF-8、"GB18030 回退"且**标明是推测**；
 *     ICU 不全时给人话不硬猜），再按 RFC4180 解析成行列，行/列各自封顶。
 *   - 旧版 `.doc` / `.xls` / `.ppt`（OLE 复合文档）：经**随包 LibreOffice** 转成现代格式
 *     （`src/mastra/tools/office-legacy.ts`）再走上面同一套抽取；**原件一个字节都不动**（转换在临时目录），
 *     转不出来/没装转换器就给人话（不假装读到了），加密件也不会被当成正常文件读。
 *   - 图片（`.png/.jpg/.jpeg/.webp/.gif`）：**不抽文字**，把**原始字节**作为图片交给模型**看** ——
 *     `toModelOutput` 回 `{type:'file', mediaType, data:{type:'data', data:<base64>}}`，这条形状是
 *     render_ppt 的页图那条**已实测**的路（见 tools/render-ppt.ts 头注），不另造一套。
 *   - 认得出的二进制（OOXML 容器、BMP、改名了的图片…）：一句人话说明它**是什么**、下一步能怎么办，
 *     **不返回乱码**（旧行为是解成一堆 U+FFFD 与 NUL）。
 *
 * 判据是**扩展名 + 文件头两道闸**（与工作台那条读路同一套口径，`sniffFormat` 也是同一份实现）：
 * 头与扩展名对不上就不猜、不画，也不硬塞给模型端点（`.png` 里其实是文本 → 说清它其实是什么）。
 * 办公档在解 zip **之前**先过一遍 `assertOfficeArchiveSafe`（**真解出来逐条核**的有界预检：
 * 声明 → 解压上限 → 实际长度 → CRC32 → 累计）——"zip 炸弹"那两类形状（声明就超 / 声明撒谎）都拦在
 * 解析器之前，不改成"只看声明"的廉价检查。
 *
 * 上限一律"如实说 + 给下一步"，绝不返回空串让人以为文件是空的：
 *   - 文本：256KB 截断；PDF：原文件 ≤64MB（`READ_PDF_MAX_BYTES`）；办公档（docx/xlsx/pptx/csv
 *     与旧三格式）：≤32MB（`READ_OFFICE_MAX_BYTES`，与工作台预览同一个数）；
 *     抽取出来的正文 ≤64000 字符（`READ_DOCUMENT_MAX_CHARS`，与附件那条路同一个数）——
 *     办公档的截断**切在行 / 页边界上**，写清"共多少、读到哪、还剩多少没读"，不切半行；
 *     **结构性上限沿用工作台预览那一组**（工作簿 20 张表 / 单表 2000 行 × 100 列 / 演示 100 页），
 *     read 不再另立一套更宽的数；
 *   - 图片：≤8MB（`READ_IMAGE_MAX_BYTES`，与"随消息发出去的图"同一个数）且 ≤16M 像素
 *     （`READ_IMAGE_MAX_PIXELS`），超了**不发给模型**并把真实尺寸/下一步说清。
 *   - 扫描版 PDF（没有文字层）：如实说抽不到文字层，并给出下一步（本部署没有"PDF → 图片"的通路，
 *     可以让用户把那几页截图或导出成图片，图片 read 能直接看）。
 *
 * **出站面（round 75 起不审）**：文本 / PDF / Word / 表格 / 演示全在本机抽取；只有**图片**这一支会把
 * 原始字节发给模型端点（走 provider 的视觉通道）。用户口径："读图这种就不该审" —— 所以图片档与
 * 文本 / PDF / Word **同一档免审**，不再单独弹卡（在这之前它按"外发档"判过一次）。三件事照旧：
 *   ① **边界不变**：目标仍必须落在授权工作区内（执行层过引擎，越界 fail closed）；旧版 Office 的
 *      转换读的是**同一个授权目标**（审批与边界都按原路径算，不为转换另开一道口子）；
 *   ② **能力门**：当前模型读不了图（`visionOf` 那套判定，见 skills/runtime 的本部署事实）就
 *      **一个字节都不发**，回一句人话让模型/用户去换模型（见 readImage 的第一个分支）。
 *
 * 读过的路径按会话记进 ToolState（抽取档与图片档也记）：edit 的"未读先改"靠这份记录。
 * **`toModelOutput` 只认图片档那一个形状**（`readImageResultSchema.safeParse`）：校验不过的
 * （字符串档，或哪儿冒出来的错误对象）一律不做映射 —— 以前是"只要不是字符串就当图片"，
 * 会把错误对象当成图片档去读盘、附字节。
 */
import { StringDecoder } from 'node:string_decoder'
import { basename, extname } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import {
  IMAGE_MAX_BYTES,
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  PDF_TEXT_MAX_CHARS
} from '../../shared/attachments'
import { PREVIEW_OFFICE_MAX_BYTES } from '../../shared/workbench'
import { extractPdfText } from '../../main/pdf'
import { decodeTextBytes, describeEncoding } from '../../main/text-encoding'
import { sniffFormat } from '../../main/workbench-files'
import {
  extractDocx,
  extractPptxForRead,
  extractXlsxForRead,
  readTableForRead,
  type ReadBlocks
} from '../../main/workbench-office'
import { currentSkillRuntimeFacts } from '../skills/runtime'
import { assertOfficeArchiveSafe } from './artifact-check'
import { convertLegacyOffice, type LegacyOfficeKind } from './office-legacy'
import {
  approvalSessionOf,
  needsApproval,
  relativeInside,
  sessionKey,
  statOrNull,
  toolTarget,
  type ToolContext
} from './guard'
import { resolveTrustedRead } from './skill-read'

/** read 的文本输出上限：超过就截断（spec §5.1"输出截断限额"） */
export const READ_MAX_BYTES = 256 * 1024

/**
 * 抽取档（PDF / Word / Excel / PPT / 表格）出来的正文上限（字符）：**故意**取成与附件那条路同一个数
 * （shared/attachments 的 PDF_TEXT_MAX_CHARS）—— 同一份文档，当附件发来和用 read 读，
 * 给模型的长度应当一样。办公档的截断切在行/页边界上，并由抽取器写清"读到哪"。
 */
export const READ_DOCUMENT_MAX_CHARS = PDF_TEXT_MAX_CHARS

/** PDF 原文件上限：与附件那条路同一个数（整份进内存抽取，是内存护栏不是业务口径） */
export const READ_PDF_MAX_BYTES = PDF_MAX_BYTES

/**
 * 办公档（docx/xlsx/pptx/csv 与旧版 .doc/.xls/.ppt）的**原文件**上限：与工作台预览同一个数。
 * 这些格式都要整份进内存解包/解析（mammoth / exceljs / zip 解析 / LibreOffice 转换），
 * 是内存护栏不是业务口径；超了给人话，不做"截一半去解析"。
 */
export const READ_OFFICE_MAX_BYTES = PREVIEW_OFFICE_MAX_BYTES

/** Word 原文件上限：与办公档同一个数（mammoth 要整份解包） */
export const READ_DOCX_MAX_BYTES = READ_OFFICE_MAX_BYTES

/** 旧版 Office 转换器的产物：现代格式的字节 + 是哪一种 */
export interface LegacyConversion {
  bytes: Buffer
  format: 'docx' | 'xlsx' | 'pptx'
}

/**
 * 旧版 Office 的转换入口形状（真实实现见 `./office-legacy`：随包 LibreOffice，在临时目录里转，
 * 失败抛中文人话）。这里把形状写下来是给**测试注入**用的：单测不装那份 194MB 的随包引擎，
 * 注入一个假转换器就能把"旧格式 → 转换 → 复用现代抽取"这条链覆盖到；生产只有真实实现这一条路。
 */
export type LegacyConverter = (
  abs: string,
  kind: LegacyOfficeKind,
  signal?: AbortSignal
) => Promise<LegacyConversion>

/**
 * 单张图片的字节上限：与"随消息真发出去的图"同一个数（IMAGE_MAX_BYTES）—— 两者都是
 * "要进模型请求体的那张"，别再加一个数出来。
 */
export const READ_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES

/**
 * 单张图片的像素上限（**灾难护栏，不是成本政策**）：16M 像素 ≈ 1 万 token 量级
 * （换算按实测口径 ~1600 像素/token，见 render-ppt.ts 的 1600×900 ≈ 882 token）。
 * 取这个数是为了**不误伤常见输入**：4K 截图（3840×2160 ≈ 8.3M）、手机照片（4032×3024 ≈ 12.2M）
 * 都过得去；拦的是超大扫描件/拼图那种"一张就把上下文吃掉一大块"的东西。
 * 本部署没有本机缩放能力（那要引入图像库或让主进程注入 Electron 的 nativeImage，见报告），
 * 所以超限只能**拒并说清**，不做"悄悄缩采样"。
 */
export const READ_IMAGE_MAX_PIXELS = 16_000_000

/** 像素 → token 的**实测**换算（render_ppt 的 1600×900 页图约 880 token）；只用来在回执里报量级 */
export const IMAGE_PIXELS_PER_TOKEN = 1600

export const readInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'File path; relative paths resolve against the workspace root, or against the skill directory when skill is set'
    ),
  skill: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Read-only: the skill directory ID printed by use_skill (not the skill name). When set, path is a relative path inside that skill directory (hidden paths and node_modules are not readable). Never grants write access; omit it for ordinary workspace files.'
    ),
  offset: z.number().int().min(1).optional().describe('First line to return, 1-based'),
  limit: z.number().int().min(1).optional().describe('Maximum number of lines to return')
})

export type ReadInput = z.infer<typeof readInputSchema>

/**
 * 图片档的输出（与文本档构成两态联合）：**图片字节不进这个对象**（界面上的工具卡会把 output
 * 序列化后截 600 字，塞 base64 进去会把卡片撑爆，与 render_ppt 同一个理由）——这里只放回执与
 * 图片的元信息，`toModelOutput` 再读一次盘，把字节按已验证的形状附给模型。普通工作区文件用
 * `abs`；技能资源（带 `skill`）用 `skill + path` **重新过只读信任根**再读（见 skill-read.ts）。
 */
export const readImageResultSchema = z.object({
  /** 一句话回执（模型看到的正文；界面上的工具卡也显示它） */
  message: z.string(),
  /** 相对路径（普通文件 = 工作区相对；技能资源 = 技能目录相对；正斜杠） */
  path: z.string(),
  /** 绝对路径（普通文件的 toModelOutput 读盘用；技能图片不信任它，见 `skill`） */
  abs: z.string(),
  /** 交给模型时声明的 MIME */
  mediaType: z.string(),
  /** 文件字节数 */
  bytes: z.number(),
  /**
   * 技能资源图片的目录 ID（011）：`toModelOutput` **不信任 `abs`**，拿 `skill + path` 重新过
   * `resolveTrustedRead` 才读第二次盘（见那里的注释）。普通工作区文件没有这个字段。
   */
  skill: z.string().optional(),
  /** 像素宽高；**读不出就不给**（认不出的文件头不猜，也不拦） */
  width: z.number().optional(),
  height: z.number().optional()
})

export type ReadImageResult = z.infer<typeof readImageResultSchema>

/**
 * 工具输出两态联合（字符串 = 文本 / 抽取档的回执与正文；对象 = 图片档）。
 * 与 deliver_file 同一个写法：字符串原样显示、对象显示成 JSON，所以**只有当字段真有用时才回对象**。
 */
export const readResultSchema = z.union([readImageResultSchema, z.string()])

export type ReadResult = z.infer<typeof readResultSchema>

/** 图片档交给模型的内容形状（与 render_ppt 的页图一致：文字回执 + 原始字节） */
interface ImageModelOutput {
  type: 'content'
  value: Array<
    | { type: 'text'; text: string }
    | { type: 'file'; mediaType: string; data: { type: 'data'; data: string } }
  >
}

/** 认路的图片扩展名 → MIME（与 composer / 附件的 `IMAGE_MEDIA_TYPES` 同一套） */
const IMAGE_MEDIA_TYPE: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** 文件头（`sniffFormat` 的结论）→ MIME：能进模型请求体的那几种 */
const SNIFF_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'image-png': 'image/png',
  'image-jpeg': 'image/jpeg',
  'image-gif': 'image/gif',
  'image-webp': 'image/webp'
}

/** 二进制档在人话里怎么称呼（键 = `sniffFormat` 的结论，外加 OLE） */
const BINARY_NAME: Readonly<Record<string, string>> = {
  pdf: 'PDF',
  ooxml: 'OOXML 容器（.docx / .xlsx / .pptx / .zip 这类）',
  'image-png': 'PNG 图片',
  'image-jpeg': 'JPEG 图片',
  'image-gif': 'GIF 图片',
  'image-webp': 'WebP 图片',
  'image-bmp': 'BMP 图片',
  ole: '旧版 Office 二进制（.doc / .xls / .ppt）'
}

/**
 * 旧版 Office 的 OLE 复合文档头：`sniffFormat` 不认它（它的判据只覆盖工作台预览认得的那几档），
 * 而 `.doc` 恰恰是用户最常丢过来的东西之一 —— 少了这一条，它会被当文本解成乱码。
 * 现代 OOXML **加密**之后也会被包成 OLE 复合文档（`EncryptedPackage` 流），所以同一个头
 * 在两处用：旧三格式认原件、现代格式认"这份是加密的"。
 */
const OLE_HEAD = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** 认得出 OLE 头（.doc / .xls / .ppt / 加密的 OOXML） */
function isOle(bytes: Buffer): boolean {
  return bytes.length >= OLE_HEAD.length && bytes.subarray(0, OLE_HEAD.length).equals(OLE_HEAD)
}

/**
 * BMP 的魔数只有两个字节（`BM`），撞文本太容易了（`BMW 车型对比.txt` 这种真文本一开头就是它）。
 * 工作台那条路是"扩展名 + 魔数"两道闸，不担心；read 的文本档只有魔数这一道，所以再看一眼
 * 文件头里的 4 个保留字节（BMP 规定全 0）—— 真 BMP 照样认得出，真文本不会被误判成二进制。
 */
function looksLikeBmp(bytes: Buffer): boolean {
  return bytes.length >= 10 && bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0
}

/**
 * 文本档里"这份其实是二进制/老格式"的判据（返回 `BINARY_NAME` 的键，null = 按文本读）。
 * OLE 是这里补的（`sniffFormat` 不覆盖旧版 Office），BM 是收口的（见 looksLikeBmp）。
 */
function binaryKindOf(bytes: Buffer): string | null {
  const sniffed = sniffFormat(bytes)
  if (sniffed === 'image-bmp') return looksLikeBmp(bytes) ? sniffed : null
  if (sniffed !== null) return sniffed
  return isOle(bytes) ? 'ole' : null
}

/**
 * read 支持的现代 OOXML —— **只有三件本体**（`.docx` / `.xlsx` / `.pptx`）。
 * 模板/放映/启用宏的变体（`.dotx` / `.ppsx` / `.xlsm` …）不在本轮格式表里，一律不读（见下表）。
 */
const OOXML_EXTENSION: Readonly<Record<string, { base: OfficeBase; label: string }>> = {
  '.docx': { base: 'docx', label: 'Word 文档' },
  '.xlsx': { base: 'xlsx', label: 'Excel 工作簿' },
  '.pptx': { base: 'pptx', label: 'PowerPoint 演示文稿' }
}

/** read 读得了的现代 OOXML 三种 */
type OfficeBase = 'docx' | 'xlsx' | 'pptx'

/**
 * **明确不读**的 Office 家族扩展名 → 人话（是什么 / 为什么不读 / 下一步）。
 * 两类都走这里，理由不同：
 *   - **启用宏的版本**（`.docm` / `.xlsm` / `.pptm`…）：本部署不支持宏，读出来只有数据、宏代码拿不到 ——
 *     与其"读一半装作读全了"，不如**明确拒绝**并让用户另存为不含宏的版本；
 *   - **模板 / 放映 / 二进制变体**（`.dotx` / `.ppsx` / `.xlsb`…）：不在本轮支持的 8 格式里，
 *     **不宣称支持**，给一句能照做的下一步。
 */
const UNSUPPORTED_OFFICE_EXTENSION: Readonly<
  Record<string, { what: string; why: string; next: string }>
> = {
  '.docm': {
    what: '启用宏的 Word 文档（.docm）',
    why: '宏不在这份读取范围里（read 不读宏代码）',
    next: '让用户在 Word 里另存为 .docx（不含宏）再读'
  },
  '.dotm': {
    what: '启用宏的 Word 模板（.dotm）',
    why: '宏与模板都不在这份读取范围里',
    next: '让用户另存为 .docx 再读'
  },
  '.dotx': {
    what: 'Word 模板（.dotx）',
    why: 'read 只读 .docx 本体，模板变体不在支持的格式里',
    next: '让用户另存为 .docx 再读'
  },
  '.xlsm': {
    what: '启用宏的 Excel 工作簿（.xlsm）',
    why: '宏不在这份读取范围里（read 不读宏代码）',
    next: '让用户在 Excel 里另存为 .xlsx（不含宏）再读'
  },
  '.xltm': {
    what: '启用宏的 Excel 模板（.xltm）',
    why: '宏与模板都不在这份读取范围里',
    next: '让用户另存为 .xlsx 再读'
  },
  '.xltx': {
    what: 'Excel 模板（.xltx）',
    why: 'read 只读 .xlsx 本体，模板变体不在支持的格式里',
    next: '让用户另存为 .xlsx 再读'
  },
  '.xlsb': {
    what: '二进制工作簿（.xlsb）',
    why: '它是二进制格式（不是 OOXML zip），read 没有解析它的能力',
    next: '让用户在 Excel 里另存为 .xlsx 再读'
  },
  '.pptm': {
    what: '启用宏的 PowerPoint 演示文稿（.pptm）',
    why: '宏不在这份读取范围里（read 不读宏代码）',
    next: '让用户在 PowerPoint 里另存为 .pptx（不含宏）再读'
  },
  '.ppsm': {
    what: '启用宏的 PowerPoint 放映（.ppsm）',
    why: '宏与放映变体都不在这份读取范围里',
    next: '让用户另存为 .pptx 再读'
  },
  '.potm': {
    what: '启用宏的 PowerPoint 模板（.potm）',
    why: '宏与模板都不在这份读取范围里',
    next: '让用户另存为 .pptx 再读'
  },
  '.ppsx': {
    what: 'PowerPoint 放映（.ppsx）',
    why: 'read 只读 .pptx 本体，放映变体不在支持的格式里',
    next: '让用户另存为 .pptx 再读'
  },
  '.potx': {
    what: 'PowerPoint 模板（.potx）',
    why: 'read 只读 .pptx 本体，模板变体不在支持的格式里',
    next: '让用户另存为 .pptx 再读'
  }
}

/** 旧版 Office 三件（OLE 复合文档）：经随包 LibreOffice（`./office-legacy`）转换后走现代抽取。
 *  转换器要的 kind 直接用它的类型，别在两边各写一份（对不上就是编译期的事，不是运行时的事）。 */
const LEGACY_EXTENSION: Readonly<Record<string, LegacyOfficeKind>> = {
  '.doc': 'doc',
  '.xls': 'xls',
  '.ppt': 'ppt'
}

/** read 的扩展名分派（大小写不敏感） */
type ReadKind =
  | { kind: 'text' }
  | { kind: 'image' }
  | { kind: 'pdf' }
  | { kind: 'csv' }
  | { kind: 'office'; base: OfficeBase; label: string }
  | { kind: 'legacy'; legacy: LegacyOfficeKind }
  | { kind: 'unsupported'; what: string; why: string; next: string }

/** 按扩展名分派（大小写不敏感）；认不出就是**文本档**（与改动前逐字一致，不改变原有行为） */
function kindOf(target: string): ReadKind {
  const ext = extname(target).toLowerCase()
  if (ext === '.pdf') return { kind: 'pdf' }
  const ooxml = OOXML_EXTENSION[ext]
  if (ooxml !== undefined) return { kind: 'office', base: ooxml.base, label: ooxml.label }
  if (ext === '.csv') return { kind: 'csv' }
  const legacy = LEGACY_EXTENSION[ext]
  if (legacy !== undefined) return { kind: 'legacy', legacy }
  const unsupported = UNSUPPORTED_OFFICE_EXTENSION[ext]
  if (unsupported !== undefined) return { kind: 'unsupported', ...unsupported }
  return IMAGE_MEDIA_TYPE[ext] === undefined ? { kind: 'text' } : { kind: 'image' }
}

/**
 * read 的审批：**一律不问**（classify 的 read 档）。
 *
 * round 75：**读图片不再单独弹卡**（用户口径："读图这种就不该审"）。在这之前图片这一支按"外发档"
 * 单独判过一次审批（把字节发给模型端点 = 把文件带出本机，所以当时要问一次）—— 用户裁定不审：
 * 读一张图与读一个文本在"用户想不想让模型看"这件事上没有区别，而且弹卡的位置（工具执行前）
 * 也说不出"这次会发多少、发给谁"。**边界照旧**：普通文件必须落在授权工作区内（执行层的
 * `toolTarget` → 引擎，区外一律 fail closed）；技能配套资源走 011 的只读信任根
 * （`skill-read.ts`：已注册技能目录 + realpath containment），同样 fail closed，且**不扩大**任何
 * 写权限 —— write/edit/delete/move 仍只认工作区。
 *
 * 图片字节发给模型端点这件事本身**不做审批**，但做**能力门**：当前模型读不了图就不发（见
 * `readImage` 的 vision 判断）。
 */
export function readNeedsApproval(ctx: ToolContext, input: ReadInput, session?: string): boolean {
  return needsApproval(ctx, 'read', input, session)
}

/** 字节数 → 人话（回执里报的都是**真实值**，不四舍五入成整数） */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes} 字节`
}

/** 像素 → 人话（如 `17.5M 像素`） */
function formatPixels(pixels: number): string {
  return pixels >= 1_000_000 ? `${(pixels / 1_000_000).toFixed(1)}M 像素` : `${pixels} 像素`
}

/** 一张图大约多少 token（量级；按实测换算，让模型对成本有感觉。小图至少报 1） */
function estimatedTokens(width: number, height: number): number {
  return Math.max(1, Math.round((width * height) / IMAGE_PIXELS_PER_TOKEN))
}

interface ImageSize {
  width: number
  height: number
}

/** PNG：8 字节签名之后就是 IHDR（宽高各 4 字节大端） */
function pngSize(bytes: Buffer): ImageSize | null {
  return bytes.length >= 24
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : null
}

/** GIF：逻辑屏幕描述符里宽度与高度各 2 字节小端 */
function gifSize(bytes: Buffer): ImageSize | null {
  return bytes.length >= 10 ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) } : null
}

/**
 * JPEG：尺寸在 SOFn 段里（FFC0–FFCF 里除 C4/C8/CC 都是 SOF），逐段按段长跳过前面那些
 * APPn / DQT / DHT 段；遇到 SOS（扫描数据）还没见到 SOF 就认不出（返回 null，不猜）。
 */
function jpegSize(bytes: Buffer): ImageSize | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    // 无载荷的标记（SOI / TEM / RSTn）：直接跳到下一个标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2) return null
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    // SOF 段：FF Cn / Lf(2) / 精度(1) / 高(2) / 宽(2)
    if (isSof)
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    if (marker === 0xda) return null
    offset += 2 + length
  }
  return null
}

/**
 * WebP：三种块头各自的尺寸位置（实测三种都过：有损 VP8 / 无损 VP8L / 扩展 VP8X）。
 * 认不出（长度不够、起始码不对）就返回 null —— 上层按"尺寸未知"放行，不拿判据卡住合法文件。
 */
function webpSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 30) return null
  const format = bytes.toString('latin1', 12, 16)
  if (format === 'VP8X') {
    // 画布尺寸：24 位小端，存的是"减一"
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
    }
  }
  if (format === 'VP8 ') {
    // 帧头之后是 3 字节起始码 9d 01 2a，再是 14 位宽 + 14 位高
    if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)) return null
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (format === 'VP8L') {
    // 签名 0x2f 之后：14 位宽-1 + 14 位高-1（小端位序）
    if (bytes[20] !== 0x2f) return null
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

function imageSizeOf(bytes: Buffer, sniffed: string): ImageSize | null {
  switch (sniffed) {
    case 'image-png':
      return pngSize(bytes)
    case 'image-jpeg':
      return jpegSize(bytes)
    case 'image-gif':
      return gifSize(bytes)
    case 'image-webp':
      return webpSize(bytes)
    default:
      return null
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

interface WindowOptions {
  /** 上游已经截断过（>256KB / 抽取上限）：窗口备注里就不再说"共 N 行"（那个行数是**截过的**） */
  truncated?: boolean
  /** 前置备注（如"[已截断：…]"），排在窗口备注前面 */
  notes?: readonly string[]
  /** 回执里对这份东西的称呼（'文件' / '抽取到的正文'）：备注与报错都按它说 */
  source?: string
}

/**
 * 按行窗口切一段并附说明（文本档与抽取档共用）。**越界的 offset 明确报错**，不给静默空内容；
 * 抽取档的行数是**抽取结果**的行数（`source` 会把这件事说清）。
 */
function windowText(
  text: string,
  target: string,
  input: ReadInput,
  options: WindowOptions = {}
): string {
  const source = options.source ?? '文件'
  const lines = text.split('\n')
  const offset = input.offset ?? 1
  if (offset > lines.length) {
    throw new Error(`offset=${offset} 超出${source}行数：${target} 共 ${lines.length} 行`)
  }
  const from = offset - 1
  const to = input.limit === undefined ? lines.length : Math.min(lines.length, from + input.limit)
  const body = lines.slice(from, to).join('\n')

  const notes = [...(options.notes ?? [])]
  if (offset > 1 || to < lines.length) {
    const total = options.truncated === true ? '' : `，${source}共 ${lines.length} 行`
    notes.push(`[只显示第 ${from + 1}-${to} 行${total}]`)
  }
  return notes.length === 0 ? body : `${body}\n\n${notes.join('\n')}`
}

/**
 * 认得出的二进制（扩展名对不上、或者本部署读不了的容器）：一句人话说明它**是什么** + 下一步，
 * 不返回乱码。（旧行为是把它按 UTF-8 解出来 —— 模型会以为文件坏了，或者内容是空的。）
 */
function binaryMessage(target: string, kind: string): string {
  const what = BINARY_NAME[kind] ?? kind
  const next: Record<string, string> = {
    ooxml:
      '这是一份 OOXML 容器（zip）但扩展名对不上：它多半就是 .docx / .xlsx / .pptx 里的某一种 —— ' +
      '改对扩展名再读（这三种 read 都能读）；真是 .zip 的话，让用户解开后读里面的文件。',
    pdf: '这其实是 PDF 内容：改成 .pdf 扩展名再读，我就能抽它的文字层。',
    'image-png': '这是图片但扩展名对不上：改对扩展名（或另存一份）再读，图片我能直接看。',
    'image-jpeg': '这是图片但扩展名对不上：改对扩展名（或另存一份）再读，图片我能直接看。',
    'image-gif': '这是图片但扩展名对不上：改对扩展名（或另存一份）再读，图片我能直接看。',
    'image-webp': '这是图片但扩展名对不上：改对扩展名（或另存一份）再读，图片我能直接看。',
    'image-bmp':
      'BMP 我看不了：让用户另存成 PNG / JPEG（或别的常见图片格式）再读 —— 那几种我能直接看。',
    ole:
      '这是旧版 Office 二进制（.doc / .xls / .ppt）：把扩展名改对再读，read 会用随包的 ' +
      'LibreOffice 把它转成现代格式后抽取（原件不会被改动）。'
  }
  return (
    `read 没读这个文件：${target} 是二进制（文件头是 ${what}），按文本解出来只会是乱码。\n` +
    `下一步：${next[kind] ?? '确认它真实是什么格式，或换一条能处理它的路。'}`
  )
}

/** 纯文本档：原样读（含"认得出的二进制就说人话"这一道） */
async function readPlainText(
  ctx: ToolContext,
  abs: string,
  target: string,
  size: number,
  input: ReadInput
): Promise<string> {
  const clipped = size > READ_MAX_BYTES
  const bytes = await ctx.fs.readFile(abs, clipped ? READ_MAX_BYTES : undefined)

  const binaryKind = binaryKindOf(bytes)
  if (binaryKind !== null) {
    return binaryMessage(target, binaryKind)
  }

  const text = new StringDecoder('utf8').write(bytes)
  const notes = clipped ? [`[已截断：文件共 ${size} 字节，只显示前 ${READ_MAX_BYTES} 字节]`] : []
  return windowText(text, target, input, { notes, truncated: clipped })
}

/** PDF 档：文字层抽取（与附件那条路同一份实现）；没有文字层/打不开都给人话 + 下一步 */
async function readPdf(
  ctx: ToolContext,
  abs: string,
  target: string,
  size: number,
  input: ReadInput
): Promise<string> {
  if (size > READ_PDF_MAX_BYTES) {
    return (
      `read 没读这份 PDF：${target} 有 ${formatSize(size)}，超过单份 ${formatSize(READ_PDF_MAX_BYTES)} 的上限。\n` +
      '下一步：用 bash 在本机处理它（比如只取需要的几页），或先压缩再读。'
    )
  }

  const result = await extractPdfText(await ctx.fs.readFile(abs))
  if (!result.ok) {
    const scanned = result.message.includes('没有文字层')
    return [
      scanned
        ? `read 抽不出这份 PDF 的文字：${result.message}。`
        : `read 打不开这份 PDF：${result.message}。`,
      '下一步：本部署没有"PDF → 图片"的通路（render_ppt 只吃 .pptx），所以这份 PDF 的内容我看不到。',
      scanned
        ? '可以请用户把要问的那几页**截图或导出成图片**（PNG / JPEG），再 read 那张图 —— 图片我能直接看。'
        : '可以请用户确认文件是否完整（加密的先解密、损坏的重新导出），或把要问的那几页截图成图片再 read。'
    ].join('\n')
  }

  const notes = [`[这是 PDF 的文字层，共 ${result.pages} 页]`]
  if (result.truncated) {
    notes.push(
      `[抽取有上限（页数 ${PDF_MAX_PAGES} / 总量 ${READ_DOCUMENT_MAX_CHARS} 字符），后面的内容不在这里]`
    )
  }
  return windowText(result.text, target, input, {
    notes,
    truncated: result.truncated,
    source: '抽取到的正文'
  })
}

/**
 * 办公档的公共闸门：体积 → 文件头（OOXML / OOXML 加密后的 OLE / 对不上）→ **有界预检**。
 * 三道都过了才轮到抽取器；哪道不过都返回**人话**（不抛、不返回乱码）。
 */
type OfficeOpen = { ok: true; bytes: Buffer } | { ok: false; message: string }

/** 办公档体积超限（四类共用一句话） */
function officeTooLarge(target: string, size: number, what: string): string {
  return (
    `read 没读${what}：${target} 有 ${formatSize(size)}，超过单份 ${formatSize(READ_OFFICE_MAX_BYTES)} 的上限。\n` +
    '下一步：用 bash 在本机处理它（比如只取要用的部分），或让用户另存一份小一点的再读。'
  )
}
/**
 * 解 zip **之前**的有界预检（`assertOfficeArchiveSafe`）：条目数/解压总量这类"zip 炸弹"形状先拦掉，
 * 不等 inflate 的时候才发现。预检不通过**不抛**，翻成人话给模型。
 */
function precheckOfficeArchive(bytes: Buffer, target: string): string | null {
  try {
    assertOfficeArchiveSafe(bytes)
    return null
  } catch (cause) {
    return (
      `read 没读这个文件：${target} 的压缩包结构没通过安全预检（${messageOf(cause)}）。\n` +
      '下一步：确认它是从可信来源导出的完整文件；可疑或损坏的，请让用户重新导出、另存一份再读。'
    )
  }
}

/** 现代 OOXML（docx/xlsx/pptx 及其变体）的两道闸 + 预检；过了才把字节交给抽取器 */
async function openOoxml(
  ctx: ToolContext,
  abs: string,
  target: string,
  size: number,
  what: string
): Promise<OfficeOpen> {
  if (size > READ_OFFICE_MAX_BYTES) {
    return { ok: false, message: officeTooLarge(target, size, `这份 ${what}`) }
  }

  const bytes = await ctx.fs.readFile(abs)
  if (sniffFormat(bytes) !== 'ooxml') {
    if (isOle(bytes)) {
      return {
        ok: false,
        message:
          `read 打不开这份${what}：${target} 的内容是 OLE 复合文档，不是 OOXML（zip）—— ` +
          '加了密码的 Office 文件正是这个样子（加密后整份被包成 OLE）。\n' +
          '下一步：请用户先去密码（另存一份不加密的）再读；本部署没有解密能力，不猜密码。'
      }
    }
    return {
      ok: false,
      message:
        `read 没读这个文件：${target} 的文件头不是 OOXML（zip）—— 它多半不是${what}（改过扩展名？）。\n` +
        '下一步：确认它真实是什么格式；旧版的 .doc / .xls / .ppt 请用对应的扩展名再读（read 会经随包转换器读它们）。'
    }
  }

  const precheck = precheckOfficeArchive(bytes, target)
  if (precheck !== null) return { ok: false, message: precheck }
  return { ok: true, bytes }
}

/** 一张工作表 / 一页幻灯片在"还有 N … 没读"里的量词 */
const BLOCK_UNIT: Readonly<Record<'xlsx' | 'pptx', string>> = { xlsx: '张工作表', pptx: '页' }

/**
 * xlsx / pptx → 文本（read 专用抽取器 + 上限说明）。块内部的截断（超行/超列/超页）由抽取器
 * 写在块尾；这里只补**跨块**的账：还有几块没读、正文上限。
 */
async function readOfficeBlocks(
  base: 'xlsx' | 'pptx',
  bytes: Buffer,
  target: string,
  input: ReadInput,
  notes: readonly string[]
): Promise<string> {
  let extracted: ReadBlocks
  try {
    extracted =
      base === 'xlsx'
        ? await extractXlsxForRead(bytes, { maxChars: READ_DOCUMENT_MAX_CHARS })
        : extractPptxForRead(bytes, { maxChars: READ_DOCUMENT_MAX_CHARS })
  } catch (cause) {
    return (
      `read 读不了这份${base === 'xlsx' ? ' Excel' : ' PPT'}：${messageOf(cause)}\n` +
      '下一步：文件可能损坏、加密或被改过；请让用户在 Office 里另存一份再读。'
    )
  }

  const body = extracted.blocks.map((block) => `### ${block.title}\n${block.body}`).join('\n\n')
  if (extracted.blocks.length === 0) {
    return (
      `read 没读到内容：${target} 里${base === 'xlsx' ? '一张工作表都没有' : '一页幻灯片都没有'}。\n` +
      '下一步：确认这份文件不是空壳（新建的空白演示文稿就是这样）。'
    )
  }
  const allNotes = [...notes]
  if (extracted.note !== undefined) allNotes.push(extracted.note)
  if (extracted.unread > 0) {
    allNotes.push(
      `[还有 ${extracted.unread} ${BLOCK_UNIT[base]}没读（一次读出的内容有上限），` +
        '要看它们得分几次读或让用户精简；上面每一块都写了自己截到哪]'
    )
  }
  if (extracted.truncated && extracted.unread === 0) {
    allNotes.push(`[正文有上限（${READ_DOCUMENT_MAX_CHARS} 字符），后面的内容不在这里]`)
  }
  return windowText(body, target, input, {
    notes: allNotes,
    truncated: extracted.truncated,
    source: '抽取到的正文'
  })
}

/** Word（docx 字节）→ markdown 文本；`.docx` 档与旧 `.doc` 转换后的档共用这一段 */
async function renderDocxBytes(
  bytes: Buffer,
  target: string,
  input: ReadInput,
  notes: readonly string[]
): Promise<string> {
  let markdown: string
  let truncated: boolean
  try {
    ;({ markdown, truncated } = await extractDocx(bytes))
  } catch (cause) {
    return (
      `read 读不了这份 Word：${messageOf(cause)}\n` +
      '下一步：文件可能损坏或被改过；请用户在 Word 里另存一份 .docx 再试。'
    )
  }

  const clipped = markdown.length > READ_DOCUMENT_MAX_CHARS
  const allNotes = [...notes]
  if (truncated || clipped) {
    allNotes.push(`[正文有上限（${READ_DOCUMENT_MAX_CHARS} 字符），后面的内容不在这里]`)
  }
  return windowText(
    clipped ? markdown.slice(0, READ_DOCUMENT_MAX_CHARS) : markdown,
    target,
    input,
    { notes: allNotes, truncated: truncated || clipped, source: '抽取到的正文' }
  )
}

/** Word 档：OOXML 两道闸 + 预检 + mammoth 抽 markdown；抽不动给人话 + 下一步 */
async function readDocx(
  ctx: ToolContext,
  abs: string,
  target: string,
  size: number,
  input: ReadInput,
  label: string
): Promise<string> {
  const opened = await openOoxml(ctx, abs, target, size, label)
  if (!opened.ok) return opened.message

  const notes = ['[这是 Word 文档抽成的 markdown（内嵌图片只留"（图片已省略）"占位）]']
  return renderDocxBytes(opened.bytes, target, input, notes)
}

/** Excel 档：OOXML 两道闸 + 预检 + read 专用表格抽取（行列定位 / 公式缓存 / 稳定日期 / 不吞空格） */
async function readXlsx(
  ctx: ToolContext,
  abs: string,
  target: string,
  size: number,
  input: ReadInput,
  label: string
): Promise<string> {
  const opened = await openOoxml(ctx, abs, target, size, label)
  if (!opened.ok) return opened.message

  const notes = [
    '[这是 Excel 工作簿抽出来的表格：逐行带行列号（列从 A 起，空行不写）；公式写成 `=公式 → 结果`，' +
      '合并区域只显示左上那格]'
  ]
  return readOfficeBlocks('xlsx', opened.bytes, target, input, notes)
}

/** PPT 档：OOXML 两道闸 + 预检 + read 专用逐页抽取（真实页序 / 图片与图表说清没读） */
async function readPptx(
  ctx: ToolContext,
  abs: string,
  target: string,
  size: number,
  input: ReadInput,
  label: string
): Promise<string> {
  const opened = await openOoxml(ctx, abs, target, size, label)
  if (!opened.ok) return opened.message

  const notes = [
    '[这是 PowerPoint 抽出来的逐页文字（版式不还原；图片、图表、SmartArt 只报数量，内容没有读）]'
  ]
  return readOfficeBlocks('pptx', opened.bytes, target, input, notes)
}

/**
 * CSV 档：文件头闸 → **解码**（BOM / 严格 UTF-8 / GB18030 回退，推测的要说出来）→ RFC4180 解析。
 * 与工作台预览那条路同一套判据（不认二进制、行列封顶），但截断按 read 的口径说清"读到第几行"。
 */
async function readCsv(
  ctx: ToolContext,
  abs: string,
  target: string,
  size: number,
  input: ReadInput
): Promise<string> {
  if (size > READ_OFFICE_MAX_BYTES) return officeTooLarge(target, size, '这份表格')

  const bytes = await ctx.fs.readFile(abs)
  const binaryKind = binaryKindOf(bytes)
  if (binaryKind !== null) return binaryMessage(target, binaryKind)

  const decoded = decodeTextBytes(bytes)
  if (!decoded.ok) return `read 解不出这份表格的文本：${decoded.message}`

  const name = basename(abs).replace(/\.[^.]*$/, '')
  const table = readTableForRead(decoded.text, name, ',', READ_DOCUMENT_MAX_CHARS)
  const notes = ['[这是 CSV 抽出来的表格：每行以 `行 N:` 开头，格与格之间是 ` | `]']
  if (decoded.inferred) {
    notes.push(
      `[编码：按内容推测是 ${describeEncoding(decoded.encoding)}（不是 UTF-8）—— ` +
        '若读出来是乱码，说明猜错了，请让用户把表格另存为 UTF-8 再读]'
    )
  } else if (decoded.encoding !== 'utf-8') {
    notes.push(`[编码：${describeEncoding(decoded.encoding)}（按文件头/BOM 认出来的）]`)
  }
  const body = `### ${table.block.title}\n${table.block.body}`
  return windowText(body, target, input, {
    notes,
    truncated: table.truncated,
    source: '抽取到的正文'
  })
}

/** 旧版 Office 三件在回执里的称呼 */
const LEGACY_LABEL: Readonly<Record<LegacyOfficeKind, string>> = {
  doc: 'Word 文档（.doc）',
  xls: 'Excel 工作簿（.xls）',
  ppt: 'PowerPoint 演示文稿（.ppt）'
}

/**
 * 旧版 Office（OLE 复合文档）档：**转换后复用现代抽取**。
 *
 * 三件事必须守住：
 *   ① **原件一个字节都不动** —— 转换走 `convertLegacyOffice`（它自己用临时目录），read 只读原路径；
 *      审批与边界也仍按**原路径**算（`toolTarget` 只解析过一次），不因为要多一步转换就放开什么；
 *   ② **不假读** —— 头不是 OLE 的文件（改过扩展名/别的格式）当场说清；转换失败（没装转换器、加密、
 *      损坏）原样报出原因 + 下一步，绝不假装读到了；
 *   ③ **宏要说出来** —— 转换只带内容与数据，VBA 宏/修订痕迹这类东西不在结果里，回执里点明。
 */
async function readLegacy(
  ctx: ToolContext,
  abs: string,
  target: string,
  size: number,
  input: ReadInput,
  kind: LegacyOfficeKind,
  signal: AbortSignal | undefined,
  converter: LegacyConverter
): Promise<string> {
  const label = LEGACY_LABEL[kind]
  if (size > READ_OFFICE_MAX_BYTES) return officeTooLarge(target, size, `这份旧版 ${label}`)

  // 只看文件头（8 字节）：旧版 Office 是 OLE 复合文档，对不上就不往转换器里送
  const head = await ctx.fs.readFile(abs, OLE_HEAD.length)
  if (!isOle(head)) {
    if (sniffFormat(head) === 'ooxml') {
      return (
        `read 没读这个文件：${target} 的扩展名是 ${label}，但文件头是 OOXML（zip）—— ` +
        '它其实是新版格式（.docx / .xlsx / .pptx 之类）。\n' +
        '下一步：确认真实格式后把扩展名改对（或另存一份）再读，新版格式 read 能直接读。'
      )
    }
    // 两个"其实不是旧版 Office"的高频形状：RTF（带格式的文本）与 HTML/XML（不少系统的"导出 Office"）
    const latin = head.toString('latin1')
    if (latin.startsWith('{\\rtf')) {
      return (
        `read 没读这个文件：${target} 的扩展名是 ${label}，内容其实是 RTF（带格式的文本）。\n` +
        '下一步：把扩展名改成 .rtf 再读（按文本读得到），或让用户在 Office 里另存为 .docx。'
      )
    }
    if (latin.startsWith('<')) {
      return (
        `read 没读这个文件：${target} 的扩展名是 ${label}，内容看起来是 HTML / XML` +
        '（不少系统"导出 Excel / Word"给的就是这种）。\n' +
        '下一步：让用户另存为真正的 .xlsx / .docx（表格也可以是 CSV）再读；' +
        '把扩展名改成 .html / .xml 也能按文本读。'
      )
    }
    return (
      `read 没读这个文件：${target} 的扩展名是 ${label}，但文件头不是 OLE 复合文档 —— ` +
      '它多半不是旧版 Office 文件。\n' +
      '下一步：确认它真实是什么格式；如果它其实是新格式，把扩展名改对再读。'
    )
  }

  let converted: LegacyConversion
  try {
    converted = await converter(abs, kind, signal)
  } catch (cause) {
    // 用户点了停止：这不是"转不了"（仓库口径：AbortError 要按中止说，别读成失败）
    if (cause instanceof Error && cause.name === 'AbortError') {
      return (
        `已被用户中止：没有读完 ${target}（旧版格式的转换做到一半停了；` +
        '原件没有被改动，也没有留下任何临时产物）。'
      )
    }
    return (
      `read 转不了这份 ${label}：${messageOf(cause)}\n` +
      '下一步：让用户在 Office 里把它另存为 .docx / .xlsx / .pptx 再读；' +
      '只是想看内容的话，也可以把要看的几页截图 / 导出成图片再 read（图片我能直接看）。原件没有被改动。'
    )
  }

  const precheck = precheckOfficeArchive(converted.bytes, target)
  if (precheck !== null) return precheck

  const origin =
    `[这是旧版 ${label} 经随包 LibreOffice 转换后抽出来的内容（转换在临时目录做，原件没有被改动；` +
    '宏、修订记录这类东西不在转换结果里）]'
  const notes = [origin]
  switch (converted.format) {
    case 'docx':
      return renderDocxBytes(converted.bytes, target, input, notes)
    case 'xlsx':
      notes.push('[抽取方式与现代 .xlsx 一样：逐行带行列号，公式写成 `=公式 → 结果`]')
      return readOfficeBlocks('xlsx', converted.bytes, target, input, notes)
    case 'pptx':
      notes.push('[抽取方式与现代 .pptx 一样：逐页文字，图片与图表只报数量]')
      return readOfficeBlocks('pptx', converted.bytes, target, input, notes)
  }
}

/**
 * 图片档：两道闸（扩展名 → MIME、文件头 → MIME）都过、字节与像素都在上限内，才交给模型看。
 * 四个分支都返回**人话**（模型看不了图 / 超限 / 头对不上），一个字节都不发给模型端点。
 *
 * 第一个分支（round 75）：**当前模型读不了图就不发** —— 能力判定走 `visionOf` 那套口径
 * （探测结论 > 注册表 > 保守 false），来源是本部署事实注册表（`skills/runtime` 的
 * `currentSkillRuntimeFacts`，生产由 main 侧装配时装进去，与指令里写给模型的那一行**同一份**）。
 * 判据只在**明确 false**时收手：`null`（没探到结论 / 没配 provider / 工具单测）照旧发 ——
 * 不把"不知道"当成"不能"（与 `visionOf` 的注释同一口径）。
 */
async function readImage(
  ctx: ToolContext,
  abs: string,
  rel: string,
  target: string,
  size: number
): Promise<ReadImageResult | string> {
  if (currentSkillRuntimeFacts()?.vision === false) {
    return (
      `read 没把这张图发给模型：当前模型看不了图，所以没有把 ${target} 的字节发出去` +
      '（发过去它也读不到，只会白占上下文和一次外发）。\n' +
      '下一步：要让我看这张图，请在「设置 → 模型」里换一个支持图片的模型；' +
      '也可以请用户用文字描述图里的内容，或把图里的关键文字贴出来。'
    )
  }

  if (size > READ_IMAGE_MAX_BYTES) {
    return (
      `read 没把这张图交给模型：${target} 有 ${formatSize(size)}，超过单张图片 ` +
      `${formatSize(READ_IMAGE_MAX_BYTES)} 的上限。\n` +
      '下一步：请用户先缩小 / 压缩这张图，或换成更小的一张（只截要看的区域）再读一次；这个文件的内容我看不到。'
    )
  }

  const bytes = await ctx.fs.readFile(abs)
  const sniffed = sniffFormat(bytes)
  const expected = IMAGE_MEDIA_TYPE[extname(abs).toLowerCase()] ?? 'image/png'
  const mediaType = sniffed === null ? null : (SNIFF_MEDIA_TYPE[sniffed] ?? null)
  if (sniffed === null || mediaType === null || mediaType !== expected) {
    const actual = sniffed === null ? '认不出的东西' : (BINARY_NAME[sniffed] ?? sniffed)
    return (
      `read 没把 ${target} 交给模型：文件头不是 ${expected}（看内容像是 ${actual}）。\n` +
      '下一步：确认它真实格式；改过扩展名的先把扩展名改对（或另存一份真正的 PNG / JPEG / GIF / WebP），再读一次。'
    )
  }

  const imageSize = imageSizeOf(bytes, sniffed)
  if (imageSize !== null && imageSize.width * imageSize.height > READ_IMAGE_MAX_PIXELS) {
    return (
      `read 没把这张图交给模型：${target} 是 ${imageSize.width}×${imageSize.height}` +
      `（${formatPixels(imageSize.width * imageSize.height)}，约 ${estimatedTokens(imageSize.width, imageSize.height)} ` +
      `token）—— 超过单张图片 ${formatPixels(READ_IMAGE_MAX_PIXELS)} 像素的上限。\n` +
      '下一步：请用户先缩小这张图（或只截要看的区域、另存一份小图）再读一次；它的内容我看不到。'
    )
  }

  const dimensions = imageSize === null ? '尺寸没读出来' : `${imageSize.width}×${imageSize.height}`
  const cost =
    imageSize === null ? '' : `，约 ${estimatedTokens(imageSize.width, imageSize.height)} token`
  return {
    message:
      `这是一张图片，已经交给你看了：${target}（${dimensions}，${mediaType}，` +
      `${formatSize(size)}${cost}）。看不到这张图就说看不到，不要凭文件名或尺寸推测内容。`,
    path: rel,
    abs,
    mediaType,
    bytes: size,
    ...(imageSize === null ? {} : { width: imageSize.width, height: imageSize.height })
  }
}

/** 旧版 Office 转换器的注入点（缺省 = 随包 LibreOffice；只给单测用） */
export interface ReadToolOptions {
  legacyConverter?: LegacyConverter
}

/**
 * 按分派结果读一个文件：写成一张 switch 表（三种办公格式 × 现代/旧版 × 表格/图片/PDF 全在这里），
 * 而不是一串嵌套三元 —— 分支一多，三元就看不出谁是谁了。
 */
async function readByKind(
  ctx: ToolContext,
  kind: ReadKind,
  abs: string,
  root: string,
  input: ReadInput,
  size: number,
  signal: AbortSignal | undefined,
  converter: LegacyConverter
): Promise<ReadResult> {
  switch (kind.kind) {
    case 'image':
      return await readImage(ctx, abs, relativeInside(root, abs), input.path, size)
    case 'pdf':
      return await readPdf(ctx, abs, input.path, size, input)
    case 'csv':
      return await readCsv(ctx, abs, input.path, size, input)
    case 'office': {
      if (kind.base === 'docx') {
        return await readDocx(ctx, abs, input.path, size, input, kind.label)
      }
      if (kind.base === 'xlsx') {
        return await readXlsx(ctx, abs, input.path, size, input, kind.label)
      }
      return await readPptx(ctx, abs, input.path, size, input, kind.label)
    }
    case 'legacy':
      return await readLegacy(ctx, abs, input.path, size, input, kind.legacy, signal, converter)
    case 'unsupported':
      // 明确拒绝，不假读：说清"这是什么 / 为什么不读 / 下一步怎么做"
      return (
        `read 没读这个文件：${input.path} 是${kind.what} —— ${kind.why}。\n` +
        `下一步：${kind.next}；本部署的 read 能直接读的是 .docx / .xlsx / .pptx / .csv / .pdf 与旧版 .doc / .xls / .ppt（以及文本与图片）。`
      )
    case 'text':
      return await readPlainText(ctx, abs, input.path, size, input)
  }
}

export async function createReadTool(
  ctx: ToolContext,
  options: ReadToolOptions = {}
): Promise<Tool<ReadInput, ReadResult>> {
  const { createTool } = await import('@mastra/core/tools')
  const legacyConverter = options.legacyConverter ?? convertLegacyOffice

  return createTool({
    id: 'read',
    description:
      'Read a workspace file, or a file inside a registered skill directory when `skill` is set (read-only; ' +
      '`skill` is the directory ID use_skill printed — not the skill name — and `path` is a relative path inside it; ' +
      'hidden paths and node_modules are refused). Plain text comes back as-is (offset/limit take a line window); .pdf comes back as ' +
      'its text layer and .docx as markdown; .xlsx and .csv come back as tables whose rows carry row numbers and ' +
      'cell addresses (a formula reads as `=formula → cached result`, and a cached 0 is told apart from no cached ' +
      "result); .pptx comes back as per-page text in the deck's real order, with pictures and charts reported as " +
      'counts that were not read. Legacy .doc/.xls/.ppt are converted with the bundled LibreOffice and read the ' +
      'same way, and the original file is not modified. Macro-enabled and template variants (.docm/.xlsm/.pptm/' +
      '.dotx/.ppsx/.xlsb) are refused by name with the next step, never read halfway. .png/.jpg/.jpeg/.webp/.gif ' +
      'come back as the image itself, for you to look at. Caps state the real numbers and never come back as ' +
      'empty output: 256KB of text, 64MB PDF, 32MB per Office file, 64000 characters of extracted text (cut at ' +
      'row and page boundaries, saying what was left out), 8MB / 16M pixels per image. A scanned PDF with no ' +
      'text layer, an encrypted or corrupt file, and any other binary is named, not returned as mojibake. ' +
      'Reading an image sends its bytes to the model endpoint (no approval step) — if the current model cannot ' +
      'see images, the bytes are not sent at all and you get a note saying so.',
    inputSchema: readInputSchema,
    outputSchema: readResultSchema,
    requireApproval: (input, approval) =>
      readNeedsApproval(ctx, input, approvalSessionOf(approval)),
    execute: async (input, context): Promise<ReadResult> => {
      const session = sessionKey(context)
      // 011：带 skill 走「已注册技能目录」只读通道（skill 只是索引，路径永远由注册表 + 受校验的
      // 相对路径拼出）；不带 skill 时逐字保持原行为（普通工作区文件）。
      const target =
        input.skill === undefined
          ? (() => {
              const resolved = toolTarget(ctx, input.path, session)
              return { abs: resolved.abs, base: resolved.root, skill: undefined }
            })()
          : (() => {
              const resolved = resolveTrustedRead(ctx, input.skill, input.path)
              return { abs: resolved.abs, base: resolved.root, skill: resolved.entry.id }
            })()
      const { abs, base, skill } = target

      const fileStat = await statOrNull(ctx, abs)
      if (fileStat === null || !fileStat.isFile()) {
        throw new Error(`read 失败：${input.path} 不存在或不是文件（目录请用 glob 列出）`)
      }

      const result = await readByKind(
        ctx,
        kindOf(abs),
        abs,
        base,
        input,
        fileStat.size,
        context.abortSignal,
        legacyConverter
      )

      // 读过的路径记进当前会话（edit 的"未读先改"靠它）：抽取档与图片档也记 —— 模型确实"看过"
      // 这份文件的内容（只是经过了抽取 / 视觉）。真去 edit 一个二进制会因 oldText 匹配不上而失败，
      // 不会静默改坏文件。技能资源只记 abs，**不**因此获得写权限（edit 仍只认 toolTarget / 授权工作区）。
      ctx.state.markRead(session, abs)

      // 图片档把技能目录 ID 带进输出：toModelOutput 二次读盘时重新校验，不信任这里给的 abs
      return skill === undefined || typeof result === 'string' ? result : { ...result, skill }
    },
    /**
     * 图片档把**原生字节**交给模型看；文本 / 抽取档返回 null（= 不做映射，原样是文本，
     * 与改动前的行为逐字一致 —— 见 mastra 侧 normalizeModelOutput 那句"nullish mapping result
     * means no special mapping needed"）。
     *
     * 形状（`{type:'file', mediaType, data:{type:'data', data:<base64>}}`）与 render_ppt 的页图**完全
     * 一致**：`image-url` 是废弃形状、`{type:'url', url:'data:…'}` 在真 DeepSeek 端点上会被
     * 8192 字符的 URL 长度校验拒掉（实测，见 tools/render-ppt.ts 头注）；`data` 里放 base64 字符串
     * 而不是 Uint8Array，是因为这份 modelOutput 会被存进 providerMetadata（过 JSON）。
     *
     * **先过形状校验**：只有真正的图片档（`readImageResultSchema`）才去读盘、附字节。以前是
     * "不是字符串就当图片档"，于是一个**错误对象**也会被当成图片档 —— 拿它没有的 `abs` 去读盘、
     * 或者把错误对象里的字段当成路径。校验不过一律返回 null（= 不做映射，按文本原样走）。
     *
     * **技能资源图片的二次读盘重新校验**（011）：输出里带 `skill` 时，不直接用 `abs` —— 拿
     * `skill + path` 再过一遍 `resolveTrustedRead`（有效技能现读 + realpath containment），读的是
     * 重新解析出来的目标；**字节上限 / 类型 / 像素 / vision 能力**也按当前文件重新检查（execute 之后
     * 文件可能被替换）。先 `stat` 再用有界 `readFile(abs, READ_IMAGE_MAX_BYTES)`，不会先整份读进内存。
     * 技能被卸载 / 文件变成链接外逃 / 读盘后换成大文件或非图片时只退化成人话，绝不按未校验的
     * `abs` 或旧 MIME 把新字节发出去。
     *
     * **普通工作区图片保持既有行为**：仍按 `abs` 读一次盘、不在这里重做工作区/技能边界（execute
     * 时已过引擎与三道上限）；这一支不做无关重构。
     *
     * 读不到就退化成人话（不把整次调用判失败）：文件可能在 execute 之后被删/改名了。
     */
    toModelOutput: async (result: ReadResult) => {
      const image = readImageResultSchema.safeParse(result)
      if (!image.success) return null

      const textOnly = (why: string): ImageModelOutput => ({
        type: 'content',
        value: [
          {
            type: 'text',
            text: `${image.data.message}\n（${why}，这次我没看到图）`
          }
        ]
      })
      const fileContent = (mediaType: string, bytes: Buffer): ImageModelOutput => ({
        type: 'content',
        value: [
          { type: 'text', text: image.data.message },
          {
            type: 'file',
            mediaType,
            data: { type: 'data', data: Buffer.from(bytes).toString('base64') }
          }
        ]
      })

      const skill = image.data.skill
      if (skill === undefined) {
        // 普通工作区图片：既有行为逐字保留（只在读不到时退化成人话）
        try {
          return fileContent(image.data.mediaType, await ctx.fs.readFile(image.data.abs))
        } catch {
          return textOnly('这张图在读取之后取不到了：文件可能刚被删除或改名')
        }
      }

      try {
        const target = resolveTrustedRead(ctx, skill, image.data.path)
        if (currentSkillRuntimeFacts()?.vision === false) {
          return textOnly('当前模型看不了图，所以没有把技能图片的字节发出去')
        }

        const stat = await statOrNull(ctx, target.abs)
        if (stat === null || !stat.isFile()) {
          return textOnly('这张图在读取之后取不到了：文件可能刚被删除或改名')
        }
        if (stat.size > READ_IMAGE_MAX_BYTES) {
          return textOnly(
            `这张图在读取之后变成了 ${formatSize(stat.size)}，超过单张图片 ` +
              `${formatSize(READ_IMAGE_MAX_BYTES)} 的上限`
          )
        }

        const bytes = await ctx.fs.readFile(target.abs, READ_IMAGE_MAX_BYTES)
        if (bytes.length !== stat.size) {
          return textOnly('这张图在读取时发生了变化（大小与刚查到的不一致）')
        }
        const sniffed = sniffFormat(bytes)
        if (sniffed === null) {
          return textOnly('这张图在读取之后格式变了，和当时识别的图片类型对不上')
        }
        const expected = IMAGE_MEDIA_TYPE[extname(target.abs).toLowerCase()] ?? 'image/png'
        const mediaType = SNIFF_MEDIA_TYPE[sniffed] ?? null
        if (mediaType === null || mediaType !== expected || mediaType !== image.data.mediaType) {
          return textOnly('这张图在读取之后格式变了，和当时识别的图片类型对不上')
        }
        const imageSize = imageSizeOf(bytes, sniffed)
        if (imageSize !== null && imageSize.width * imageSize.height > READ_IMAGE_MAX_PIXELS) {
          return textOnly(
            `这张图在读取之后尺寸变了（${imageSize.width}×${imageSize.height}），超过单张图片 ` +
              `${formatPixels(READ_IMAGE_MAX_PIXELS)} 像素的上限`
          )
        }
        return fileContent(mediaType, bytes)
      } catch {
        return textOnly('这张图在读取之后取不到了：文件可能刚被删除或改名')
      }
    }
  })
}
