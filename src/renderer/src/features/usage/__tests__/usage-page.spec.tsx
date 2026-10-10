import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { UsagePage } from '../UsagePage'

/**
 * 用量页（T14）：今日 / 本月切换、汇总数字、按模型拆分（含未知模型的占位显示）。
 * 数字口径的断言刻意写在"页面显示出来的字符串"上（千分位、$、≥、—），
 * 这样格式函数与页面接线一起被钉住。
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
  cost: 0.0042,
  costIncomplete: true,
  currency: 'USD',
  byModel: [
    {
      model: 'deepseek-flash',
      provider: 'deepseek',
      runs: 2,
      tokens: { input: 1000, output: 200, total: 1200 },
      cost: 0.0042
    },
    {
      model: 'kyclaw-test-mock',
      provider: 'kyclaw-test',
      runs: 1,
      tokens: { input: 200, output: 100, total: 300 },
      cost: null
    }
  ]
}

const MONTH = {
  range: 'month',
  tokens: { input: 20000, output: 5000, total: 25000 },
  cost: 1.5,
  costIncomplete: false,
  currency: 'USD',
  byModel: [
    {
      model: 'deepseek-flash',
      provider: 'deepseek',
      runs: 12,
      tokens: { input: 20000, output: 5000, total: 25000 },
      cost: 1.5
    }
  ]
}

const EMPTY = {
  range: 'today',
  tokens: { input: 0, output: 0, total: 0 },
  cost: null,
  costIncomplete: false,
  currency: 'USD',
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
    // 有未计价的行 → 合计带 "≥"，不把未知当 0
    expect(screen.getByTestId('usage-cost')).toHaveTextContent('≥ $0.0042')
    expect(screen.getByTestId('usage-tokens')).toHaveTextContent('1,500')

    expect(screen.getByTestId('usage-model-0-name')).toHaveTextContent('deepseek-flash')
    expect(screen.getByTestId('usage-model-0-cost')).toHaveTextContent('$0.0042')
    expect(screen.getByTestId('usage-model-0-tokens')).toHaveTextContent('1,200 Token')
    expect(screen.getByTestId('usage-model-0-runs')).toHaveTextContent('2 次')

    // 未知模型：花费占位，token 照记
    expect(screen.getByTestId('usage-model-1-name')).toHaveTextContent('kyclaw-test-mock')
    expect(screen.getByTestId('usage-model-1-cost')).toHaveTextContent('—')
    expect(screen.getByTestId('usage-model-1-tokens')).toHaveTextContent('300 Token')
  })

  it('切到本月：重新取数（range=month），汇总跟着换', async () => {
    const server = installFakeUsage({ today: TODAY, month: MONTH })
    render(<UsagePage />)
    await screen.findByTestId('usage-summary')

    fireEvent.click(screen.getByTestId('usage-range-month'))

    // 切窗口会重新取数：等新数字上屏（$1.50 只在本月档出现）
    await screen.findByText('25,000')
    expect(server.calls.at(-1)?.range).toBe('month')
    expect(screen.getByTestId('usage-cost')).toHaveTextContent('$1.50')
    expect(screen.getByTestId('usage-cost')).not.toHaveTextContent('≥')
    expect(screen.getByTestId('usage-tokens')).toHaveTextContent('25,000')
    expect(screen.getByTestId('usage-models').children).toHaveLength(2) // 标题 + 一行
    expect(screen.getByTestId('usage-range-month')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('usage-range-today')).toHaveAttribute('aria-pressed', 'false')
  })

  it('没有记录：给空态，合计显示占位而不是 0', async () => {
    installFakeUsage({ today: TODAY, month: MONTH }, true)
    render(<UsagePage />)

    expect(await screen.findByTestId('usage-empty')).toHaveTextContent('还没有用量记录')
    expect(screen.getByTestId('usage-cost')).toHaveTextContent('—')
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
})
