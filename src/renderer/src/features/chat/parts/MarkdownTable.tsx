import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode
} from 'react'
import { Check, Copy, Download } from 'lucide-react'
import type { ExtraProps } from 'react-markdown'
import { Tooltip } from '@renderer/components/ui/tooltip'

/**
 * 回复里的表格（0.1.3 · 007）：圆角外容器 + 横向滚动 + 图标式复制 / 下载。
 *
 * ## 导出的是"这段 Markdown 原文"，不是页面上看到的文字
 *
 * 复制 / 下载的内容必须与消息里的 Markdown 逐字节一致：单元格里的 `\|` 转义、对齐记号
 * （`:---:` / `---:`）、行内代码都要原样留着。所以这里**不从 DOM / innerText 重建**，而是拿
 * react-markdown 交给组件的 `node.position`（hast 的字符偏移）在**当前 Markdown 实例的源文本**
 * 上切片 —— 源文本由 `MarkdownSourceProvider` 从 TextPart 那一层传下来：整篇渲染时是全文，
 * 流式分块时是**那一块**的文本。偏移与文本同源，两条路切出来的都是消息里这一段自己
 * （块是全文的连续切片，见 markdown-blocks.ts），多张表各切各的、互不串台。
 *
 * ## 流式没结束不开放操作
 *
 * 结果没出完就允许导出，等于把半张表当成品交出去。判据是**祖先** `.markdown-body[data-streaming]`
 * 上的一条 CSS（见 styles/markdown.css），不是条件渲染：分块渲染与整篇渲染的 DOM 必须逐字节一致
 * （round 73 的保真度口径，钉在 text-part-blocks.spec.tsx），而且这样"结束后出现"不需要任何重渲染
 * —— 流一停，`display` 那条门就开了。
 *
 * ## 为什么走 context 而不是把源文本塞进 components
 *
 * 每次渲染现造 components 表会让 `table` 这个**元素类型**每帧换一个身份，React 会把整棵表格卸载
 * 再重挂（round 73 的 memo 化分块也一起白切）。这里组件类型是模块级常量，源文本走 context：
 * 值变了只是重渲染，不换身份、不重挂。
 */

/** 成功反馈自清的时长（与代码块复制的 2s 同口径） */
const FEEDBACK_MS = 2000
const COPY_LABEL = '复制表格 Markdown'
const DOWNLOAD_LABEL = '下载表格 .md'

/** 当前 Markdown 实例的源文本（null = 没有源文本，切不出原文） */
const MarkdownSourceContext = createContext<string | null>(null)

/**
 * 切原文只用到 position 上的两个字符偏移，所以参数写成这么窄的结构类型
 * （react-markdown 交给组件的 hast `Element` 在结构上满足它，单测也不必造整棵 hast 节点）。
 */
export interface TableSourceNode {
  position?: { start?: { offset?: number }; end?: { offset?: number } }
}

export interface MarkdownSourceProps {
  /** 这一个 Markdown 实例吃进去的源文本（整篇渲染 = 全文；流式分块 = 那一块） */
  source: string
  children: ReactNode
}

/** 把源文本交给下面这棵 markdown 子树（TextPart 每个 Markdown 实例套一层） */
export function MarkdownSourceProvider({
  source,
  children
}: MarkdownSourceProps): React.JSX.Element {
  return <MarkdownSourceContext.Provider value={source}>{children}</MarkdownSourceContext.Provider>
}

/**
 * 按 AST 位置切出这张表的原文（`start.offset` 起、`end.offset` 止；不含表格后的换行）。
 * 位置缺失或越界（理论上到不了）返回 null —— 调用方据此禁用两个按钮，不拿页面上看到的字凑。
 */
// eslint-disable-next-line react-refresh/only-export-components -- 纯口径，单测要直接打它；拆文件不值当
export function tableSourceOf(
  source: string | null,
  node: TableSourceNode | undefined
): string | null {
  if (source === null || !node) return null
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (start < 0 || end <= start || end > source.length) return null
  return source.slice(start, end)
}

/** 文件名里不收的字符（Windows / POSIX 合并口径）+ 控制字符（写 `\p{Cc}`：字面控制字符转义会踩 no-control-regex） */
const UNSAFE_IN_NAME = /[\\/:*?"<>|\p{Cc}]/gu
/** 行内记号：表头格里的装饰不该进文件名 */
const INLINE_MARKUP = /[`*_~[\]]/g

/** 文件名里的表格标识：表头第一格（去行内记号与非法字符），空则回落 `table` */
function tableLabel(markdown: string): string {
  const firstLine = markdown.split('\n', 1)[0] ?? ''
  const firstCell = firstLine.replace(/^\|/, '').split(/(?<!\\)\|/)[0] ?? ''
  return (
    firstCell
      .replace(INLINE_MARKUP, '')
      .replace(UNSAFE_IN_NAME, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 24) || 'table'
  )
}

/**
 * 落盘文件名：`kyclaw-表格-<标识>-<yyyyMMdd-HHmmss>.md`（本地时间到秒，口径同轨迹导出）。
 * 标识取表头第一格：同一条回复里多张表下载下来也分得清是哪张。
 */
// eslint-disable-next-line react-refresh/only-export-components -- 纯口径，单测要直接打它；拆文件不值当
export function tableFileName(markdown: string, now: Date = new Date()): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(
    now.getHours()
  )}${two(now.getMinutes())}${two(now.getSeconds())}`
  return `kyclaw-表格-${tableLabel(markdown)}-${stamp}.md`
}

/**
 * 落盘：Blob → objectURL → `a[download]` 点一下 → 立刻释放 URL（与轨迹导出同一做法）。
 * 纯壳子——内容来自上面的切片，测试打的是"交给下载管理器的 Blob 与文件名"。
 */
function downloadTableMarkdown(markdown: string, fileName: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

interface TableFeedback {
  tone: 'ok' | 'error'
  text: string
}

type MarkdownTableProps = ComponentProps<'table'> & ExtraProps

/** react-markdown 的 `table` 组件：整张表套进圆角外壳，操作行挂在表格上方 */
export function MarkdownTable({ node, children, ...rest }: MarkdownTableProps): React.JSX.Element {
  const markdown = tableSourceOf(useContext(MarkdownSourceContext), node)
  const [feedback, setFeedback] = useState<TableFeedback | null>(null)
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    },
    []
  )

  /** 一条反馈上屏：成功 2s 后自清，失败留在原地（用户可能没看着屏幕，不能让它自己消失） */
  const settle = (next: TableFeedback): void => {
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current)
      resetTimer.current = null
    }
    setFeedback(next)
    if (next.tone !== 'ok') return
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null
      setFeedback(null)
      setCopied(false)
    }, FEEDBACK_MS)
  }

  const copy = async (): Promise<void> => {
    if (markdown === null) return
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      settle({ tone: 'ok', text: '已复制' })
    } catch (cause) {
      console.warn('[kyclaw] 复制表格失败', cause)
      setCopied(false)
      settle({ tone: 'error', text: '复制失败' })
    }
  }

  const download = (): void => {
    if (markdown === null) return
    try {
      downloadTableMarkdown(markdown, tableFileName(markdown))
      setCopied(false)
      // 只说"开始下载"：文件是交给系统下载管理器的，落到哪、存没存下来这里看不到 ——
      // 另存为对话框被取消也一样，不能出现"保存成功"那种反向说法
      settle({ tone: 'ok', text: '已开始下载' })
    } catch (cause) {
      console.warn('[kyclaw] 下载表格失败', cause)
      settle({ tone: 'error', text: '下载失败' })
    }
  }

  return (
    <div data-testid="markdown-table" className="markdown-table-shell">
      {/* 操作行：流式期间由 CSS 整行收起（DOM 不变），见 styles/markdown.css */}
      <div data-testid="table-actions" className="markdown-table-head">
        <span
          role="status"
          data-testid="table-status"
          data-tone={feedback?.tone}
          className="markdown-table-status"
        >
          {feedback?.text}
        </span>
        <Tooltip label={COPY_LABEL}>
          <button
            type="button"
            data-testid="table-copy"
            aria-label={COPY_LABEL}
            disabled={markdown === null}
            onClick={() => {
              void copy()
            }}
            className="markdown-table-tool"
          >
            {copied ? (
              <Check aria-hidden="true" className="size-3.5" />
            ) : (
              <Copy aria-hidden="true" className="size-3.5" />
            )}
          </button>
        </Tooltip>
        <Tooltip label={DOWNLOAD_LABEL}>
          <button
            type="button"
            data-testid="table-download"
            aria-label={DOWNLOAD_LABEL}
            disabled={markdown === null}
            onClick={download}
            className="markdown-table-tool"
          >
            <Download aria-hidden="true" className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      <div data-testid="markdown-table-scroll" className="markdown-table-scroll">
        <table {...rest}>{children}</table>
      </div>
    </div>
  )
}
