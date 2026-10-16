import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ExcelJS, { type Workbook } from 'exceljs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExcelPreviewError } from '../errors'
import type { ExcelFormat } from '../format'
import type { ExcelLimits } from '../model'
import { ExcelPreview } from '../ExcelPreview'
import { EXCEL_TEXT } from '../text'

/**
 * 对外那个入口（`bytes` + `filename` → 只读表格）的行为口径：
 *   - 送进 FortuneSheet 的是**只读配置**：不编辑、不重算、不摆工具栏，右键菜单只留「复制」；
 *   - 有公式就摆警告（结果可能缺）、有认出来但不显示的内容就摆提示；
 *   - 认不出的后缀 / 解不开的字节 / 越过上限 / **Worker 起不来**，都各说各的人话（不静默、不假成功）；
 *   - 换了字节就**不许把上一份留在屏上**。
 *
 * 两个替身：
 *   - `@fortune-sheet/react` 整包替身（jsdom 没有 canvas，真画布渲染由真机取证举证）；
 *   - `../parse` 换成"同线程直接跑真 convertExcel" —— jsdom 里没有 Worker，而真实入口按口径
 *     **严格隔离**（没有 Worker 就回可重试的 `worker` 失败），所以组件这层不经过它。
 *     入口自己的契约（Worker 缺失 / 起不来 / 超时 / abort 释放）由 `parse.spec.ts` 覆盖。
 */
const workbookProps = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const parseMock = vi.hoisted(() => vi.fn())

vi.mock('@fortune-sheet/react', async () => {
  const { createElement } = await import('react')
  return {
    Workbook: (props: Record<string, unknown>) => {
      workbookProps.push(props)
      return createElement('div', { 'data-testid': 'fortune-workbook' })
    }
  }
})

vi.mock('../parse', async () => {
  const { convertExcel } = await import('../convert')
  parseMock.mockImplementation((bytes: Uint8Array, format: ExcelFormat, limits: ExcelLimits) =>
    convertExcel(bytes, format, limits)
  )
  return { parseExcel: parseMock }
})

const csv = (text: string): Uint8Array => new TextEncoder().encode(text)

/** 现搭一份 xlsx 字节 */
async function xlsxBytes(build: (workbook: Workbook) => void): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook()
  build(workbook)
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/** 送进 Workbook 的那份 data（只看第一张表的第一格值） */
function firstCellValue(): unknown {
  const data = workbookProps.at(-1)?.data as
    Array<{ celldata?: Array<{ r: number; c: number; v: { v?: unknown } }> }> | undefined
  return data?.[0]?.celldata?.find((item) => item.r === 0 && item.c === 0)?.v?.v
}

beforeEach(() => {
  workbookProps.length = 0
  parseMock.mockClear()
})

describe('ExcelPreview：送进 FortuneSheet 的只读配置', () => {
  it('csv：不编辑 / 不摆工具栏 / 右键只留复制 / 语言中文 / 数据是解析出来的那张表', async () => {
    render(<ExcelPreview bytes={csv('姓名,年龄\n张三,28\n')} filename="名单.csv" />)

    const root = await screen.findByTestId('excel-preview')
    expect(root).toHaveAttribute('data-excel-preview')
    expect(root).toHaveAttribute('aria-label', EXCEL_TEXT.title)
    expect(screen.queryByTestId('excel-preview-notice')).toBeNull()
    expect(screen.queryByTestId('excel-preview-formula-warning')).toBeNull()

    await screen.findByTestId('fortune-workbook')
    const props = workbookProps.at(-1)
    expect(props?.allowEdit).toBe(false)
    expect(props?.showToolbar).toBe(false)
    expect(props?.showFormulaBar).toBe(true)
    expect(props?.showSheetTabs).toBe(true)
    expect(props?.forceCalculation).toBe(false)
    expect(props?.cellContextMenu).toEqual(['copy'])
    expect(props?.headerContextMenu).toEqual([])
    expect(props?.sheetTabContextMenu).toEqual([])
    expect(props?.filterContextMenu).toEqual([])
    expect(props?.lang).toBe('zh')
    expect((props?.data as Array<{ name?: string }>)[0]?.name).toBe('CSV')
  })

  it('换文件（新 bytes）时旧那一份不许留在屏上', async () => {
    const { rerender } = render(<ExcelPreview bytes={csv('a\n')} filename="a.csv" />)
    await screen.findByTestId('fortune-workbook')
    expect(firstCellValue()).toBe('a')

    rerender(<ExcelPreview bytes={csv('b\n')} filename="b.csv" />)
    expect(screen.queryByTestId('fortune-workbook')).toBeNull()

    await screen.findByTestId('fortune-workbook')
    expect(firstCellValue()).toBe('b')
  })
})

describe('ExcelPreview：两条提示', () => {
  it('带公式摆警告、含图片摆不支持提示，书照样画出来', async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet('汇总')
      sheet.getCell('A1').value = { formula: 'B1*2', result: 2 }
      const imageId = workbook.addImage({
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        extension: 'png'
      })
      sheet.addImage(imageId, 'C1:D2')
    })
    render(<ExcelPreview bytes={bytes} filename="汇总.xlsx" />)

    expect(await screen.findByTestId('excel-preview-formula-warning')).toHaveAttribute(
      'aria-label',
      EXCEL_TEXT.formulaWarning
    )
    await waitFor(() => {
      expect(screen.getByTestId('excel-preview-notice')).toHaveTextContent('图片')
    })
    expect(await screen.findByTestId('fortune-workbook')).toBeInTheDocument()
  })
})

describe('ExcelPreview：失败各说各的人话', () => {
  it('认不出的后缀：给 invalid 人话，不摆表格', async () => {
    render(<ExcelPreview bytes={csv('a\n')} filename="说明.txt" />)
    expect(await screen.findByTestId('excel-preview-error')).toHaveTextContent(EXCEL_TEXT.invalid)
    expect(screen.queryByTestId('fortune-workbook')).toBeNull()
  })

  it('解不开的 xlsx：给 invalid 人话 + 重试；点重试仍不假成功', async () => {
    render(<ExcelPreview bytes={new Uint8Array([1, 2, 3])} filename="坏表.xlsx" />)
    expect(await screen.findByTestId('excel-preview-error')).toHaveTextContent(EXCEL_TEXT.invalid)
    expect(screen.queryByTestId('fortune-workbook')).toBeNull()

    fireEvent.click(screen.getByTestId('excel-preview-retry'))
    await waitFor(() => {
      expect(screen.getByTestId('excel-preview-error')).toHaveTextContent(EXCEL_TEXT.invalid)
    })
    expect(screen.queryByTestId('fortune-workbook')).toBeNull()
  })

  it('Worker 起不来（解析入口回 worker）→ 说清是可重试的失败，并摆重试按钮', async () => {
    parseMock.mockRejectedValueOnce(new ExcelPreviewError('worker'))
    render(<ExcelPreview bytes={csv('a,b\n')} filename="名单.csv" />)

    expect(await screen.findByTestId('excel-preview-error')).toHaveTextContent(EXCEL_TEXT.worker)
    expect(screen.getByTestId('excel-preview-retry')).toBeInTheDocument()
    expect(screen.queryByTestId('fortune-workbook')).toBeNull()
  })

  it('越过上限（limits 传进来的 maxCells）：说清楚是超限', async () => {
    render(<ExcelPreview bytes={csv('a,b\n1,2\n')} filename="名单.csv" limits={{ maxCells: 2 }} />)
    expect(await screen.findByTestId('excel-preview-error')).toHaveTextContent(EXCEL_TEXT.tooLarge)
  })
})
