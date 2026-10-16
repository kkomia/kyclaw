/**
 * Office（docx / xlsx / pptx，以及 PDF 之外的"先转再看"产物）这一条预览的**纯口径**：
 * 转换结果的形状、归一化、缺字体提示。组件在 `DshOfficeViewer.tsx`。
 *
 * 为什么 Office 走"转 PDF 再看"而不是自己画版式：DOCX/XLSX 的排版是 Office 引擎的活，
 * 浏览器里重画一遍必然对不上原稿（既有预览也只在主进程抽结构、不还原版式）。随包
 * `@deepseek-ai/libreoffice-kit`（MPL-2.0）已经把"Office → PDF"做成一条确定性链路，
 * 于是渲染端只负责：**要字节 → 交给 PDF 阅读器（同一个组件）**。
 */

/** 一次转换的产物：PDF 字节 + 可选"本机没装的字体族"。 */
export interface DshOfficePdf {
  readonly bytes: Uint8Array | ArrayBuffer
  /**
   * 转换时报缺的字体族（libreoffice-kit 的 `RenderResult.missingFonts` 就是这一项）。
   * 有就跟用户说一句"版式可能和原稿不一样"，不假装一致。
   */
  readonly missingFonts?: readonly string[]
}

/** 转换口可以只回字节（最省事），也可以回完整形状。 */
export type DshOfficeLoadResult = DshOfficePdf | Uint8Array | ArrayBuffer

/**
 * 转换口：把 Office 字节转成完整 PDF 字节。
 *
 * **必须尊重 `signal`**：换文件 / 卸载 / 重新转换都靠它取消（取消的失败按"不是错误"处理，
 * 不要弹错误态）。实现方通常是渲染端 → 主进程一条 IPC（主进程那边调随包 LibreOffice kit）。
 *
 * 本仓已有对应的跨进程协议（**另一个代理在推进，尚未接线**）：`src/shared/office-preview.ts`
 * 的 `workbench:office-pdf` —— 入参 `[threadId, 相对路径, priority]`，回包判别联合
 * `{ kind:'pdf', path, version, pdf, size, missingFonts, generation }` /
 * `{ kind:'failed', path, code, message }`。接线只要把它翻成这里的形状：
 *
 * ```ts
 * const load: DshOfficeLoad = async (signal) => {
 *   const result = await workbench.officePdf(threadId, relative, 'foreground')
 *   signal.throwIfAborted()
 *   if (result.kind === 'failed') throw Object.assign(new Error(result.message), { code: result.code })
 *   return { bytes: result.pdf, missingFonts: result.missingFonts }
 * }
 * ```
 *
 * 那份协议里已经声明、接线时**别踩**的两条边界：`missingFonts` 只有 docx/pptx 才有内容，
 * 旧版 doc/ppt 回空数组是"查不了"而不是"不缺字"（所以本组件**只在名单非空时**提示，
 * 不反向说"字体齐全"）；`code === 'busy'` 是"稍后再试"，不是"这份文件转不了"。
 */
export type DshOfficeLoad = (signal: AbortSignal) => Promise<DshOfficeLoadResult>

/** 归一化：只回字节的也认，统一成 `{ bytes, missingFonts }`。 */
export function toOfficePdf(result: DshOfficeLoadResult): DshOfficePdf {
  return result instanceof Uint8Array || result instanceof ArrayBuffer ? { bytes: result } : result
}

/**
 * 缺字体的人话（最多列三种，其余报个数）；一种都不缺（或没给）时给 `null`。
 * @param fonts 转换口报上来的缺字体族（可能带重复与空白）。
 */
export function fontNoticeText(fonts: readonly string[] | undefined): string | null {
  const names = [...new Set((fonts ?? []).map((name) => name.trim()))].filter((name) => name !== '')
  if (names.length === 0) return null
  const shown = names.slice(0, 3).join('、')
  const rest = names.length > 3 ? ` 等 ${names.length} 种` : ''
  return `这份文档用到的字体本机没有：${shown}${rest}；版式可能和原稿不一样`
}
