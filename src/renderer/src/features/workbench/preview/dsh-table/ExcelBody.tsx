/**
 * 只读表格界面：解析结果交给 FortuneSheet 画（**不编辑、不重算公式**）。
 * 面板尺寸变化时戳一下 window resize —— FortuneSheet 只在 window resize 时重新量画布。
 *
 * 移植自 DeepSeek Harness（MIT）`packages/client/ui-sidebar-documentpreview/src/client/excel/excel.tsx`；
 * 出处与许可见同目录 `NOTICE.md`。
 * 差异：宿主注入的 locale / 加载态 / 按钮与图标，换成本仓库的文案常量、`components/ui` 与 lucide。
 */
import { Workbook } from '@fortune-sheet/react'
import fortuneCss from '@fortune-sheet/react/dist/index.css?inline'
import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { ExcelPreviewError } from './errors'
import type { ExcelFormat } from './format'
import type { ExcelLimits, ExcelPreview } from './model'
import { parseExcel } from './parse'
import { EXCEL_ERROR_TEXT, EXCEL_TEXT, unsupportedNotice } from './text'
import './ExcelPreview.css'

/** FortuneSheet 自己的样式表按组件根作用域收进来，不往全局漏 */
const scopedStyles = `@scope ([data-excel-preview]) { ${fortuneCss} }`

/**
 * 手上这份结果属于哪一次请求（字节 / 格式 / 第几次重试）——对不上就显示加载态，不显示上一份。
 * `error` 存的是**失败种类**（`ExcelPreviewError.code`），界面按它取人话。
 */
type BodyState = { bytes: Uint8Array; format: ExcelFormat; attempt: number } & (
  { value: ExcelPreview } | { error: string }
)

export interface ExcelBodyProps {
  /** 完整文件字节（只读借用） */
  bytes: Uint8Array
  /** 按后缀定下来的格式 */
  format: ExcelFormat
  /** 已补齐的解析上限 */
  limits: ExcelLimits
  /** 主 bundle 那一侧的加载态（懒加载与"还没解完"共用同一份） */
  loading: ReactNode
}

/**
 * 显示存下来的值与格式，不回算公式。
 * @param props 完整字节、上限与加载态
 * @returns 一张独立的只读表格
 */
export function ExcelBody({ bytes, format, limits, loading }: ExcelBodyProps): React.JSX.Element {
  const [state, setState] = useState<BodyState>()
  const [attempt, setAttempt] = useState(0)
  const workbookRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    void parseExcel(bytes, format, limits, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setState({ bytes, format, attempt, value })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            bytes,
            format,
            attempt,
            error: error instanceof ExcelPreviewError ? error.code : 'invalid'
          })
        }
      }
    )
    return () => {
      controller.abort()
    }
  }, [bytes, format, limits, attempt])

  useEffect(() => {
    const element = workbookRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      window.dispatchEvent(new Event('resize'))
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [state])

  // 手上这份结果不是当前请求的（还没解完 / 刚换了文件 / 刚点了重试）：显示加载态，不显示上一份
  if (
    state === undefined ||
    state.bytes !== bytes ||
    state.format !== format ||
    state.attempt !== attempt
  ) {
    return <div className="kyclaw-excel-preview-status">{loading}</div>
  }

  if ('error' in state) {
    // 失败种类 → 人话；认不出的种类（理论上不该有）一律按"打不开"说
    return (
      <div className="kyclaw-excel-preview-status" role="alert" data-testid="excel-preview-error">
        <span>{EXCEL_ERROR_TEXT[state.error] ?? EXCEL_TEXT.invalid}</span>
        <Button
          size="sm"
          variant="ghost"
          data-testid="excel-preview-retry"
          onClick={() => {
            setAttempt((value) => value + 1)
          }}
        >
          {EXCEL_TEXT.retry}
        </Button>
      </div>
    )
  }

  const hasFormulas = state.value.sheets.some((sheet) =>
    sheet.celldata?.some((cell) => cell.v?.f !== undefined)
  )
  return (
    <section
      className="kyclaw-excel-preview"
      data-excel-preview
      data-testid="excel-preview"
      aria-label={EXCEL_TEXT.title}
    >
      <style>{scopedStyles}</style>
      {state.value.unsupportedFeatures.length > 0 ? (
        <div
          className="excel-preview-notice"
          role="note"
          data-testid="excel-preview-notice"
          data-excel-unsupported-notice
        >
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{unsupportedNotice(state.value.unsupportedFeatures)}</span>
        </div>
      ) : null}
      <div
        ref={workbookRef}
        className={`excel-preview-workbook${hasFormulas ? ' excel-preview-with-warning' : ''}`}
      >
        {hasFormulas ? (
          <Tooltip label={EXCEL_TEXT.formulaWarning} side="bottom">
            <button
              type="button"
              className="excel-preview-formula-warning"
              aria-label={EXCEL_TEXT.formulaWarning}
              data-testid="excel-preview-formula-warning"
              data-excel-formula-warning
            >
              <AlertTriangle size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        ) : null}
        <Workbook
          key={String(attempt)}
          data={state.value.sheets}
          lang="zh"
          allowEdit={false}
          showToolbar={false}
          showFormulaBar
          showSheetTabs
          forceCalculation={false}
          cellContextMenu={['copy']}
          headerContextMenu={[]}
          sheetTabContextMenu={[]}
          filterContextMenu={[]}
        />
      </div>
    </section>
  )
}
