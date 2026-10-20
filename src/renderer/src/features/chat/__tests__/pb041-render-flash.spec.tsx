import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TextPart } from '../parts/TextPart'
import { CodeBlock } from '../parts/CodeBlock'

/**
 * PB-041（md 渲染闪烁）P0-A/P0-B 证据：
 *   - P0-A：同一代码块在 streaming true→false 时不重挂（DOM 节点引用不变）；
 *   - P0-B：Shiki 高亮结果模块级缓存——组件重挂时首帧就是高亮 HTML（不等 promise、不闪纯文本）。
 */
describe('PB-041 P0-A：结束态不换型、同一节点不重挂', () => {
  it('streaming → false 后 code-block DOM 节点引用保持不变', async () => {
    const text = '```ts\nconst a = 1\n```\n\n正文。'
    const { rerender } = render(<TextPart text={text} streaming />)
    // PB-042 起 code-block 在「高亮就绪 + 有正文」之前不落 DOM（首帧即高亮，不闪空），
    // 所以流式这一侧要先等它首次上屏；之后的断言仍是「同一节点、没有 unmount/remount」。
    const before = await screen.findByTestId('code-block')
    rerender(<TextPart text={text} streaming={false} />)
    const after = screen.getByTestId('code-block')
    expect(after).toBe(before)
  })
})

describe('PB-041 P0-B：Shiki 高亮缓存', () => {
  it('重挂时首帧直接是高亮 HTML（缓存命中，不闪纯文本）', async () => {
    const first = render(<CodeBlock code={'const a = 1'} language="ts" />)
    // 等第一次高亮完成（Shiki 就绪）
    await waitFor(() =>
      expect(first.container.querySelector('pre code')?.innerHTML ?? '').toContain('shiki')
    )
    first.unmount()

    const second = render(<CodeBlock code={'const a = 1'} language="ts" />)
    // 同步断言：不等 Promise，首帧就该是缓存里的高亮 HTML
    expect(second.container.querySelector('pre code')?.innerHTML ?? '').toContain('shiki')
  })
})
