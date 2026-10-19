import { Profiler } from 'react'
import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '../parts/CodeBlock'
import { TextPart } from '../parts/TextPart'

/**
 * round 73 探针：流式正文（markdown）渲染的单帧成本 —— **改前 / 改后同机同跑**的原始数字。
 *
 * 这是测量工具，不是回归用例。跑法（只跑这一个文件）：
 *
 *   node_modules/.bin/vitest run src/renderer/src/features/chat/__tests__/_r73-stream-perf.spec.tsx
 *
 * 数字用 console.table 打出来；断言只钉"探针本身跑得起来 + 结束时内容一致"，不钉耗时
 * （耗时绝对值随机器/环境漂，钉不住——要钉的是行为，见 text-streaming.spec.tsx）。
 *
 * ## 对照怎么来的
 *
 * `LegacyTextPart` 是 round 73 之前的实现（每次 delta 全量重解析）**原样冻结**在本文件里，
 * 于是改造之后仍然能在同一台机器、同一次运行里量出对照行；`TextPart` 是现在线上那一份。
 * 两者跑的是同一个 markdown 行程（remark-gfm + 自绘 CodeBlock/Shiki），差别只有"什么时候渲染"。
 *
 * ## 两种到达节奏（都要看，结论不一样）
 *
 *   - `同步突发`：一口气 294 条 delta（模拟"到达速率远高于帧率"的极端）；
 *   - `到达节奏`：每 4ms 一条（≈250 条/秒，贴近快模型 + SSE 的真实粒度）——这一行最接近实机。
 *
 * ## 口径与局限（报数字时必须一起说）
 *
 *   - 跑在 **jsdom** 里（口径要求：不起桌面客户端）。markdown 解析（micromark → React 元素）是纯 JS，
 *     与真实引擎同量级；jsdom 的 DOM 创建/属性写入比 Chromium 慢得多，**绝对数偏保守**，
 *     要看的是改前/改后的**比值**与"次数"；
 *   - 计时是 `performance.now()` 墙钟；Profiler 的 `actualDuration` 是 React 自报的 render 阶段耗时
 *     （节流后的渲染发生在 rAF 回调里，只有它能捕捉到，所以两个口径都要）；
 *   - 代码块的 Shiki 高亮是异步的（懒加载 + promise 链），不在这个同步循环里；它的**调度次数**
 *     跟着"内容变化次数"走（CodeBlock 的 code prop 只在 markdown 真重渲染时才变），单次成本见
 *     下面"Shiki 单次高亮成本"用例。
 */

const DELTA_COUNT = 294

/** 造一条长回复：24 节 × （标题 + 正文 + 表格 + 列表）+ 每 8 节一个代码块。约 485 行 / 12KB。 */
function buildReply(): string {
  const lines: string[] = ['# 流式渲染压测样本', '']
  for (let section = 1; section <= 24; section += 1) {
    lines.push(`## 第 ${section} 节：吞吐与延迟的取舍`, '')
    lines.push(
      `这一节用来说明第 ${section} 个要点：流式期间每一段增量都会重排一次布局，`,
      `所以真正要控制的是每帧重排的次数，而不是增量本身的条数。`,
      ''
    )
    lines.push('| 指标 | 改前 | 改后 | 说明 |', '| --- | --- | --- | --- |')
    for (let row = 1; row <= 6; row += 1) {
      lines.push(
        `| 指标 ${row} | ${row * 12}.3 | ${row}.5 | 第 ${section} 节的第 ${row} 行说明文字 |`
      )
    }
    lines.push('')
    lines.push(
      `- 要点一：增量到达速率与帧率解耦（第 ${section} 节）`,
      '- 要点二：结束时必须与最终文本一致，不能显示旧内容',
      ''
    )
    if (section % 8 === 0) {
      lines.push(
        '```ts',
        `export function section${section}(input: number): number {`,
        '  let total = 0'
      )
      for (let line = 1; line <= 18; line += 1) {
        lines.push(`  total += input * ${line} // 第 ${section} 节第 ${line} 行`)
      }
      lines.push('  return total', '}', '```', '')
    }
  }
  return lines.join('\n')
}

/** 把整篇按 ~等长切成 DELTA_COUNT 段（模拟 SSE 增量），返回每段累积后的全文 */
function cumulativeDeltas(text: string, count: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / count))
  const out: string[] = []
  for (let at = size; at < text.length; at += size) out.push(text.slice(0, at))
  out.push(text)
  return out
}

/* ------------------------------------------------------------------ 改前的实现（冻结） */

function LegacyPreBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const child = Array.isArray(children) ? children[0] : children
  if (child !== null && typeof child === 'object' && 'props' in child) {
    const codeProps = (child as { props: { className?: string; children?: React.ReactNode } }).props
    const language = /language-([\w-]+)/.exec(codeProps.className ?? '')?.[1]
    const code = String(codeProps.children ?? '').replace(/\n$/, '')
    return <CodeBlock code={code} language={language} />
  }
  return <pre>{children}</pre>
}

const LEGACY_COMPONENTS: Components = {
  pre: LegacyPreBlock,
  code: ({ children }) => <code className="font-mono">{children}</code>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

/** round 73 之前的 TextPart：每个 delta 都把累积全文交给 markdown 全量重解析 */
function LegacyTextPart({ text }: { text: string }): React.JSX.Element {
  return (
    <div data-testid="message-text" data-streaming="true" className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm]} components={LEGACY_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
}

/* ------------------------------------------------------------------ 测量 */

type Impl = 'legacy' | 'gated'

interface StreamSample {
  deltas: number
  /** DOM 文本真变了的次数 —— 用户看到内容变化（≈ markdown 真重解析 + Shiki 重排）的次数 */
  domChanges: number
  /** React 提交次数（Profiler onRender 次数） */
  commits: number
  /** 整条流的墙钟（含到达间隔） */
  elapsedMs: number
  /** 每个 delta 处理那一拍的墙钟：最坏 / p95 */
  maxDeltaMs: number
  p95DeltaMs: number
  /** 流式期间 Profiler 自报的 render 阶段成本：累计 / 最坏单次 / 每帧均值 */
  renderTotalMs: number
  renderMaxMs: number
  renderMeanMs: number
  /** 流结束那一下的整篇重画（round 73 的收尾：一次性、按设计就有） */
  settleMs: number
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function Harness({
  impl,
  text,
  streaming,
  onRender
}: {
  impl: Impl
  text: string
  streaming: boolean
  onRender: (duration: number) => void
}): React.JSX.Element {
  return (
    <Profiler id="stream" onRender={(_id, _phase, actualDuration) => onRender(actualDuration)}>
      {impl === 'legacy' ? (
        <LegacyTextPart text={text} />
      ) : (
        <TextPart text={text} streaming={streaming} />
      )}
    </Profiler>
  )
}

async function measureStream(
  impl: Impl,
  steps: string[],
  arrivalMs: number
): Promise<StreamSample> {
  const renderDurations: number[] = []
  const onRender = (duration: number): void => {
    renderDurations.push(duration)
  }
  const view = render(<Harness impl={impl} text="" streaming onRender={onRender} />)
  const node = view.container.querySelector('[data-testid="message-text"]')
  if (node === null) throw new Error('找不到 message-text')

  const deltaMs: number[] = []
  let domChanges = 0
  const started = performance.now()
  // 用 MutationObserver 数"屏幕内容真改了"的次数（一次微任务批次算一次）：比每次迭代读一遍
  // textContent（整棵子树序列化）便宜得多，不会把探针自己的开销算进流的总时长里。
  // 记数必须在**回调里**：takeRecords() 在回调跑过之后就拿不到那批了。
  const observer = new MutationObserver((records) => {
    if (records.length > 0) domChanges += 1
  })
  observer.observe(node, { childList: true, subtree: true, characterData: true })

  for (const text of steps) {
    const at = performance.now()
    view.rerender(<Harness impl={impl} text={text} streaming onRender={onRender} />)
    deltaMs.push(performance.now() - at)

    if (arrivalMs > 0) {
      // 让真实 rAF 有机会跑（节流版的渲染就发生在这一步）
      await act(async () => {
        await sleep(arrivalMs)
      })
    }
    // 让 MutationObserver 的回调跑完再进下一拍（否则这一拍的变化会算到下一拍头上）
    await Promise.resolve()
  }
  observer.disconnect()

  // 收尾：流结束 —— 屏幕内容必须与"直接渲染全文"一致（这一段单独计时：它是按设计的整篇重画）
  const settleAt = performance.now()
  view.rerender(
    <Harness
      impl={impl}
      text={steps[steps.length - 1] ?? ''}
      streaming={false}
      onRender={() => {}}
    />
  )
  const settleMs = performance.now() - settleAt
  const settled = node.textContent ?? ''
  const reference = render(
    <Harness
      impl={impl}
      text={steps[steps.length - 1] ?? ''}
      streaming={false}
      onRender={() => {}}
    />
  )
  const referenceText = reference.container.querySelector(
    '[data-testid="message-text"]'
  )?.textContent
  expect(settled).toBe(referenceText)

  return {
    deltas: steps.length,
    domChanges,
    commits: renderDurations.length,
    elapsedMs: performance.now() - started,
    maxDeltaMs: Math.max(...deltaMs),
    p95DeltaMs: percentile(deltaMs, 0.95),
    renderTotalMs: renderDurations.reduce((sum, ms) => sum + ms, 0),
    renderMaxMs: Math.max(...renderDurations),
    renderMeanMs: renderDurations.reduce((sum, ms) => sum + ms, 0) / renderDurations.length,
    settleMs
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function row(
  label: string,
  arrival: string,
  sample: StreamSample,
  lines: number
): Record<string, string | number> {
  const seconds = sample.elapsedMs / 1000
  return {
    实现: label,
    到达节奏: arrival,
    '样本(行/字节)': `${lines} / ${Buffer.byteLength(buildReply(), 'utf8')}`,
    delta数: sample.deltas,
    DOM变更次数: sample.domChanges,
    'DOM变更/秒': round(sample.domChanges / seconds),
    React提交次数: sample.commits,
    单拍最坏ms: round(sample.maxDeltaMs),
    单拍p95ms: round(sample.p95DeltaMs),
    render累计ms: round(sample.renderTotalMs),
    render最坏单次ms: round(sample.renderMaxMs),
    render每帧均值ms: round(sample.renderMeanMs),
    收尾整篇ms: round(sample.settleMs)
  }
}

describe('探针：流式正文渲染成本（round 73）', () => {
  const reply = buildReply()
  const steps = cumulativeDeltas(reply, DELTA_COUNT)
  const lines = reply.split('\n').length

  it('同步突发（一次推完 294 条 delta）', async () => {
    const legacy = await measureStream('legacy', steps, 0)
    const gated = await measureStream('gated', steps, 0)
    console.log(`[r73] 同步突发：${lines} 行 / ${reply.length} 字符`)
    console.table([
      row('改前（每 delta 全量解析）', '同步突发', legacy, lines),
      row('改后（按帧合流 + 按块增量）', '同步突发', gated, lines)
    ])
  }, 120_000)

  /**
   * PB-031 之后，流式中本来就**不渲染正文**（`Message.tsx` 的 filter：有过程块时整段留到轮末），
   * 所以"每帧解析成本"的压测对象已经不存在了。压测口径跟着产品语义走：
   * 改成**轮末一次性渲染成本** —— 整篇（约 485 行 / 12KB：24 节标题 + 24 张表 + 3 个代码块）
   * 在 `streaming=false` 时首次渲染要多久，并给一个上限阈值防止劣化。
   */
  it('轮末一次性渲染成本（PB-031 后口径：结束态整篇渲染）', () => {
    const started = performance.now()
    const view = render(<TextPart text={reply} streaming={false} />)
    const elapsed = performance.now() - started // 首屏 FCP 类：渲染在 WebKit/DOM 里同步发生
    console.log(
      `[r73] 结束态一次性渲染：${lines} 行 / ${reply.length} 字符 → ${elapsed.toFixed(1)}ms`
    )

    // 内容完整性：整篇都渲染出来了（标题 / 表格 / 代码块一个不少）
    expect(view.getByTestId('message-text')).toBeInTheDocument()
    expect(view.container.querySelectorAll('h2')).toHaveLength(24)
    expect(view.container.querySelectorAll('table')).toHaveLength(24)

    // 阈值依据：本机实测 **69.6ms**（485 行 / 12610 字符，jsdom）；取 **600ms ≈ 8.6×** 作为
    // "数量级劣化"的报警线（jsdom 的 DOM 写入比 Chromium 慢一个量级，这里只防数量级回归）
    expect(elapsed).toBeLessThan(600)
  }, 60_000)

  it('拆解：一次全量渲染里"解析 + 元素"占多少、"写 DOM"占多少', () => {
    // components 全部返回 null → react-markdown 照样解析、照样建 React 元素、React 照样协调，
    // 但一个 DOM 节点都不落。两次之差 ≈ jsdom 的 DOM 写入成本（这一截在 Chromium 上便宜得多），
    // 而"null 版"那一列（解析 + 元素 + 协调）与真实引擎基本同量级 —— 它才是"每帧重解析贵不贵"的依据。
    const Null = (): null => null
    const nullComponents: Components = {
      a: Null,
      blockquote: Null,
      br: Null,
      code: Null,
      del: Null,
      em: Null,
      h1: Null,
      h2: Null,
      h3: Null,
      h4: Null,
      h5: Null,
      h6: Null,
      hr: Null,
      img: Null,
      input: Null,
      li: Null,
      ol: Null,
      p: Null,
      pre: Null,
      strong: Null,
      table: Null,
      tbody: Null,
      td: Null,
      th: Null,
      thead: Null,
      tr: Null,
      ul: Null
    }
    const runs = (components?: Components): number => {
      const times: number[] = []
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const view = render(
          <div className="markdown-body">
            <Markdown remarkPlugins={[remarkGfm]} components={components}>
              {reply}
            </Markdown>
          </div>
        )
        const at = performance.now()
        view.rerender(
          <div className="markdown-body">
            <Markdown remarkPlugins={[remarkGfm]} components={components}>
              {reply}
            </Markdown>
          </div>
        )
        times.push(performance.now() - at)
        view.unmount()
      }
      return percentile(times.slice(1), 0.5)
    }

    console.table([
      {
        口径: '全量渲染（解析 + 元素 + 写 DOM）= 改前每 delta 的代价',
        样本行数: lines,
        中位ms: round(runs(LEGACY_COMPONENTS))
      },
      {
        口径: '只解析 + 建元素 + 协调（components 全返回 null，不写 DOM）',
        样本行数: lines,
        中位ms: round(runs(nullComponents))
      }
    ])
    expect(lines).toBeGreaterThan(0)
  })

  it('Shiki 单次高亮成本（流式期间每个 delta 都会重排一次的那部分）', async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] =
      await Promise.all([import('shiki/core'), import('shiki/engine/javascript')])
    const highlighter = await createHighlighterCore({
      themes: [createCssVariablesTheme({ name: 'css-variables', variablePrefix: '--shiki-' })],
      langs: [import('shiki/langs/typescript.mjs')],
      engine: createJavaScriptRegexEngine()
    })
    const code = [
      'export function section(x: number): number {',
      ...Array.from({ length: 60 }, (_, i) => `  const value${i} = x * ${i} + ${i * 3}`),
      '  return 0',
      '}'
    ].join('\n')

    const times: number[] = []
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const at = performance.now()
      highlighter.codeToHtml(code, { lang: 'typescript', theme: 'css-variables' })
      times.push(performance.now() - at)
    }
    const warm = times.slice(1)
    console.table([
      {
        代码行数: code.split('\n').length,
        首次ms: round(times[0] ?? 0),
        热态中位ms: round(percentile(warm, 0.5)),
        热态最坏ms: round(Math.max(...warm))
      }
    ])
    expect(times.length).toBe(7)
  })
})
