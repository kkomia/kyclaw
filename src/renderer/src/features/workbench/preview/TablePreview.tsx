/**
 * 表格预览（xlsx / csv / tsv）：主进程抽好的行 × 列，直接画成表。
 *
 * 口径：
 *   - **不做虚拟化**：上游已经封顶（≤20 表 × ≤2000 行 × ≤100 列），这个量级直接渲染没问题；
 *   - 多表（xlsx）给一排切换控件（tab 语言与工作台标签页同一套：选中 `bg-selected text-ink`，
 *     未选中 `hover:bg-hover`）；单表（csv/tsv）不摆这一排；
 *   - 单元格一律等宽；**看起来是数字的右对齐**（`data-numeric` 也标出来，测试直接打）；
 *   - 横向滚动：表格外层 `overflow-x-auto`，窄面板下宽表滚着看，不挤成一团。
 */
import { useState } from 'react'
import type { PreviewSheet } from '@shared/workbench'
import { cn } from '@renderer/components/ui/cn'

export function TablePreview({ sheets }: { sheets: readonly PreviewSheet[] }): React.JSX.Element {
  const [active, setActive] = useState(0)
  const current = sheets[Math.min(active, sheets.length - 1)]

  return (
    <div data-testid="file-preview-table" className="flex min-w-0 flex-col py-2">
      {sheets.length > 1 ? (
        <div
          role="tablist"
          aria-label="工作表"
          className="flex shrink-0 items-center gap-1 overflow-x-auto px-3 pb-2"
        >
          {sheets.map((sheet, index) => (
            <button
              key={`${sheet.name}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              data-testid="table-sheet-tab"
              onClick={() => setActive(index)}
              className={cn(
                'h-7 max-w-40 shrink-0 cursor-default truncate rounded-control px-2 text-b2 transition-colors duration-(--motion-fast) ease-main',
                index === active ? 'bg-selected text-ink' : 'text-ink-secondary hover:bg-hover'
              )}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      ) : null}

      {current === undefined ? null : current.rows.length === 0 ? (
        <p data-testid="file-preview-table-empty" className="px-3 py-2 text-b2 text-ink-tertiary">
          这张表没有内容
        </p>
      ) : (
        <div className="min-w-0 overflow-x-auto px-3">
          <table className="border-collapse font-mono text-b2 text-ink">
            <tbody>
              {current.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, columnIndex) => (
                    <td
                      key={columnIndex}
                      data-numeric={isNumericCell(cell) ? 'true' : 'false'}
                      className={cn(
                        'border border-hairline px-2 py-1 align-top whitespace-pre',
                        isNumericCell(cell) && 'text-right'
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {current?.truncated === true ? (
        <p
          data-testid="file-preview-table-truncated"
          className="px-3 pt-2 text-b2 text-ink-tertiary"
        >
          这张表太大，只显示了前面一部分
        </p>
      ) : null}
    </div>
  )
}

/**
 * 看起来是不是数字（右对齐用）：整数 / 小数 / 千分位 / 百分号都算（可带正负号）。
 * 不解析成 number —— 单元格里往往是账号、编号这种"像数字的字符串"，右对齐只是排版，不改数据。
 */
function isNumericCell(text: string): boolean {
  return /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/.test(text.trim())
}
