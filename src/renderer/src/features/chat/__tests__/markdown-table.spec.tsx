import { readFileSync } from 'node:fs'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TextPart } from '../parts/TextPart'
import { tableFileName, tableSourceOf } from '../parts/MarkdownTable'

/**
 * 0.1.3 · 007：回复里的表格 —— 圆角外壳 + 横向滚动 + 复制 / 下载。
 *
 * 这一组的重点是**导出的是哪段文本**：必须是消息里这段 Markdown 原文（转义 `\|`、对齐记号、
 * 行内代码原样），不是把页面上看到的字拼回去 —— 所以断言全是与源文本**逐字节相等**，
 * 另外单点一句"页面上的字里没有反斜杠"当反证。
 *
 * 流式那一段钉两件事：① 操作行的 DOM 在流式与整篇两条渲染路上**逐字节一致**（按钮靠 CSS 收起，
 * 不是条件渲染）——这是"结束后出现"不打断 round 73 保真度的前提；② 表格所在那一块被新 delta
 * 重渲染之后，表格的 DOM 节点仍不换身份（模块级 components 表 + memo 化分块没被这套东西打穿）。
 *
 * 真浏览器里的"流式期间不可见 / 结束后可见 / 窄窗真出横向滚动 / 真剪贴板与真下载"在
 * e2e/_r95-table-actions.spec.ts 里用真 Electron 核（jsdom 不套样式表，这里测不了可见性）。
 */

/** 带转义管道、对齐记号、行内代码的表 —— 每一项都可能是"重建派"丢东西的地方 */
const TABLE_A = [
  '| 列一 | 列二\\|乙 |',
  '| :--- | ---: |',
  '| `a\\|b` | *重点* |',
  '| 甲 | 乙 |'
].join('\n')

const TABLE_B = ['| 名称 | 数量 |', '| --- | --- |', '| 苹果 | 3 |'].join('\n')

const DOC = ['开头段落。', '', TABLE_A, '', '中间一段。', '', TABLE_B, '', '结尾。'].join('\n')

let writeText: ReturnType<typeof vi.fn>

/** 下载壳子的替身：Blob、anchor 上的文件名、URL 释放各留一份证 */
function stubDownload(): {
  blobs: Blob[]
  anchors: Array<{ href: string; download: string }>
  revoke: ReturnType<typeof vi.fn>
} {
  const blobs: Blob[] = []
  const anchors: Array<{ href: string; download: string }> = []
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn((blob: Blob) => {
      blobs.push(blob)
      return `blob:kyclaw-${blobs.length}`
    }),
    configurable: true
  })
  const revoke = vi.fn()
  Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ): void {
    anchors.push({ href: this.href, download: this.download })
  })
  return { blobs, anchors, revoke }
}

beforeEach(() => {
  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('表格：外壳与操作按钮', () => {
  it('整张表套在圆角外壳里，表格在横向滚动口内', () => {
    render(<TextPart text={DOC} streaming={false} />)

    const shell = screen.getAllByTestId('markdown-table')[0]
    expect(shell).toHaveClass('markdown-table-shell')
    const scroll = within(shell!).getByTestId('markdown-table-scroll')
    expect(scroll).toHaveClass('markdown-table-scroll')
    expect(scroll).toContainElement(within(shell!).getByRole('table'))
  })

  it('两个按钮是纯 SVG（无可见文字），名字在 aria-label / tooltip 上', async () => {
    render(<TextPart text={TABLE_A} streaming={false} />)

    const copy = screen.getByTestId('table-copy')
    const download = screen.getByTestId('table-download')
    expect(copy).toHaveAttribute('aria-label', '复制表格 Markdown')
    expect(download).toHaveAttribute('aria-label', '下载表格 .md')
    // 无可见文字：按钮自己的文本为空，图标在 svg 里
    expect(copy.textContent).toBe('')
    expect(download.textContent).toBe('')
    expect(copy.querySelector('svg')).not.toBeNull()
    expect(download.querySelector('svg')).not.toBeNull()
    // tooltip：聚焦触发元素浮出同一条文案
    fireEvent.focus(copy)
    expect(await screen.findByText('复制表格 Markdown')).toBeInTheDocument()
  })
})

describe('范围：只在回复流里开，别的宿主一个字节不变', () => {
  it('回复流（Message.tsx 的调用点形状：显式传 streaming）→ 圆角外壳 + 复制 / 下载', () => {
    render(<TextPart text={TABLE_A} streaming={false} />)

    expect(screen.getByTestId('markdown-table')).toBeInTheDocument()
    expect(screen.getByTestId('table-copy')).toBeInTheDocument()
  })

  it('其他宿主（只传 text：计划卡 / 记忆页 / 轨迹详情）→ 表格是默认元素，没有外壳也没有按钮', () => {
    const view = render(<TextPart text={TABLE_A} />)

    expect(screen.queryByTestId('markdown-table')).toBeNull()
    expect(screen.queryByTestId('table-copy')).toBeNull()
    expect(screen.queryByTestId('table-download')).toBeNull()
    // 结构上也没变：表格仍是 .markdown-body 的直接子元素（没有中间那层外壳）
    const table = screen.getByRole('table')
    expect(table.parentElement).toBe(view.container.querySelector('[data-testid="message-text"]'))
    expect(table.closest('.markdown-table-shell')).toBeNull()
  })

  it('显式 tables 覆盖调用点默认（开 / 关两边都以显式为准）', () => {
    const doc = render(<TextPart text={TABLE_A} tables />)
    expect(screen.getByTestId('markdown-table')).toBeInTheDocument()
    doc.unmount()

    render(<TextPart text={TABLE_A} streaming={false} tables={false} />)
    expect(screen.queryByTestId('markdown-table')).toBeNull()
  })
})

describe('复制：内容是那段 Markdown 原文', () => {
  it('转义、对齐记号、行内代码逐字节保留；页面上的字里并没有反斜杠', async () => {
    render(<TextPart text={DOC} streaming={false} />)

    fireEvent.click(screen.getAllByTestId('table-copy')[0]!)

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith(TABLE_A)
    expect(TABLE_A).toContain('\\|')
    expect(TABLE_A).toContain(':---')
    // 反证：这行里的转义在页面上是被消化的（`a\|b` 渲染成 code a|b），所以"从页面上重建"必然对不上
    const rendered = screen.getAllByRole('table')[0]?.textContent ?? ''
    expect(rendered).not.toContain('\\|')
  })

  it('多张表各复制各的，互不串台', async () => {
    render(<TextPart text={DOC} streaming={false} />)

    const shells = screen.getAllByTestId('markdown-table')
    expect(shells).toHaveLength(2)
    expect(within(shells[0]!).getByRole('table')).toHaveTextContent('列一')
    expect(within(shells[1]!).getByRole('table')).toHaveTextContent('名称')

    fireEvent.click(within(shells[1]!).getByTestId('table-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TABLE_B))
    expect(writeText.mock.calls[0]?.[0]).not.toContain('列一')

    fireEvent.click(within(shells[0]!).getByTestId('table-copy'))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(TABLE_A))
    expect(writeText.mock.calls[1]?.[0]).not.toContain('名称')
  })

  it('成功反馈 2s 后自清（与代码块复制同一口径）', async () => {
    vi.useFakeTimers()
    render(<TextPart text={TABLE_A} streaming={false} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('table-copy'))
    })
    expect(screen.getByTestId('table-status')).toHaveTextContent('已复制')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByTestId('table-status').textContent).toBe('')
  })

  it('剪贴板拒绝时留下可读的失败反馈（不假装成功，也不自己消失）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    writeText.mockRejectedValueOnce(new Error('denied'))
    render(<TextPart text={TABLE_A} streaming={false} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('table-copy'))
    })

    const status = screen.getByTestId('table-status')
    expect(status).toHaveTextContent('复制失败')
    expect(status).toHaveAttribute('data-tone', 'error')
    expect(status).toHaveAttribute('role', 'status')

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(status).toHaveTextContent('复制失败')
  })
})

describe('下载：.md 文件里就是那段原文', () => {
  it('Blob 内容 = 表格原文，文件名带表标识与本地时间戳，objectURL 用完就放', async () => {
    const { blobs, anchors, revoke } = stubDownload()
    render(<TextPart text={TABLE_A} streaming={false} />)

    fireEvent.click(screen.getByTestId('table-download'))

    await waitFor(() => expect(blobs).toHaveLength(1))
    expect(blobs[0]?.type).toBe('text/markdown;charset=utf-8')
    expect(await blobs[0]?.text()).toBe(TABLE_A)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]?.href ?? '').toContain('blob:kyclaw-1')
    expect(anchors[0]?.download).toMatch(/^kyclaw-表格-列一-\d{8}-\d{6}\.md$/)
    expect(revoke).toHaveBeenCalledWith('blob:kyclaw-1')
    expect(await screen.findByText('已开始下载')).toBeInTheDocument()
    // 文案口径：只说"开始"，不冒充落盘成功 —— 渲染端拿不到下载完成 / 取消的结果，
    // 真机上另存为对话框被取消时，这里也不会有"保存成功"那种反向说法
    expect(screen.getByTestId('table-status').textContent ?? '').not.toMatch(
      /已保存|保存成功|下载完成|下载成功/
    )
  })

  it('多张表下载的文件名分得开（表头第一格当标识）', () => {
    expect(tableFileName(TABLE_A, new Date(2026, 9, 16, 12, 34, 56))).toBe(
      'kyclaw-表格-列一-20261016-123456.md'
    )
    expect(tableFileName(TABLE_B, new Date(2026, 9, 16, 12, 34, 57))).toBe(
      'kyclaw-表格-名称-20261016-123457.md'
    )
  })

  it('表头里的非法文件名字符与行内记号不进文件名', () => {
    const weird = ['| 报告/终稿: 二版 | `x` |', '| --- | --- |', '| a | b |'].join('\n')
    expect(tableFileName(weird, new Date(2026, 9, 16, 0, 0, 0))).toBe(
      'kyclaw-表格-报告终稿-二版-20261016-000000.md'
    )
  })

  it('落盘本身失败时留下可读的失败反馈', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => {
        throw new Error('no blob')
      }),
      configurable: true
    })
    render(<TextPart text={TABLE_A} streaming={false} />)

    fireEvent.click(screen.getByTestId('table-download'))

    const status = await screen.findByTestId('table-status')
    await waitFor(() => expect(status).toHaveTextContent('下载失败'))
    expect(status).toHaveAttribute('data-tone', 'error')
  })
})

describe('切原文（tableSourceOf）', () => {
  it('按 position 的两个偏移切，末位不含表格后的换行', () => {
    const source = ['前言。', '', TABLE_A, '', '后记。'].join('\n')
    const start = source.indexOf('| 列一')
    const end = start + TABLE_A.length
    expect(
      tableSourceOf(source, { position: { start: { offset: start }, end: { offset: end } } })
    ).toBe(TABLE_A)
  })

  it('没有节点 / 没有位置 / 越界 → null（调用方禁用按钮，不猜内容）', () => {
    expect(tableSourceOf(TABLE_A, undefined)).toBeNull()
    expect(tableSourceOf(TABLE_A, {})).toBeNull()
    expect(tableSourceOf(TABLE_A, { position: { start: { offset: 1 } } })).toBeNull()
    expect(
      tableSourceOf(TABLE_A, { position: { start: { offset: 2 }, end: { offset: 9999 } } })
    ).toBeNull()
    expect(
      tableSourceOf(TABLE_A, { position: { start: { offset: 3 }, end: { offset: 3 } } })
    ).toBeNull()
  })

  it('没有源文本 → null', () => {
    expect(
      tableSourceOf(null, { position: { start: { offset: 0 }, end: { offset: 4 } } })
    ).toBeNull()
  })
})

describe('流式：不开放操作，也不打断分块', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  })

  function htmlOf(view: ReturnType<typeof render>): string {
    return view.container.querySelector('[data-testid="message-text"]')?.innerHTML ?? ''
  }

  function advanceFrame(): void {
    act(() => {
      vi.advanceTimersByTime(20)
    })
  }

  /**
   * 流式用的正文：`## 说明` 前有空行 = 真切点（切成两块），表格落在**最后一块**里 ——
   * 后面每追加一句都会让表格所在那一块重渲染，正是"每帧重建组件会不会把表整棵重挂"要压的面。
   */
  const STREAMED = ['开头。', '', '## 说明', '', '前言。', '', TABLE_A].join('\n')

  it('流式与整篇两条渲染路的 DOM 逐字节一致（按钮是靠 CSS 收起的）', () => {
    const view = render(<TextPart text={STREAMED} streaming />)
    advanceFrame()
    const streamed = htmlOf(view)
    view.unmount()

    const whole = render(<TextPart text={STREAMED} streaming={false} />)
    expect(streamed).toBe(htmlOf(whole))
    // 操作行两条路都在（收/放只由 .markdown-body[data-streaming] 那条 CSS 决定）
    expect(whole.container.querySelector('[data-testid="table-actions"]')).not.toBeNull()
  })

  it('流式期间根上带 data-streaming，流一停就没了（按钮随之出现）', () => {
    const view = render(<TextPart text={STREAMED} streaming />)
    advanceFrame()
    expect(screen.getByTestId('message-text')).toHaveAttribute('data-streaming', 'true')

    view.rerender(<TextPart text={STREAMED} streaming={false} />)
    expect(screen.getByTestId('message-text')).not.toHaveAttribute('data-streaming')
    expect(screen.getByTestId('table-copy')).toBeInTheDocument()
  })

  it('流式里继续追加：表格那一块重渲染了，但表本身没被重挂', () => {
    const view = render(<TextPart text={STREAMED} streaming />)
    advanceFrame()

    const shell = screen.getByTestId('markdown-table')
    const table = screen.getByRole('table')

    // 一条新 delta：表格所在那一块的 text 变了 → 这一块会重解析、重渲染
    view.rerender(<TextPart text={`${STREAMED}\n\n继续推一句。`} streaming />)
    advanceFrame()
    expect(screen.getByTestId('message-text').textContent).toContain('继续推一句。')

    // 两个 DOM 节点还是原来那两个：组件类型是模块级的，只更新不重挂
    expect(screen.getByTestId('markdown-table')).toBe(shell)
    expect(screen.getByRole('table')).toBe(table)
  })
})

/**
 * 读样式源文件：**路径经参数传进来** —— 直接写 `new URL('../../../styles/markdown.css', import.meta.url)`
 * 会被 Vite 静态改写成"资源地址"（测试里就成了非 file 协议），readFileSync 会以
 * "The URL must be of scheme file" 整份 suite 红掉（composer.spec.tsx 同一写法同一缘由）。
 */
function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

describe('markdown.css 的表格口径（jsdom 不套样式表，这里钉规则本身）', () => {
  const css = readSource('../../../styles/markdown.css')
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')

  it('圆角外壳 + 整圈 hairline + 裁切', () => {
    expect(body).toMatch(/\.markdown-table-shell\s*\{[^}]*border-radius:\s*var\(--radius-panel\)/)
    expect(body).toMatch(
      /\.markdown-table-shell\s*\{[^}]*border:\s*var\(--border-width-hairline\)\s+solid/
    )
    expect(body).toMatch(/\.markdown-table-shell\s*\{[^}]*overflow:\s*hidden/)
  })

  it('横滚口保留作兜底 + 单元格折行（PB-025：极端宽表也强制折行到可视宽度）', () => {
    expect(body).toMatch(/\.markdown-table-scroll\s*\{[^}]*overflow-x:\s*auto/)
    expect(body).toMatch(
      /\.markdown-table-scroll th,\s*\.markdown-table-scroll td\s*\{[^}]*white-space:\s*normal/
    )
    expect(body).toMatch(
      /\.markdown-table-scroll th,\s*\.markdown-table-scroll td\s*\{[^}]*overflow-wrap:\s*anywhere/
    )
  })

  it('流式期间操作行收起：判据挂在 .markdown-body[data-streaming] 上', () => {
    expect(body).toMatch(
      /\.markdown-body\[data-streaming='true'\]\s*\.markdown-table-head\s*\{[^}]*display:\s*none/
    )
  })

  it('整圈边框的归属：外框归外壳，表格只留内部网格（外缘用行内方向逻辑属性去掉）', () => {
    expect(body).toMatch(
      /\.markdown-table-scroll tr > :first-child\s*\{[^}]*border-inline-start:\s*none/
    )
    expect(body).toMatch(
      /\.markdown-table-scroll tr > :last-child\s*\{[^}]*border-inline-end:\s*none/
    )
    expect(body).toMatch(
      /\.markdown-table-scroll thead > tr:first-child > \*\s*\{[^}]*border-top:\s*none/
    )
  })

  it('按钮：hover 用填充档表达，不画装饰性单边线', () => {
    expect(body).toMatch(
      /\.markdown-table-tool:hover\s*\{[^}]*background-color:\s*var\(--fill-hover\)/
    )
    expect(body).not.toMatch(/border-right|border-left/)
  })
})
