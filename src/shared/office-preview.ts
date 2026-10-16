/**
 * 办公档**页式预览**（doc / docx / ppt / pptx → PDF）的跨进程协议。
 *
 * 为什么要有这条协议：工作台现在对 Word 是 markdown 结构预览、对 PPT 是逐页文字提要
 * （`main/workbench-office.ts`），版式一律不还原；旧版 .doc / .ppt 连结构都读不出来。
 * 真按页看只有一条路：**本地转 PDF 再交给已有的 PDF 预览**（pdfjs），所以这一轮加的是
 * "把办公档转成 PDF 字节"的后端，形状就按这条通道来定。
 *
 * 分工（**这一条是安全红线**）：
 *   - 主进程 handler 负责授权：会话根解析（`sessionRootForThread`）+ containment
 *     （`resolveInsideWorkspace`）+ 存在性/大小闸门，**绝对路径只活在主进程**；
 *   - 后端（`main/office-preview.ts`）只认"已授权的源"（key / version / read 回调），
 *     **不认路径** —— 它没有能力读一个接线层没授权过的文件；
 *   - 渲染端只发 `threadId + 相对路径`，收到的只有 PDF 字节、缺字体名单与分类后的失败。
 *
 * 与 `shared/workbench.ts` 的关系：那边是**文件树/Git/终端**的既有合同，这里独立成一份，
 * 免得"办公档要 PDF"这件事去改那三个工具的形状（`PREVIEW_OFFICE_MAX_BYTES` 那组预览上限
 * 仍归那边管，本文件只声明**转换服务自己**的上限）。
 */
import { z } from './zod'

/**
 * IPC 通道名。接线时加进 `shared/ipc.ts` 的 `IPC_CHANNELS.workbench`（入参见
 * `officePreviewArgsSchema`，回包见 `officePreviewResultSchema`）。
 *
 * 名字按"回包是什么"取（与 `workbench:read-bytes` 同一口径）：这条通道回的就是一份 PDF。
 */
export const OFFICE_PREVIEW_CHANNEL = 'workbench:office-pdf'

/**
 * 认得（并会转成 PDF）的办公档后缀。
 *
 * 只有这四类：doc / docx / ppt / pptx。**表格（xls / xlsx / csv）刻意不在内** ——
 * 表格已经有结构化预览（表格式抽格子），转 PDF 对"看数据"没有增益，多一类就多一份引擎负担
 * 与一份失败面；等真有"要看表格版式"的需求再单开。
 */
export const OFFICE_PREVIEW_FORMATS = ['doc', 'docx', 'ppt', 'pptx'] as const
export const officePreviewFormatSchema = z.enum(OFFICE_PREVIEW_FORMATS)
export type OfficePreviewFormat = z.infer<typeof officePreviewFormatSchema>

/**
 * 转换的调度意图：
 *   - `foreground`：用户正在看的这一份（默认）；
 *   - `background`：预热的（提前转、可能还没人看）。后台任务只在有富余时跑，且会被前台挤掉。
 * 现在接线层只用 foreground；留着是因为队列的准入/淘汰语义本来就按它分档。
 */
export const officePreviewPrioritySchema = z.enum(['foreground', 'background'])
export type OfficePreviewPriority = z.infer<typeof officePreviewPrioritySchema>

/**
 * 失败分类（渲染端据此说人话，也据此决定"要不要重试"）：
 *   - `input-too-large` / `output-too-large`：源文件或转出来的 PDF 超过上限；
 *   - `invalid-document`：引擎读不出这份文件（损坏、带密码、扩展名与内容对不上）；
 *   - `unsupported-format`：扩展名不在 `OFFICE_PREVIEW_FORMATS` 里；
 *   - `invalid-output`：命令跑完了，但产出不是一份完整的 PDF；
 *   - `timeout`：转换超时；
 *   - `unavailable`：这台机器上没有可用的随包引擎（`resources/libreoffice-kit` 不在）；
 *   - `failed`：引擎报错但归类不出（含分类不了的其他一切）；
 *   - `busy`：队满/读者满（**稍后重试**就会好，与"这份文件转不了"不是一回事）；
 *   - `source-changed`：转换期间源文件被改了（**重开预览**）；
 *   - `missing`：源文件已不在磁盘上（树是旧的，**刷新一下**）；
 *   - `cancelled`：**这次转换被取消了**（用户切走了、面板关了，或同一个 requestId 又发了新请求）
 *     —— 界面直接丢弃这一条，**不当错误显示**（它不是"这份文件转不了"）。
 */
export const OFFICE_PREVIEW_ERROR_CODES = [
  'input-too-large',
  'output-too-large',
  'invalid-document',
  'unsupported-format',
  'invalid-output',
  'timeout',
  'unavailable',
  'failed',
  'busy',
  'source-changed',
  'missing',
  'cancelled'
] as const
export const officePreviewErrorCodeSchema = z.enum(OFFICE_PREVIEW_ERROR_CODES)
export type OfficePreviewErrorCode = z.infer<typeof officePreviewErrorCodeSchema>

/**
 * 分类失败：引擎/文件系统的细节留在 `cause` 里，`code` 是给消费者看的分类。
 *
 * 为什么这个类住 shared（而不是主进程那份服务里）：**接线层要按分类判事**——
 * `main/workbench-files.ts` 把授权读出来的分类错误转成回包，`main/ipc/workbench.ts` 把取消
 * 归成 `cancelled`。放在这里，接线层只依赖协议、**不依赖引擎那坨**（那份要起子进程的模块
 * 只在真要转的时候懒加载）。
 */
export class OfficePreviewError extends Error {
  constructor(
    readonly code: OfficePreviewErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'OfficePreviewError'
  }
}

/**
 * 分类 → 中文人话（**口径只住一处**：渲染端显示的就是这里这一句，引擎自己报的失败另外把
 * "引擎的话"附在 `message` 里，同样从这里取底）。
 */
export const OFFICE_PREVIEW_FAILURE_MESSAGES: Readonly<Record<OfficePreviewErrorCode, string>> = {
  'input-too-large': '这个文件太大，超过了预览转换的上限',
  'output-too-large': '转出来的 PDF 太大，超过了预览上限',
  'invalid-document': '读不出这个文件：它可能已损坏、带密码，或扩展名与内容对不上',
  'unsupported-format': '这一类文件不走页式预览（只支持 doc / docx / ppt / pptx）',
  'invalid-output': '转换没有产出可用的 PDF',
  timeout: '转换超时，可以重试一次',
  unavailable: '这台机器上没有可用的随包渲染引擎（resources/libreoffice-kit）',
  failed: '转换失败，没有产出可用的 PDF',
  busy: '预览转换的任务已满，稍后再试',
  'source-changed': '文件在转换期间被改了，请重新打开预览',
  missing: '这个文件不在磁盘上了（可能刚被删除或改名）',
  cancelled: '这次预览转换已取消'
}

/**
 * 授权的源定位键：由接线层编码"授权范围 + 规范化后的绝对路径"，引擎侧只拿它做去重
 * （它**不解析**这个键）。
 * 用 JSON 数组而不是拼接字符串：拼接会让 `('a','bc')` 与 `('ab','c')` 撞成同一个键。
 */
export function officePreviewSourceKey(...parts: readonly string[]): string {
  return JSON.stringify(parts)
}

/**
 * 源文件版本：接线层从 stat 派生（`size` + `mtimeMs`）。
 * **授权时那一处与读完之后复检那一处必须用同一个函数** —— 两处各写一套，判据就会悄悄分叉
 * （一个按 mtime、一个按 size，文件改了以后两边都还"没变"）。
 */
export function officePreviewSourceVersion(stat: { size: number; mtimeMs: number }): string {
  return `${stat.size}:${stat.mtimeMs}`
}

/** 源文件上限（字节）：与随包 kit 自己的 `maxInputBytes` 默认值、以及旧版转换那条路同档 */
export const OFFICE_PREVIEW_INPUT_MAX_BYTES = 64 * 1024 * 1024

/**
 * 产出的 PDF 上限（字节）：与 `shared/workbench.ts` 的 `PREVIEW_PDF_MAX_BYTES` 同档 32MB。
 * 为什么必须同档：这份 PDF 要整份过 IPC 再交给同一个 pdfjs 预览画，超了那边一样画不出来 ——
 * 在这里先拒，比"转完了再在渲染端报过大"少一次白跑的引擎。
 */
export const OFFICE_PREVIEW_OUTPUT_MAX_BYTES = 32 * 1024 * 1024

/** 单次转换的截止（毫秒）：与 kit 自己的 `timeoutMs` 默认值同档（同一个数会一并传给引擎） */
export const OFFICE_PREVIEW_TIMEOUT_MS = 120_000

/**
 * 请求 id 的形状。渲染端生成（`crypto.randomUUID()` 即可），**每次预览换一个新值**。
 *
 * 它只服务"取消"这一件事：`cancelOfficePdf(requestId)` **只能取消发起它的那个窗口**的请求
 * （主进程按 webContents 绑归属，见 `main/ipc/workbench.ts` 的 `createOfficePreviewRequests`），
 * 所以两个窗口各用同名的 id 也不会互相踩。同一个窗口拿同一个 id 再发一次 = **新请求顶掉旧的**
 * （旧的那次回 `cancelled`），因此"重发同一个 requestId"本身也是一种取消。
 *
 * 长度上限是护栏不是口径：id 只是主进程里的一张表的键，128 个字符够任何 UUID 变体。
 */
export const OFFICE_PREVIEW_REQUEST_ID_MAX = 128
export const officePreviewRequestIdSchema = z.string().min(1).max(OFFICE_PREVIEW_REQUEST_ID_MAX)

/**
 * `workbench:office-pdf` 的入参：[threadId, 相对会话根的路径, 调度意图, 请求 id]。
 * 路径一律相对会话根（正斜杠书写，会话根与 containment 都在主进程算）—— 与其余工作台通道同口径；
 * **绝对路径永远不进这条通道**（渲染端连"文件在哪"都不知道，它只知道自己点的是树上的哪一条）。
 */
export const officePreviewArgsSchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  officePreviewPrioritySchema,
  officePreviewRequestIdSchema
])

/**
 * `workbench:cancel-office-pdf` 的入参：[requestId]。
 * **只取消本窗口自己发起的那个请求**（另一个窗口拿同一个 id 来取消 = 空操作，见主进程那张表）；
 * 幂等：没这个请求（已经跑完了 / id 打错了）也是空操作，不抛。
 */
export const officePreviewCancelArgsSchema = z.tuple([officePreviewRequestIdSchema])

/**
 * `workbench:office-pdf` 的回包（判别联合）：
 *   - `pdf`：转好了 —— **原始 PDF 字节**（Uint8Array 过结构化克隆，不转 base64）+ 缺字体名单
 *     + 源文件版本（渲染端缓存用，转出的 PDF 只对**这个版本**有效）+ 服务代次；
 *   - `failed`：没转成 —— `code` 是上面的分类，`message` 是可直接显示的中文人话。
 *
 * **取消也是一种"回来了"**：`cancelOfficePdf` 之后（或同一个 requestId 被新请求顶掉之后），
 * 这一路**照常 resolve** 一条 `kind: 'failed', code: 'cancelled'`，不是 reject ——
 * 界面按"直接丢弃、不报错"处理（取消是用户自己的动作）。
 * 真正抛出来的是另一类：**越权路径**（fail closed，与其余工作台通道同一条人话）与
 * 结构不合法（preload 的 schema 不过）。
 *
 * 两处必须说清的诚实边界（别把回包读成"没缺字"）：
 *   1. `missingFonts` **只有 OOXML（docx / pptx）才有内容**：引擎只对这两种格式声明
 *      "文档要求的字体这台机器没有"。旧版二进制（doc / ppt）回来的**永远是空数组 ——
 *      那是"查不了"，不是"不缺字"**（引擎自己的口径），界面上别据此说"字体齐全"。
 *   2. 缺字名单里的名字是**文档要求的字体族名**，不是"建议安装哪个文件"。
 *
 * 版本与代次都不许解析（渲染端只拿它们比相等）：版本由接线层从 stat 派生，代次是服务实例
 * 的随机标签（进程里换过引擎配置才会变；当前实现里一个进程一个值）。
 */
export const officePreviewResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pdf'),
    /** 回显请求里的那条相对路径（渲染端据此确认"这份 PDF 就是我点的那份"） */
    path: z.string().min(1),
    /** 源文件版本：与请求时的版本不等 = 这份 PDF 已经过期（别缓存） */
    version: z.string().min(1),
    pdf: z.instanceof(Uint8Array),
    size: z.number(),
    missingFonts: z.array(z.string()),
    /** 服务代次（同一个 PDF 缓存只在同一代次内可复用） */
    generation: z.string().min(1)
  }),
  z.strictObject({
    kind: z.literal('failed'),
    path: z.string().min(1),
    code: officePreviewErrorCodeSchema,
    message: z.string().min(1)
  })
])
export type OfficePreviewResult = z.infer<typeof officePreviewResultSchema>
