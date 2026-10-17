/**
 * Office 阅读器（对外第二件）：**转换态 → 缺字体提示 → 直接复用 PDF 阅读器**。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/office/{OfficeBody,face,store}.tsx`，
 * 把它的宿主座位（tab 记录 / store / 转换缓存 / 远端 Remote / 字体动作）换成**一个注入的转换口**：
 *   - DSH 的 `OfficePreviewCache`（按 会话+路径+版本 复用转换结果、限并发、连接重置即换缓存）
 *     留在宿主与主进程那侧 —— 渲染端这里只保证"同一份 revision 不重复发"与"能取消"；
 *   - 缺字体的交互动作（DSH 的字体动作按钮）不搬：本仓这条链路的缺字体只如实提示一句。
 *
 * Office 转换后**复用同一个 PDF 阅读器**（`DshPdfViewer`）：选中复制、适应宽度、缩放、按需页渲染
 * 这些能力一份都不重复实现。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Spinner } from '@renderer/components/ui/spinner'
import { DshPdfViewer, type DshPdfViewerProps } from './DshPdfViewer'
import { isAbortError } from './errors'
import { fontNoticeText, toOfficePdf, type DshOfficeLoad, type DshOfficePdf } from './office'
import './dsh-document.css'

/** Office 这一层的文案（默认中文）。 */
export interface DshOfficeLabels {
  /** 转换进行中 */
  readonly converting: string
  readonly retry: string
}

const DEFAULT_LABELS: DshOfficeLabels = {
  // 加载态只说"在加载"（不把"转 PDF"这条内部链路讲给用户，反馈 003）
  converting: '正在加载预览…',
  retry: '重试'
}

/** 转换态：加载中 / 到手 / 失败（取消不落任何态）。 */
type OfficeState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly pdf: DshOfficePdf }
  | { readonly kind: 'failed'; readonly error: unknown }

/** 这一次转换的身份证（换令牌 / 点重试即换一张）。 */
interface ConvertRequest {
  readonly revision: number | string | undefined
  readonly attempt: number
}

/** 转换结果连同它属于哪一次转换。 */
type ConvertResult =
  | { readonly request: ConvertRequest; readonly kind: 'ready'; readonly pdf: DshOfficePdf }
  | { readonly request: ConvertRequest; readonly kind: 'failed'; readonly error: unknown }

export interface DshOfficeViewerProps {
  /** 转换口（主进程 LibreOffice kit 那条路）；必须尊重 signal，见 `office.ts`。 */
  readonly load: DshOfficeLoad
  /**
   * 转换令牌：**变了就重新转**（宿主把"重新读取 / 源文件变了"放进来）。
   * `load` 本身每次渲染新建也没关系 —— 这一层只在 revision 变化时才再调一次。
   */
  readonly revision?: number | string
  /** 失败人话（宿主按自己的错误码给；默认取 `Error.message`）。 */
  readonly describeFailure?: (error: unknown) => string
  /** 覆盖局部文案。 */
  readonly labels?: Partial<DshOfficeLabels>
  /** 额外类名（高度仍由宿主给）。 */
  readonly className?: string
  /** 交给下面那个 PDF 阅读器的参数（缩放回调 / 滚动口 / 文案…），`bytes` 由本组件负责。 */
  readonly viewerProps?: Omit<DshPdfViewerProps, 'bytes' | 'className'>
}

/**
 * @param props 转换口、令牌与失败文案。
 * @returns 转换态 + 复用 PDF 阅读器的 Office 阅读器。
 */
export function DshOfficeViewer({
  load,
  revision,
  describeFailure,
  labels: labelOverrides,
  className,
  viewerProps
}: DshOfficeViewerProps): React.JSX.Element {
  const [attempt, setAttempt] = useState(0)
  // `load` 允许每次渲染新建（内联箭头很常见），所以放进 ref：真正的"重新转"只由 revision / attempt 触发。
  // 写法遵循"不在渲染期写 ref"：先声明一条同步 ref 的 effect，它排在下面那条加载 effect 前面。
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])
  const labels: DshOfficeLabels = { ...DEFAULT_LABELS, ...labelOverrides }

  /**
   * "这一次转换的身份证"：换令牌 / 点重试就换一张 —— 转换态是**派生**的
   * （结果不匹配当前身份证 = 还在转），不必在 effect 体里同步 setState 把状态"重置"出来。
   */
  const request = useMemo<ConvertRequest>(() => ({ revision, attempt }), [revision, attempt])
  const [result, setResult] = useState<ConvertResult | undefined>(undefined)

  useEffect(() => {
    const lifetime = new AbortController()
    void loadRef.current(lifetime.signal).then(
      (loaded) => {
        if (!lifetime.signal.aborted) {
          setResult({ request, kind: 'ready', pdf: toOfficePdf(loaded) })
        }
      },
      (error: unknown) => {
        // 取消（换文件 / 卸载）不是失败
        if (!lifetime.signal.aborted && !isAbortError(error)) {
          setResult({ request, kind: 'failed', error })
        }
      }
    )
    return () => {
      lifetime.abort()
    }
  }, [request])

  const state: OfficeState =
    result === undefined || result.request !== request
      ? { kind: 'loading' }
      : result.kind === 'ready'
        ? { kind: 'ready', pdf: result.pdf }
        : { kind: 'failed', error: result.error }

  const notice = state.kind === 'ready' ? fontNoticeText(state.pdf.missingFonts) : null

  return (
    <div
      className={cn('flex h-full min-h-0 w-full min-w-0 flex-col', className)}
      data-testid="dsh-office-viewer"
      data-state={state.kind}
    >
      {state.kind === 'loading' ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-b2 text-ink-secondary"
          role="status"
          data-testid="dsh-office-loading"
        >
          <Spinner size="sm" decorative />
          <span>{labels.converting}</span>
        </div>
      ) : null}
      {state.kind === 'failed' ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-6"
          role="alert"
          data-testid="dsh-office-error"
        >
          <p className="text-center text-b2 text-ink-secondary">
            {describeFailure?.(state.error) ??
              (state.error instanceof Error && state.error.message !== ''
                ? state.error.message
                : '这份文档转不出预览')}
          </p>
          <Button
            variant="ghost"
            size="sm"
            data-testid="dsh-office-retry"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {labels.retry}
          </Button>
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          {notice === null ? null : (
            <p
              className="shrink-0 border-b border-hairline px-3 py-2 text-b2 text-ink-secondary"
              data-testid="dsh-office-font-notice"
            >
              {notice}
            </p>
          )}
          <DshPdfViewer {...viewerProps} bytes={state.pdf.bytes} className="min-h-0 flex-1" />
        </>
      ) : null}
    </div>
  )
}
