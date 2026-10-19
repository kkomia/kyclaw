/**
 * PB-020：Excel 查找条（`components/XlsxFindBar.tsx`）交互单测。
 * 结论依据：上游 `@betteroffice/xlsx-react` 的 `searchMenus` 只回调宿主 `onSearchMenus`，
 * 真正的搜索能力是 `XlsxEditorApi.findText` —— 这个组件就是宿主侧的查找 UI。
 */
import { fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  XlsxFindBar,
  XLSX_FIND_DEBOUNCE_MS,
  type XlsxFindMatch,
  type XlsxFindOutcome
} from '../components/XlsxFindBar'

const MATCHES: XlsxFindMatch[] = [
  { a1: 'B2', text: '预算', sheetId: 's1', row: 1, col: 1 },
  { a1: 'D9', text: '预算表', sheetId: 's1', row: 8, col: 3 }
]

function setup(outcome: XlsxFindOutcome = { ok: true, matches: MATCHES, truncated: false }) {
  const search = vi.fn(async () => outcome)
  const onNavigate = vi.fn()
  const onClose = vi.fn()
  render(<XlsxFindBar open onClose={onClose} search={search} onNavigate={onNavigate} />)
  return { search, onNavigate, onClose }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('XlsxFindBar：输入 → 结果 → 上/下一个 → 关闭', () => {
  it('输入后防抖查询，自动跳到第 1 条并显示 1/2', async () => {
    vi.useFakeTimers()
    const { search, onNavigate } = setup()
    fireEvent.change(screen.getByTestId('xlsx-find-input'), { target: { value: '预算' } })
    expect(search).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(XLSX_FIND_DEBOUNCE_MS)
    })
    expect(search).toHaveBeenCalledWith('预算')
    expect(onNavigate).toHaveBeenCalledWith(MATCHES[0], 0)
    expect(screen.getByTestId('xlsx-find-count')).toHaveTextContent('1/2')
  })

  it('Enter 下一个 / Shift+Enter 上一个（循环）', async () => {
    vi.useFakeTimers()
    const { onNavigate } = setup()
    const input = screen.getByTestId('xlsx-find-input')
    fireEvent.change(input, { target: { value: '预算' } })
    await act(async () => {
      vi.advanceTimersByTime(XLSX_FIND_DEBOUNCE_MS)
    })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNavigate).toHaveBeenLastCalledWith(MATCHES[1], 1)
    expect(screen.getByTestId('xlsx-find-count')).toHaveTextContent('2/2')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNavigate).toHaveBeenLastCalledWith(MATCHES[0], 0)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onNavigate).toHaveBeenLastCalledWith(MATCHES[1], 1)
  })

  it('Esc 关闭；无结果时显示「无结果」且上/下一个禁用', async () => {
    vi.useFakeTimers()
    const { onClose } = setup({ ok: true, matches: [], truncated: false })
    const input = screen.getByTestId('xlsx-find-input')
    fireEvent.change(input, { target: { value: '不存在' } })
    await act(async () => {
      vi.advanceTimersByTime(XLSX_FIND_DEBOUNCE_MS)
    })
    expect(screen.getByTestId('xlsx-find-count')).toHaveTextContent('无结果')
    expect(screen.getByTestId('xlsx-find-next')).toBeDisabled()
    expect(screen.getByTestId('xlsx-find-prev')).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('清空输入后不再显示计数；截断时提示「仅前 1000 条」', async () => {
    vi.useFakeTimers()
    const { search } = setup({ ok: true, matches: MATCHES, truncated: true })
    const input = screen.getByTestId('xlsx-find-input')
    fireEvent.change(input, { target: { value: '预算' } })
    await act(async () => {
      vi.advanceTimersByTime(XLSX_FIND_DEBOUNCE_MS)
    })
    expect(screen.getByTestId('xlsx-find-count')).toHaveTextContent('仅前 1000 条')
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByTestId('xlsx-find-count')).toHaveTextContent('')
    expect(search).toHaveBeenCalledTimes(1)
  })
})
