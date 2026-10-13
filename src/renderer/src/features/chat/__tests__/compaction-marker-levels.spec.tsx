import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CompactionMarker } from '@renderer/features/chat/CompactionMarker'
import type { CompactionLevel, ThreadCompaction } from '@shared/threads'

/**
 * round 76 · 分界线**按档分文案**（上一轮欠的那条）。
 *
 * 四档各自说自己在做什么（snip→已精简 / dedupe→已去重 / fold→已折叠 / summary→已压缩），
 * token 那一段四档共用；按钮也分档：摘要档「查看摘要」（有摘要可看），机械档「查看详情」
 * （展开的是"这次是怎么省的"说明）。老记录（没有 level）按摘要档解释——那时只有那一条路。
 *
 * 顺便钉一条：展开的说明里**不出现后端档位名**（snip / dedupe / fold 这些英文词是给代码看的，
 * 用户看到的是人话）。
 */
function recordOf(level: CompactionLevel | undefined): ThreadCompaction {
  return {
    threadId: 't-levels',
    summary: '这次没有调用模型：把较早的若干条工具结果换成了占位说明。',
    summarized: 6,
    kept: 10,
    ...(level === undefined ? {} : { level }),
    createdAt: new Date(2026, 9, 13, 12, 0, 0).toISOString(),
    tokensBefore: 527_000,
    tokensAfter: 53_700
  }
}

describe('round 76 · 分界线按档分文案', () => {
  it('四档各自的标签：已精简 / 已去重 / 已折叠 / 已压缩（token 那段不变）', () => {
    const cases: Array<[CompactionLevel, string]> = [
      ['snip', '上下文已精简（527k → ~53.7k tokens）'],
      ['dedupe', '上下文已去重（527k → ~53.7k tokens）'],
      ['fold', '上下文已折叠（527k → ~53.7k tokens）'],
      ['summary', '上下文已压缩（527k → ~53.7k tokens）']
    ]
    for (const [level, label] of cases) {
      const { unmount } = render(
        <CompactionMarker compaction={recordOf(level)} compacting={false} />
      )
      expect(screen.getByTestId('compaction-marker')).toHaveTextContent(label)
      unmount()
    }
  })

  it('老记录（没有 level）按摘要档：标签「上下文已压缩」、按钮「查看摘要」', () => {
    render(<CompactionMarker compaction={recordOf(undefined)} compacting={false} />)
    expect(screen.getByTestId('compaction-marker')).toHaveTextContent(
      '上下文已压缩（527k → ~53.7k tokens）'
    )
    expect(screen.getByTestId('compaction-view-summary')).toHaveTextContent('查看摘要')
  })

  it('按钮分档：摘要档「查看摘要」⇄「收起摘要」；机械档「查看详情」⇄「收起详情」', () => {
    const { unmount } = render(
      <CompactionMarker compaction={recordOf('summary')} compacting={false} />
    )
    fireEvent.click(screen.getByTestId('compaction-view-summary'))
    expect(screen.getByTestId('compaction-view-summary')).toHaveTextContent('收起摘要')
    unmount()

    for (const level of ['snip', 'dedupe', 'fold'] as const) {
      const view = render(<CompactionMarker compaction={recordOf(level)} compacting={false} />)
      const button = screen.getByTestId('compaction-view-summary')
      expect(button).toHaveTextContent('查看详情')
      // 展开内容沿用既有那一套（TraceFold + compaction-summary），不另造交互
      expect(screen.queryByTestId('compaction-summary')).not.toBeInTheDocument()
      fireEvent.click(button)
      expect(screen.getByTestId('compaction-summary')).toHaveTextContent(recordOf(level).summary)
      expect(screen.getByTestId('compaction-view-summary')).toHaveTextContent('收起详情')
      view.unmount()
    }
  })

  it('元数据行按档说做了什么（已精简 / 已去重 / 已折叠 / 已压缩 N 条消息）', () => {
    const cases: Array<[CompactionLevel, string]> = [
      ['snip', '已精简 6 条消息'],
      ['dedupe', '已去重 6 条消息'],
      ['fold', '已折叠 6 条消息'],
      ['summary', '已压缩 6 条消息']
    ]
    for (const [level, done] of cases) {
      const view = render(<CompactionMarker compaction={recordOf(level)} compacting={false} />)
      fireEvent.click(screen.getByTestId('compaction-view-summary'))
      const panel = screen.getByTestId('compaction-summary')
      expect(panel).toHaveTextContent(done)
      expect(panel).toHaveTextContent('保留最近 10 条')
      // 用户看到的只有人话：不出现档位名这类后端词汇
      expect(panel.textContent ?? '').not.toMatch(/snip|dedupe|fold|mechanical/i)
      view.unmount()
    }
  })

  it('token 读数缺任一：括号整段不显示，只留档位标签', () => {
    for (const level of ['snip', 'fold', 'summary'] as const) {
      const view = render(
        <CompactionMarker
          compaction={{ ...recordOf(level), tokensBefore: null, tokensAfter: null }}
          compacting={false}
        />
      )
      const marker = screen.getByTestId('compaction-marker')
      expect(marker).not.toHaveTextContent('tokens')
      expect(marker).toHaveTextContent(
        level === 'snip' ? '上下文已精简' : level === 'fold' ? '上下文已折叠' : '上下文已压缩'
      )
      view.unmount()
    }
  })
})
