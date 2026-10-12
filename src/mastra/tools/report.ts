/**
 * create_report / create_pdf：报告与 PDF 两件（模块 4 首发格式）。
 *
 * - **create_report**：正文 HTML → 自带样式（内联 CSS、无外部请求、离线可看）的单文件 HTML → 落工作区。
 *   交互式报告的口径就是"HTML artifact"（spec §5.1）：浏览器能开、能打印、能当附件发。
 * - **create_pdf**：同一份 HTML → **主进程注入的 printPdf 钩子**（真实现 = Electron 原生 printToPDF，
 *   见 main/print-pdf.ts）→ PDF 字节 → 落工作区。工具层不 import electron，所以这条链路能在
 *   vitest（node 环境）里用 stub 钩子钉住"HTML 长什么样、字节怎么写、错误怎么报"。
 *
 * 两件的路径/审批/回执口径都在 artifacts.ts（与 write 同档：写类默认问、full 工作区免审、越界 fail closed）。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { checkPdf } from './artifact-check'
import {
  artifactNeedsApproval,
  artifactTarget,
  NO_PDF_PRINTER_MESSAGE,
  renderReportHtml,
  saveArtifact,
  type PdfPrinter
} from './artifacts'
import { approvalSessionOf, sessionKey, type ToolContext } from './guard'

/** 标题缺省时的兜底（渲染进 <title> 与页首；文件名也会用它派生） */
const FALLBACK_TITLE = '报告'

/** 输入上限（依据：模块 4 报告 §六.6 登记的"输入规模无上限"）：超限让模型知道怎么改 */
const MAX_TITLE_CHARS = 200
const MAX_HTML_CHARS = 200000

export const reportInputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(MAX_TITLE_CHARS, `标题最长 ${MAX_TITLE_CHARS} 字，请精简`)
    .describe(
      `报告标题（写进页首与 <title>；不给 path 时也用它派生文件名；最长 ${MAX_TITLE_CHARS} 字）`
    ),
  html: z
    .string()
    .min(1)
    .max(MAX_HTML_CHARS, `正文最多 ${MAX_HTML_CHARS} 字符，请拆分内容`)
    .describe(
      `报告正文的 HTML 片段（h2/h3、p、ul/ol、table、pre/code、blockquote 都带样式；` +
        `最多 ${MAX_HTML_CHARS} 字符）。` +
        '不要再写 <html>/<head>/<style> 外壳，也不用重复一级标题——模板已经带上标题'
    ),
  path: z
    .string()
    .optional()
    .describe('落盘路径（相对当前会话工作区；不给就按标题派生文件名，如 报告.html）')
})

export type ReportInput = z.infer<typeof reportInputSchema>

export const pdfInputSchema = z.object({
  title: z
    .string()
    .max(MAX_TITLE_CHARS, `标题最长 ${MAX_TITLE_CHARS} 字，请精简`)
    .optional()
    .describe(`PDF 文档标题（页首与 <title>；不给就写「报告」；最长 ${MAX_TITLE_CHARS} 字）`),
  html: z
    .string()
    .min(1)
    .max(MAX_HTML_CHARS, `正文最多 ${MAX_HTML_CHARS} 字符，请拆分内容`)
    .describe(
      `文档正文的 HTML 片段（与 create_report 同一套样式与写法；最多 ${MAX_HTML_CHARS} 字符）`
    ),
  path: z.string().optional().describe('落盘路径（相对当前会话工作区；不给就按标题派生文件名）')
})

export type PdfInput = z.infer<typeof pdfInputSchema>

export async function createReportTool(ctx: ToolContext): Promise<Tool<ReportInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'create_report',
    description:
      '生成一份排版好的 HTML 报告（单文件、自带样式、浏览器可看可打印，离线也不丢样式），' +
      '落到当前会话工作区并返回文件路径与字节数。适合说明性长文、方案、总结、带表格的盘点。' +
      '只要 PDF 就用 create_pdf；结构化数据用 create_excel；演示用 create_ppt；正式文档用 create_docx。' +
      '执行前会请求用户批准。',
    inputSchema: reportInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      artifactNeedsApproval(
        ctx,
        'create_report',
        input,
        'html',
        FALLBACK_TITLE,
        approvalSessionOf(approval)
      ),
    execute: async (input, context) => {
      const session = sessionKey(context)
      const abs = artifactTarget(ctx, input, 'html', FALLBACK_TITLE, session)
      const html = renderReportHtml({ title: input.title, body: input.html })

      return await saveArtifact(ctx, abs, html, 'HTML 报告', { markRead: true, session })
    }
  })
}

export async function createPdfTool(
  ctx: ToolContext,
  printPdf?: PdfPrinter
): Promise<Tool<PdfInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'create_pdf',
    description:
      '把 HTML 内容导出成 PDF（A4、带背景色、留白边距），落到当前会话工作区并返回文件路径与字节数。' +
      '适合要发给别人、要打印或要归档的成品文档；正文写法与 create_report 完全一致。' +
      '执行前会请求用户批准。',
    inputSchema: pdfInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      artifactNeedsApproval(
        ctx,
        'create_pdf',
        input,
        'pdf',
        FALLBACK_TITLE,
        approvalSessionOf(approval)
      ),
    execute: async (input, context) => {
      const session = sessionKey(context)
      // 先解析路径（批了再写不进去的目标，不该白跑一次打印）
      const abs = artifactTarget(ctx, input, 'pdf', FALLBACK_TITLE, session)

      if (printPdf === undefined) throw new Error(NO_PDF_PRINTER_MESSAGE)

      const title = input.title?.trim() ?? ''
      const html = renderReportHtml({
        title: title === '' ? FALLBACK_TITLE : title,
        body: input.html
      })

      let bytes: Buffer | Uint8Array
      try {
        bytes = await printPdf(html)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`PDF 导出失败：${detail}（可以先用 create_report 生成 HTML 报告）`)
      }

      // 产出后结构自检：钩子返回的不是 PDF（没有 %PDF- 头 / 末尾没有 %%EOF）就抛错，不落盘
      const check = checkPdf(bytes)
      if (!check.ok) {
        throw new Error(`产出物生成失败：结构自检没通过（${check.reason ?? check.note}）`)
      }

      return await saveArtifact(ctx, abs, bytes, 'PDF', { session, check: check.note })
    }
  })
}
