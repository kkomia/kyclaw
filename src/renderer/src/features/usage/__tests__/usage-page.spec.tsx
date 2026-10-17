import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { UsagePage } from '../UsagePage'

/**
 * 用量页（T14）：今日 / 本月切换、汇总数字、按模型拆分。
 * 数字口径的断言刻意写在"页面显示出来的字符串"上（千分位），
 * 这样格式函数与页面接线一起被钉住。
 *
 * 用户口径 014：这页只讲 token，不做计费 —— 服务端回包也**没有** cost 一类字段
 * （fixture 照真实回包同形，所以这里也不带），页面更没有可显示的金额。
 */
function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

const TODAY = {
  range: 'today',
  tokens: { input: 1200, output: 300, total: 1500 },
  byModel: [
    {
      model: 'deepseek-flash',
      provider: 'deepseek',
      runs: 2,
      tokens: { input: 1000, output: 200, total: 1200 }
    },
    {
      model: 'kyclaw-test-mock',
      provider: 'kyclaw-test',
      runs: 1,
      tokens: { input: 200, output: 100, total: 300 }
    }
  ]
}

const MONTH = {
  range: 'month',
  tokens: { input: 20000, output: 5000, total: 25000 },
  byModel: [
    {
      model: 'deepseek-flash',
      provider: 'deepseek',
      runs: 12,
      tokens: { input: 20000, output: 5000, total: 25000 }
    }
  ]
}

const EMPTY = {
  range: 'today',
  tokens: { input: 0, output: 0, total: 0 },
  byModel: []
}

interface FakeUsageServer {
  calls: { method: string; path: string; range: string | null }[]
  failNext(error: Error): void
}

function installFakeUsage(
  responses: { today: unknown; month: unknown },
  empty = false
): FakeUsageServer {
  const failures: Error[] = []
  const server: FakeUsageServer = {
    calls: [],
    failNext(error) {
      failures.push(error)
    }
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      server.calls.push({
        method: init.method ?? 'GET',
        path: url.pathname,
        range: url.searchParams.get('range')
      })
      const failure = failures.shift()
      if (failure !== undefined) throw failure

      if (url.pathname !== '/api/usage') throw new Error(`假服务没实现：${url.pathname}`)
      if (empty) return json(EMPTY)
      return json(url.searchParams.get('range') === 'month' ? responses.month : responses.today)
    })
  )
  return server
}

beforeEach(() => {
  installKyclawBridge()
})

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('用量页：今日', () => {
  it('默认窗口是今日：汇总与按模型拆分都按服务端数字显示', async () => {
    const server = installFakeUsage({ today: TODAY, month: MONTH })
    render(<UsagePage />)

    expect(screen.getByTestId('usage-loading')).toBeInTheDocument()
    expect(await screen.findByTestId('usage-summary')).toBeInTheDocument()

    expect(server.calls.at(-1)?.range).toBe('today')
    expect(screen.getByTestId('usage-tokens')).toHaveTextContent('1,500')

    expect(screen.getByTestId('usage-model-0-name')).toHaveTextContent('deepseek-flash')
    expect(screen.getByTestId('usage-model-0-tokens')).toHaveTextContent('1,200 Token')
    expect(screen.getByTestId('usage-model-0-runs')).toHaveTextContent('2 次')

    // 未知模型（不再有"计价"这回事）照记 token，各占一行
    expect(screen.getByTestId('usage-model-1-name')).toHaveTextContent('kyclaw-test-mock')
    expect(screen.getByTestId('usage-model-1-tokens')).toHaveTextContent('300 Token')
    expect(screen.queryByTestId('usage-cost')).not.toBeInTheDocument()
    expect(screen.queryByTestId('usage-model-0-cost')).not.toBeInTheDocument()
  })

  it('014：回包里若冒出 cost 一类计费字段，页面按取数失败处理（回包 schema 没留后门）', async () => {
    // 负向守卫：schema 是 strictObject —— 有人把 cost 加回回包时，这一条会红（汇总级与行级都试）
    installFakeUsage({ today: { ...TODAY, cost: 0.0042 }, month: MONTH })
    const summaryLevel = render(<UsagePage />)
    expect(await screen.findByTestId('usage-error')).toHaveTextContent('用量服务回包格式不对')
    summaryLevel.unmount()

    installFakeUsage({
      today: { ...TODAY, byModel: [{ ...TODAY.byModel[0], cost: 0.0042 }] },
      month: MONTH
    })
    render(<UsagePage />)
    expect(await screen.findByTestId('usage-error')).toHaveTextContent('用量服务回包格式不对')
  })

  it('014：计费相关的展示一个都没有（金额 / 币种 / 「≥」这类未计价口径）', async () => {
    installFakeUsage({ today: TODAY, month: MONTH })
    render(<UsagePage />)
    await screen.findByTestId('usage-summary')

    const text = screen.getByTestId('usage-page').textContent ?? ''
    expect(text).not.toContain('花费')
    expect(text).not.toContain('$')
    expect(text).not.toContain('≥')
  })

  it('切到本月：重新取数（range=month），汇总跟着换', async () => {
    const server = installFakeUsage({ today: TODAY, month: MONTH })
    render(<UsagePage />)
    await screen.findByTestId('usage-summary')

    fireEvent.click(screen.getByTestId('usage-range-month'))

    // 切窗口会重新取数：等新数字上屏（25,000 只在本月档出现；按汇总节点断言，
    // 因为按模型行的数字现在单独包了一层 mono 节点，纯文本查找会命中两处）
    await waitFor(() => expect(screen.getByTestId('usage-tokens')).toHaveTextContent('25,000'))
    expect(server.calls.at(-1)?.range).toBe('month')
    expect(screen.getByTestId('usage-tokens')).toHaveTextContent('25,000')
    expect(screen.getByTestId('usage-models').children).toHaveLength(2) // 标题 + 一行
    expect(screen.getByTestId('usage-range-month')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('usage-range-today')).toHaveAttribute('aria-pressed', 'false')
  })

  it('没有记录：给空态，合计显示 0', async () => {
    installFakeUsage({ today: TODAY, month: MONTH }, true)
    render(<UsagePage />)

    expect(await screen.findByTestId('usage-empty')).toHaveTextContent('还没有用量记录')
    expect(screen.getByTestId('usage-empty')).toHaveClass('font-serif')
    expect(screen.getByTestId('usage-tokens')).toHaveTextContent('0')
    expect(screen.queryByTestId('usage-models')).not.toBeInTheDocument()
  })

  it('取数失败：错误行 + 重试后成功', async () => {
    const server = installFakeUsage({ today: TODAY, month: MONTH })
    server.failNext(new Error('用量服务返回 500'))
    render(<UsagePage />)

    expect(await screen.findByTestId('usage-error')).toHaveTextContent('用量服务返回 500')

    fireEvent.click(screen.getByTestId('usage-retry'))

    expect(await screen.findByTestId('usage-summary')).toBeInTheDocument()
    expect(screen.getByTestId('usage-tokens')).toHaveTextContent('1,500')
  })

  it('数字排版（P2 字体统一）：用量/次数是 mono + tabular-nums，「Token/次」标签保持 sans', async () => {
    installFakeUsage({ today: TODAY, month: MONTH })
    render(<UsagePage />)
    await screen.findByTestId('usage-summary')

    // 总量：mono + tabular（等宽数字不跳动）
    const total = screen.getByTestId('usage-tokens')
    expect(total).toHaveClass('font-mono')
    expect(total).toHaveClass('tabular-nums')

    // 按模型行：数字单独包 mono+tabular，文本读数不变
    for (const testId of ['usage-model-0-tokens', 'usage-model-0-runs']) {
      const cell = screen.getByTestId(testId)
      const numeric = cell.querySelector('.tabular-nums')
      expect(numeric).not.toBeNull()
      expect(numeric).toHaveClass('font-mono')
    }
    expect(screen.getByTestId('usage-model-0-tokens')).toHaveTextContent('1,200 Token')
    expect(screen.getByTestId('usage-model-0-runs')).toHaveTextContent('2 次')
    expect(screen.getByTestId('usage-model-1-tokens')).toHaveTextContent('300 Token')
  })
})
