/**
 * 对外唯一的入口：**原始字节 + 文件名 → 一张只读表格**。
 *
 * 移植自 DeepSeek Harness（MIT）`packages/client/ui-sidebar-documentpreview/src/client/excel/LazyExcelBody.tsx`
 * （那侧是"宿主按注册表选渲染器 + 注入 limits/locale"的形态）；出处与许可见同目录 `NOTICE.md`。
 *
 * 与上游的差异：**不再依赖任何宿主**——入参只有 `bytes` / `filename`（外加可选上限），
 * 加载态与文案由本组件自带；重解析链（exceljs / SheetJS / FortuneSheet）留在这条 lazily import 的分支里，
 * 没打开过表格的会话不会为它付解析与字节码代价。
 */
import { lazy, Suspense, useMemo } from 'react'
import { Spinner } from '@renderer/components/ui/spinner'
import { excelFormatOrNull } from './format'
import { resolveLimits, type ExcelLimits } from './model'
import { EXCEL_TEXT } from './text'
import './ExcelPreview.css'

export interface ExcelPreviewProps {
  /** 文件原始字节（只读借用；组件自己会拷一份交给解析链） */
  bytes: Uint8Array
  /** 文件名（或路径）：按后缀选解析器，`.xlsx` / `.xls` / `.csv` / `.tsv` */
  filename: string
  /** 覆盖解析上限（默认见 `EXCEL_LIMITS`：32 MiB / 25 万格 / 15s） */
  limits?: Partial<ExcelLimits>
}

const LoadedExcelBody = lazy(async () => ({ default: (await import('./ExcelBody')).ExcelBody }))

/**
 * 只读地显示一份表格。
 * @param props 字节、文件名与可选上限
 * @returns 只读表格（或它自己的失败人话）
 */
export function ExcelPreview({ bytes, filename, limits }: ExcelPreviewProps): React.JSX.Element {
  // 稳定成"三个数"：调用方每次渲染都会给新对象（`limits={{…}}`），不能让上层每次重解一遍
  const maxBytes = limits?.maxBytes
  const maxCells = limits?.maxCells
  const timeoutMs = limits?.timeoutMs
  const resolved = useMemo(
    () => resolveLimits({ maxBytes, maxCells, timeoutMs }),
    [maxBytes, maxCells, timeoutMs]
  )
  const format = excelFormatOrNull(filename)
  const loading = (
    <div className="kyclaw-excel-preview-status">
      <Spinner label={EXCEL_TEXT.loading} className="text-ink-tertiary" />
    </div>
  )
  if (format === null) {
    return (
      <div className="kyclaw-excel-preview-status" role="alert" data-testid="excel-preview-error">
        {EXCEL_TEXT.invalid}
      </div>
    )
  }
  return (
    <Suspense fallback={loading}>
      <LoadedExcelBody bytes={bytes} format={format} limits={resolved} loading={loading} />
    </Suspense>
  )
}
