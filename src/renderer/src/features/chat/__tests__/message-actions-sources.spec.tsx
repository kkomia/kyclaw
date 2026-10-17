import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Copy, RefreshCw } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { Citation } from '../citations'
import { Message } from '../Message'
import { MessageAction, MessageActions, MessageActionsDivider } from '../MessageActions'
import { SourcesAction, SourcesPanel } from '../SourcesPanel'

/**
 * 0.1.3 返工 · 网页来源入口 = 动作行里的 icon-only 按钮。
 *
 * 前半组钉组件契约；后半组直接渲染 **Message**（真实接线）：
 *   - 来源入口与复制 / 重新生成**同一容器**、顺序固定为
 *     复制 → 重新生成 → 单竖线 → 来源（来源入口在最后）；
 *   - 只有**一条**竖线分隔，且按钮互不嵌套（各自是动作容器的直接子节点）；
 *   - 入口零可见文字、不出现「引用」；点击只 toggle 列表，不触发复制 / 重新生成；
 *   - 展开列表留在消息末尾（交付卡之后、动作行上方），受控模式不再重复一枚入口；
 *   - 只有来源、没有复制 / 重新生成时动作行仍出现（showActions 包含来源）；
 *   - 没有来源时复制 / 重新生成的旧行为不变。
 */
const SOURCES: Citation[] = [
  {
    label: '1',
    url: 'https://example.org/paris',
    host: 'example.org',
    title: 'Paris - Wikipedia'
  }
]

const LIST_ID = 'sources-test-list'

function assistant(parts: UIMessage['parts'], id = 'a-sources'): UIMessage {
  return { id, role: 'assistant', parts }
}

function Harness({
  sources = SOURCES,
  onCopy,
  onRegenerate,
  regenerate = true
}: {
  sources?: Citation[]
  onCopy: () => void
  onRegenerate: () => void
  regenerate?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <article data-testid="message">
      <div data-testid="message-body">正文</div>
      <SourcesPanel sources={sources} open={open} listId={LIST_ID} />
      <MessageActions>
        <MessageAction testId="message-copy" label="复制" onClick={onCopy}>
          <Copy aria-hidden="true" className="size-4" />
        </MessageAction>
        {regenerate ? (
          <MessageAction testId="message-regenerate" label="重新生成" onClick={onRegenerate}>
            <RefreshCw aria-hidden="true" className="size-4" />
          </MessageAction>
        ) : null}
        {sources.length === 0 ? null : (
          <>
            <MessageActionsDivider />
            <SourcesAction
              sources={sources}
              open={open}
              onToggle={() => setOpen((value) => !value)}
              listId={LIST_ID}
            />
          </>
        )}
      </MessageActions>
    </article>
  )
}

describe('来源入口与动作行', () => {
  it('复制 重新生成 → 竖线 → 来源 同一行：顺序固定、三个按钮不嵌套', () => {
    render(<Harness onCopy={vi.fn()} onRegenerate={vi.fn()} />)

    const actions = screen.getByTestId('message-actions')
    const children = Array.from(actions.children).map(
      (node) => (node as HTMLElement).dataset.testid ?? null
    )
    expect(children).toEqual([
      'message-copy',
      'message-regenerate',
      'message-actions-divider',
      'sources-toggle'
    ])
    expect(within(actions).getAllByTestId('message-actions-divider')).toHaveLength(1)

    for (const button of within(actions).getAllByRole('button')) {
      expect(button.parentElement).toBe(actions)
    }

    const toggle = screen.getByTestId('sources-toggle')
    expect(toggle).toHaveAttribute('aria-label', '来源（1）')
    expect(toggle).toHaveAttribute('title', '来源（1）')
    expect(toggle).toHaveTextContent('')
    expect(toggle).not.toHaveTextContent('引用')
    expect(toggle.querySelector('svg')?.getAttribute('class')).toContain('lucide-globe')
  })

  it('非轮末（没有重新生成）：复制 → 竖线 → 来源，竖线仍只有一条', () => {
    render(<Harness onCopy={vi.fn()} onRegenerate={vi.fn()} regenerate={false} />)

    const actions = screen.getByTestId('message-actions')
    const children = Array.from(actions.children).map(
      (node) => (node as HTMLElement).dataset.testid ?? null
    )
    expect(children).toEqual(['message-copy', 'message-actions-divider', 'sources-toggle'])
    expect(within(actions).getAllByTestId('message-actions-divider')).toHaveLength(1)
    expect(within(actions).queryByTestId('message-regenerate')).toBeNull()
  })

  it('点击来源只 toggle 列表：不触发复制 / 重新生成；列表在动作行上方', () => {
    const onCopy = vi.fn()
    const onRegenerate = vi.fn()
    render(<Harness onCopy={onCopy} onRegenerate={onRegenerate} />)

    const toggle = screen.getByTestId('sources-toggle')
    const actions = screen.getByTestId('message-actions')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('sources-list')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByTestId('sources-list')
    expect(list).toHaveTextContent('Paris - Wikipedia')
    expect(list.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(onCopy).not.toHaveBeenCalled()
    expect(onRegenerate).not.toHaveBeenCalled()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('sources-list')).toBeNull()
  })

  it('复制 / 重新生成各管各的：点它们不会展开来源列表', () => {
    const onCopy = vi.fn()
    const onRegenerate = vi.fn()
    render(<Harness onCopy={onCopy} onRegenerate={onRegenerate} />)

    fireEvent.click(screen.getByTestId('message-copy'))
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(onRegenerate).not.toHaveBeenCalled()
    expect(screen.queryByTestId('sources-list')).toBeNull()

    fireEvent.click(screen.getByTestId('message-regenerate'))
    expect(onRegenerate).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('sources-list')).toBeNull()
  })

  it('没有来源：入口与竖线都不出现（复制 / 重新生成照常）', () => {
    render(<Harness sources={[]} onCopy={vi.fn()} onRegenerate={vi.fn()} />)

    expect(screen.queryByTestId('sources-toggle')).toBeNull()
    expect(screen.queryByTestId('message-actions-divider')).toBeNull()
    expect(screen.queryByTestId('sources-list')).toBeNull()
    expect(screen.getByTestId('message-copy')).toBeInTheDocument()
    expect(screen.getByTestId('message-regenerate')).toBeInTheDocument()
  })
})

const CITATION_TEXT = '巴黎人口 [1](https://example.org/paris "Paris - Wikipedia")。'

function citationMessage(id = 'a-sources'): UIMessage {
  return assistant([{ type: 'text', text: CITATION_TEXT }], id)
}

function actionTestIds(actions: HTMLElement): Array<string | null> {
  return Array.from(actions.children).map((node) => (node as HTMLElement).dataset.testid ?? null)
}

describe('Message 层：来源入口与动作行', () => {
  it('复制 重新生成 → 竖线 → 来源 同一行；展开列表在动作行上方且只有一枚入口', () => {
    const onRegenerate = vi.fn()
    render(
      <Message message={citationMessage()} citationSources={SOURCES} onRegenerate={onRegenerate} />
    )

    const actions = screen.getByTestId('message-actions')
    expect(actionTestIds(actions)).toEqual([
      'message-copy',
      'message-regenerate',
      'message-actions-divider',
      'sources-toggle'
    ])
    expect(within(actions).getAllByTestId('message-actions-divider')).toHaveLength(1)
    expect(screen.getAllByTestId('sources-toggle')).toHaveLength(1)
    expect(screen.queryByTestId('sources-panel')).toBeNull()

    const toggle = within(actions).getByTestId('sources-toggle')
    expect(toggle).toHaveTextContent('')
    expect(toggle).not.toHaveTextContent('引用')
    expect(toggle).toHaveAttribute('aria-label', '来源（1）')

    fireEvent.click(toggle)
    expect(onRegenerate).not.toHaveBeenCalled()
    expect(screen.getAllByTestId('sources-toggle')).toHaveLength(1)
    expect(screen.getByTestId('sources-panel')).toBeInTheDocument()
    const list = screen.getByTestId('sources-list')
    expect(list).toHaveTextContent('Paris - Wikipedia')
    expect(list.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('非轮末（没有重新生成）：复制 → 竖线 → 来源，竖线仍只有一条', () => {
    render(<Message message={citationMessage()} citationSources={SOURCES} />)

    const actions = screen.getByTestId('message-actions')
    expect(actionTestIds(actions)).toEqual([
      'message-copy',
      'message-actions-divider',
      'sources-toggle'
    ])
    expect(within(actions).getAllByTestId('message-actions-divider')).toHaveLength(1)
    expect(screen.queryByTestId('message-regenerate')).toBeNull()
  })

  it('只有来源、没有复制 / 重新生成：动作行仍出现，且只有入口、没有孤竖线', () => {
    render(<Message message={assistant([], 'a-only-source')} citationSources={SOURCES} />)

    const actions = screen.getByTestId('message-actions')
    expect(actionTestIds(actions)).toEqual(['sources-toggle'])
    expect(screen.queryByTestId('message-actions-divider')).toBeNull()
    expect(screen.queryByTestId('message-copy')).toBeNull()
    expect(screen.queryByTestId('message-regenerate')).toBeNull()

    fireEvent.click(screen.getByTestId('sources-toggle'))
    expect(screen.getByTestId('sources-list')).toBeInTheDocument()
  })

  it('没有来源：复制 / 重新生成保持原样，入口与竖线都不出现', () => {
    const onRegenerate = vi.fn()
    render(
      <Message
        message={assistant([{ type: 'text', text: '普通回答' }], 'a-plain')}
        onRegenerate={onRegenerate}
      />
    )

    const actions = screen.getByTestId('message-actions')
    expect(actionTestIds(actions)).toEqual(['message-copy', 'message-regenerate'])
    expect(screen.queryByTestId('sources-toggle')).toBeNull()
    expect(screen.queryByTestId('message-actions-divider')).toBeNull()
    expect(screen.queryByTestId('sources-panel')).toBeNull()

    fireEvent.click(screen.getByTestId('message-regenerate'))
    expect(onRegenerate).toHaveBeenCalledTimes(1)
  })

  it('展开列表在交付卡之后、动作行之前（消息末尾，不挤进正文）', () => {
    render(
      <Message
        message={citationMessage()}
        citationSources={SOURCES}
        deliverables={[{ path: 'docs/a.md', name: 'a.md', size: 10 }]}
      />
    )

    const actions = screen.getByTestId('message-actions')
    fireEvent.click(screen.getByTestId('sources-toggle'))
    const deliverables = screen.getByTestId('message-deliverables')
    const list = screen.getByTestId('sources-list')

    expect(
      deliverables.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(list.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
