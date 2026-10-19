import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { defaultMotionSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { MessageList } from '@renderer/features/chat/MessageList'
import { shouldShowWaitingLine } from '@renderer/features/chat/waiting-line'

/**
 * P1b · 动效契约（静态 CSS + 判据）：
 *   - 所有时长/曲线/位移读 motion.css 角色令牌（不写裸 ms）；
 *   - 三条无限循环（光标 / 等待三点 / 扫光）在 reduced-motion 下显式停成静态；
 *   - 等待行只在 `submitted` 且本轮还没有 assistant 正文时出现；
 *   - 发送气泡动画只给"刚发送的那一条用户消息"，历史回灌不播。
 */
const CHAT_MOTION_CSS = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/features/chat/chat-motion.css'),
  'utf8'
)
const MOTION_TOKENS = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/styles/tokens/motion.css'),
  'utf8'
)
const TEXT_PART_TSX = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/features/chat/parts/TextPart.tsx'),
  'utf8'
)

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('P1b：动效时长全部来自 motion.css 角色令牌', () => {
  it('motion.css 提供角色令牌（P0 定稿），chat-motion 只组合不重定义', () => {
    for (const token of [
      '--motion-feedback: 120ms',
      '--motion-reveal: 150ms',
      '--motion-exit: 120ms',
      '--motion-stagger: 70ms',
      '--motion-dot: 500ms',
      '--motion-sweep: 1500ms',
      '--motion-enter: 320ms',
      '--motion-open: 250ms',
      '--motion-spring: 500ms',
      '--motion-reduced: 0.01ms'
    ]) {
      expect(MOTION_TOKENS).toContain(token)
    }
  })

  it('chat-motion.css 的 animation/transition 里没有裸 ms 值（只引用 var/calc）', () => {
    const css = stripComments(CHAT_MOTION_CSS)
    const rawDuration = /(?:animation|transition)[^;{}]*\b\d+(?:\.\d+)?ms\b/.exec(css)
    expect(rawDuration?.[0] ?? null).toBeNull()
  })

  it('9 个配方都有落点：chunk / caret / dots / sweep / swap / tool / fold / dock / send', () => {
    const css = stripComments(CHAT_MOTION_CSS)
    // PB-045 P1-C：chunk 淡入从 CSS `> :last-child` 改为 TextPart 的 Web Animations（只给新块一次）
    expect(css).not.toContain('chat-chunk-in')
    expect(TEXT_PART_TSX).toContain('previousBlockCountRef')
    expect(TEXT_PART_TSX).toContain('{ opacity: 0.6 }')
    expect(TEXT_PART_TSX).toContain('--motion-reveal')
    expect(css).toContain('chat-caret-blink-block')
    expect(css).toContain('chat-waiting-bounce')
    expect(css).toContain('chat-sweep')
    expect(css).toContain('chat-swap-in')
    expect(css).toContain('chat-tool-in')
    expect(css).toContain('chat-fold-enter')
    expect(css).toContain('chat-dock-in')
    expect(css).toContain('chat-send-grow')
    expect(css).toContain('trace-wash')
    expect(css).toContain('data-status-line')
    expect(css).toContain('data-motion=')
    // 扫光必须 steps(48, end) + 300ms 延迟组合
    expect(css).toContain('steps(48, end)')
    expect(css).toContain('--chat-sweep-delay')
    expect(css).toContain('--motion-sweep')
  })

  it('光标/自绘 caret 用主题色 --accent（2px 不变；不写死墨色/hex）', () => {
    const css = stripComments(CHAT_MOTION_CSS)
    // 流式尾部光标 + Composer 自绘 caret 两处竖条都读 --accent
    expect((css.match(/background-color: var\(--accent\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(css).not.toContain('background-color: var(--text-primary)')
    // 自绘档隐藏原生 caret；composition / 引用 chip 的原生 caret 也取主题色
    expect(css).toContain('caret-color: var(--accent)')
    expect(css).toContain('caret-color: transparent')
    // 主题色必须用 token，不写死号
    expect(css).not.toMatch(/background-color:\s*#d97757/i)
    expect(css).not.toMatch(/caret-color:\s*#d97757/i)
    // 尺寸/闪频契约不变
    expect(css).toContain('width: 2px')
    expect(css).toContain('steps(2, end)')
  })

  it('reduced-motion：无限循环停成静态（不是 0.01ms 的循环闪烁）', () => {
    const css = stripComments(CHAT_MOTION_CSS)
    const reduce = css.slice(css.indexOf('prefers-reduced-motion'))
    expect(reduce).toContain('.composer-caret')
    expect(reduce).toContain('.chat-waiting-dot')
    expect(reduce).toContain('.trace-live')
    expect(reduce).toContain('animation: none !important')
    expect(reduce).toContain('--motion-reduced')
  })
})

describe('P1b：等待行判据', () => {
  const user: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: '你好' }] }

  it('submitted + 本轮没有 assistant 正文 → true（工具 part 不算正文）', () => {
    expect(shouldShowWaitingLine('submitted', [user])).toBe(true)
    expect(
      shouldShowWaitingLine('submitted', [
        user,
        {
          id: 'a1',
          role: 'assistant',
          parts: [{ type: 'tool-bash', toolCallId: 't1', state: 'input-available', input: {} }]
        }
      ])
    ).toBe(true)
  })

  it('正文一到 / 状态不是 submitted → false；旧轮正文不挡新轮', () => {
    const assistant: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: '在的' }]
    }
    expect(shouldShowWaitingLine('submitted', [user, assistant])).toBe(false)
    expect(shouldShowWaitingLine('streaming', [user])).toBe(false)
    expect(shouldShowWaitingLine('ready', [user, assistant])).toBe(false)
    // 上一轮 assistant 正文 + 本轮新 user：判据只看最后一轮 → 仍然要等
    expect(shouldShowWaitingLine('submitted', [user, assistant, user])).toBe(true)
  })
})

describe('P1b：等待行 / 发送气泡接线', () => {
  it('submitted 且没有正文：消息列末尾出现等待行（三点 + 扫光文字）', () => {
    render(
      <MessageList
        messages={[{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '在吗' }] }]}
        status="submitted"
      />
    )
    const waiting = screen.getByTestId('waiting-line')
    expect(waiting).toHaveAttribute('role', 'status')
    expect(waiting.querySelectorAll('.chat-waiting-dot')).toHaveLength(3)
    // 默认 preciseStatus=true：submitted 的精确说法是「正在准备工具调用」
    expect(waiting.querySelector('.trace-live')).toHaveTextContent('正在准备工具调用')
    // 动效 B：消息列表根带 6 个门控 attr（默认=用户截图选择）
    const frame = screen.getByTestId('message-list-frame')
    expect(frame).toHaveAttribute('data-motion', 'full')
    expect(frame).toHaveAttribute('data-chat-scroll', 'on')
    expect(frame).toHaveAttribute('data-chat-reveal', 'on')
    expect(frame).toHaveAttribute('data-status-line', 'on')
    expect(frame).toHaveAttribute('data-status-paint', 'sweep')
    expect(frame).toHaveAttribute('data-chat-send', 'on')
    expect(frame).toHaveAttribute('data-message-enter', 'flight')
  })

  it('assistant 正文一到等待行消失；最后一条用户消息在非 ready 时挂发送动画标记', () => {
    const { rerender } = render(
      <MessageList
        messages={[{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '在吗' }] }]}
        status="submitted"
      />
    )
    expect(screen.getByTestId('waiting-line')).toBeInTheDocument()
    expect(screen.getByTestId('message-u1')).toHaveAttribute('data-send-animate', 'grow')

    rerender(
      <MessageList
        messages={[
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: '在吗' }] },
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '在的' }] }
        ]}
        status="streaming"
      />
    )
    expect(screen.queryByTestId('waiting-line')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-u1')).toHaveAttribute('data-send-animate', 'grow')

    // 历史回灌（ready）不播发送气泡
    rerender(
      <MessageList
        messages={[
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: '在吗' }] },
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '在的' }] }
        ]}
        status="ready"
      />
    )
    expect(screen.getByTestId('message-u1')).not.toHaveAttribute('data-send-animate')
  })
})

/**
 * 动效 B：聊天根 data-* 门控（lib/motion.ts 的 9 键折算）——
 * reduced 时滚动/状态行/淡入/气泡全部静态，但文案仍在（不是消失）。
 */
describe('动效 B：reduced 三档门控', () => {
  it('mode=reduced：聊天根 attr 全静态；等待行只留文字、不挂扫光/三点/气泡动画', () => {
    const original = useSettingsStore.getState().settings
    useSettingsStore.setState({
      settings: { ...original, motion: { ...defaultMotionSettings(), mode: 'reduced' } }
    })
    try {
      render(
        <MessageList
          messages={[{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '在吗' }] }]}
          status="submitted"
        />
      )
      const frame = screen.getByTestId('message-list-frame')
      expect(frame).toHaveAttribute('data-motion', 'reduced')
      expect(frame).toHaveAttribute('data-chat-scroll', 'off')
      expect(frame).toHaveAttribute('data-chat-reveal', 'off')
      expect(frame).toHaveAttribute('data-status-line', 'off')
      expect(frame).toHaveAttribute('data-chat-send', 'off')
      expect(frame).toHaveAttribute('data-message-enter', 'none')

      const waiting = screen.getByTestId('waiting-line')
      expect(waiting.querySelectorAll('.chat-waiting-dot')).toHaveLength(0)
      expect(waiting.querySelector('.trace-live, .trace-wash')).toBeNull()
      expect(waiting).toHaveTextContent('正在准备') // 文案仍在（statusLine 关 → 粗粒度说法）
      expect(screen.getByTestId('message-u1')).not.toHaveAttribute('data-send-animate')
    } finally {
      useSettingsStore.setState({ settings: original })
    }
  })

  it('messageEnter=grow + chatSend=on：用户气泡挂 grow（不用 flight）', () => {
    const original = useSettingsStore.getState().settings
    useSettingsStore.setState({
      settings: { ...original, motion: { ...defaultMotionSettings(), messageEnter: 'grow' } }
    })
    try {
      render(
        <MessageList
          messages={[{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '在吗' }] }]}
          status="streaming"
        />
      )
      expect(screen.getByTestId('message-u1')).toHaveAttribute('data-send-animate', 'grow')
    } finally {
      useSettingsStore.setState({ settings: original })
    }
  })
})

describe('task-83 · caret 宽度恒定', () => {
  it('宽度 2px×ui-scale、min-width 2px；过渡不含 width/scale（打字/暂停都不变细）', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/features/chat/chat-motion.css'),
      'utf8'
    )
    const block = /\.composer-caret \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
    expect(block).toContain('width: calc(2px * var(--ui-scale, 1))')
    expect(block).toContain('min-width: 2px')
    const transitions = /transition:([\s\S]*?);/.exec(block)?.[1] ?? ''
    expect(transitions).toContain('left')
    expect(transitions).not.toContain('width')
    expect(transitions).not.toContain('scale')
  })
})
