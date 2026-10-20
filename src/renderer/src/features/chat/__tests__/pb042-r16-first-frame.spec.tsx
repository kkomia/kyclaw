import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TextPart } from '../parts/TextPart'
import { nextFrame } from './next-frame'

/**
 * PB-042（R16「代码块首帧空白」）聚焦回归：
 * **code-block 第一次插入 DOM 的那一帧就必须带 shiki 高亮结构 + 正确正文**，
 * 不允许先挂一个空壳 / 纯文本 `<pre>`，再等异步高亮填进去（那就是用户看到的「首帧空白」）。
 *
 * 采样口径与线上 R16 一致（`e2e/_cyrus-r16-timeline.spec.ts`、
 * `e2e/_nia-r0x-real-sampling.spec.ts` 的 R16 用例）：用 MutationObserver 记录 DOM 变更时间线，
 * 只看 code-block 第一次出现在 document 里时的快照。
 *
 * 修复前的红（0.2.1 线上探针实测，`.superpowers/dev-verify/20261020-0.2.1/cyrus/r16-timeline.json`）：
 *   - 第一个快照：`data-highlighted="false"`、`pre > code` 的 innerHTML 为空（流式围栏刚开）；
 *   - 约 58ms 后才有第二个快照：`data-highlighted="true"` + shiki 结构。
 * 本 spec 钉住的正是「第一个快照」：`firstHtml=''` / 纯文本 / `data-highlighted="false"` 即红。
 *
 * 为什么用 DOM 时间线而不是 waitFor 最终态：「最终能高亮」一直是对的，缺陷只在第一帧。
 */

interface CodeBlockFrame {
  /** `pre > code` 的 innerHTML —— R16 判据看的就是它（shiki token 内联色在这里） */
  html: string
  /** `pre > code` 的可见正文（应逐字等于代码内容） */
  codeText: string
  /** code-block 根节点的 data-highlighted */
  highlighted: string | null
  /** pre.shiki 结构 + token 内联色（css-variables 主题 → var(--shiki-token-*)） */
  hasShikiStructure: boolean
}

interface Timeline {
  /** code-block 在 document 里出现过的每个「不同快照」，按时间先后 */
  frames: CodeBlockFrame[]
  /** code-block 插入 / 移除 document 的次数（R16 要求 inserted=1、removed=0，不许重挂） */
  counts: { inserted: number; removed: number }
  stop: () => void
}

function readCodeBlockFrame(): CodeBlockFrame | null {
  const block = document.querySelector<HTMLElement>('[data-testid="code-block"]')
  if (block === null) return null
  const pre = block.querySelector('pre')
  const code = block.querySelector('pre code')
  const html = code?.innerHTML ?? ''
  return {
    html,
    codeText: code?.textContent ?? '',
    highlighted: block.getAttribute('data-highlighted'),
    hasShikiStructure:
      pre?.classList.contains('shiki') === true && /var\(--shiki-token-/u.test(html)
  }
}

/** 装一个「code-block 首次上屏」时间线探针（与 R16 e2e 的 MutationObserver 同口径）。 */
function watchCodeBlockTimeline(): Timeline {
  const frames: CodeBlockFrame[] = []
  const counts = { inserted: 0, removed: 0 }
  let lastSignature: string | null = null

  const record = (): void => {
    const frame = readCodeBlockFrame()
    if (frame === null) return
    const signature = `${frame.highlighted ?? ''}\u0000${frame.html}`
    if (signature === lastSignature) return
    lastSignature = signature
    frames.push(frame)
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        const element = node as Element
        counts.inserted += [
          ...(element.matches?.('[data-testid="code-block"]') === true ? [element] : []),
          ...(element.querySelectorAll?.('[data-testid="code-block"]') ?? [])
        ].length
      }
      for (const node of mutation.removedNodes) {
        const element = node as Element
        if (element.matches?.('[data-testid="code-block"]') === true) counts.removed += 1
      }
    }
    record()
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-highlighted']
  })
  // 已经挂在 DOM 里的话也记一笔（本 spec 里正常不会发生，留着防止探针漏采）
  record()
  return { frames, counts, stop: () => observer.disconnect() }
}

/** R16 判据（**不放宽**）：第一次插入 DOM 的帧里 innerHTML 非空、带 shiki 结构、正文正确。 */
function expectFirstFrameHighlighted(
  frame: CodeBlockFrame | undefined,
  expectedCode: string
): void {
  expect(frame, 'code-block 从未插入 DOM，时间线采不到第一帧').toBeDefined()
  if (frame === undefined) return
  expect(frame.highlighted, '首次插入帧 data-highlighted 必须是 true').toBe('true')
  expect(frame.html.length, '首次插入帧 pre > code 的 innerHTML 不能为空').toBeGreaterThan(0)
  expect(
    frame.hasShikiStructure,
    `首次插入帧必须是 shiki 结构（pre.shiki + var(--shiki-token-*)），实际 html=${JSON.stringify(
      frame.html.slice(0, 160)
    )}`
  ).toBe(true)
  expect(frame.codeText, '首次插入帧的可见正文必须是代码本身').toBe(expectedCode)
}

describe('PB-042 R16：代码块首帧即带 shiki 高亮结构', () => {
  it('整篇渲染：第一次插入 DOM 的帧就是 shiki 结构（不先出纯文本）', async () => {
    const timeline = watchCodeBlockTimeline()
    try {
      render(<TextPart text={'看这段代码：\n\n```ts\nconst answer: number = 42\n```'} />)

      await waitFor(() => expect(timeline.frames.length).toBeGreaterThan(0))
      expectFirstFrameHighlighted(timeline.frames[0], 'const answer: number = 42')
      expect(timeline.counts.inserted).toBe(1)
      expect(timeline.counts.removed).toBe(0)
    } finally {
      timeline.stop()
    }
  })

  it('流式：围栏先开、代码后到时，第一个 code-block 帧就是带内容的 shiki 结构（空围栏不许落 DOM）', async () => {
    const timeline = watchCodeBlockTimeline()
    try {
      // 复刻 R16 线上时序：先来 "看这段代码：\n```ts\n"（围栏已开、代码还没到）……
      const view = render(<TextPart text={'看这段代码：\n```ts\n'} streaming />)
      await nextFrame()
      // 修复前：空围栏这一帧就把 data-highlighted="false"、innerHTML="" 的 code-block 挂上 DOM
      view.rerender(<TextPart text={'看这段代码：\n```ts\nconst a = 1\n'} streaming />)
      await nextFrame()
      view.rerender(<TextPart text={'看这段代码：\n```ts\nconst a = 1\n```'} streaming />)

      await waitFor(() => expect(timeline.frames.length).toBeGreaterThan(0))
      expectFirstFrameHighlighted(timeline.frames[0], 'const a = 1')
      expect(timeline.counts.inserted, 'code-block 只该插入一次（不许重挂）').toBe(1)
      expect(timeline.counts.removed).toBe(0)
    } finally {
      timeline.stop()
    }
  })

  it('高亮器就绪后：新代码块同步渲染成 shiki（不等 promise，不闪纯文本）', async () => {
    // 先把高亮器焐热（第一条代码块等它加载完）
    const warm = render(<TextPart text={'```ts\nconst hot = 1\n```'} />)
    await waitFor(() =>
      expect(warm.container.querySelector('[data-testid="code-block"]')).not.toBeNull()
    )
    warm.unmount()

    // 换一段**没在缓存里**的代码：高亮器已就绪 → render 返回时 DOM 就该是高亮结构
    const fresh = render(<TextPart text={'```ts\nconst cold = 2\n```'} />)
    const block = fresh.container.querySelector<HTMLElement>('[data-testid="code-block"]')
    expect(block, '高亮器就绪时首帧必须有 code-block').not.toBeNull()
    expect(block?.getAttribute('data-highlighted')).toBe('true')
    const code = block?.querySelector('pre code')
    expect(code?.textContent).toBe('const cold = 2')
    expect(/var\(--shiki-token-/u.test(code?.innerHTML ?? '')).toBe(true)
  })
})
