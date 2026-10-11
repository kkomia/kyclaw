import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { ReasoningPart } from '@renderer/features/chat/parts/ReasoningPart'
import { resetReasoningTranslateCache } from '@renderer/lib/reasoning-translate'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type ReasoningTranslateSettings } from '@shared/settings'
import type { TranslateResult } from '@shared/translate'

/**
 * 思考块接上翻译（round 32）：
 *   - 全量翻译：段写完自动翻、默认显示译文、能切回原文（进行中显示原文）；
 *   - 翻译按钮：显示原文 + 「翻译」，点了才翻；
 *   - 缓存：同一段 + 同一目标语言只翻一次（重挂不重复调服务）；
 *   - 失败可重试；语言一致 / 开关关着时**什么都不做**（不调服务、不出控件）。
 *
 * 译文由假 bridge 喂（`window.kyclaw.translate.run`）；缓存是模块级单例，用例之间手动清。
 */
const ENGLISH = 'Let me read the config file first, then write the patch.'
const CHINESE = '先看看配置文件在不在，然后写补丁并跑测试。'

function settingsWith(patch: Partial<ReasoningTranslateSettings>): void {
  const base = defaultSettings()
  useSettingsStore.setState({
    settings: { ...base, reasoningTranslate: { ...base.reasoningTranslate, ...patch } },
    loaded: true
  })
}

beforeEach(() => {
  resetReasoningTranslateCache()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('全量翻译模式', () => {
  it('进行中显示原文；这一段写完后自动翻，翻好默认显示译文，可来回切换', async () => {
    const bridge = installKyclawBridge()
    let finish: (result: TranslateResult) => void = () => {}
    bridge.translate.run.mockImplementation(
      () =>
        new Promise<TranslateResult>((resolve) => {
          finish = resolve
        })
    )
    settingsWith({ enabled: true, mode: 'full' })

    const { rerender } = render(<ReasoningPart text={ENGLISH} streaming />)

    // 还没写完：一个字都不翻（不显示控件，也不发请求）
    expect(screen.queryByTestId('reasoning-translate-bar')).not.toBeInTheDocument()
    expect(bridge.translate.run).not.toHaveBeenCalled()
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent(ENGLISH)

    // 这一段写完了：自动开翻 —— 进行中显示原文 + 「翻译中…」
    rerender(<ReasoningPart text={ENGLISH} streaming={false} />)
    expect(await screen.findByTestId('reasoning-translating')).toBeInTheDocument()
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent(ENGLISH)
    expect(bridge.translate.run).toHaveBeenCalledWith({ text: ENGLISH, targetLanguage: '简体中文' })

    finish({ ok: true, text: '我先读一下配置文件，然后写补丁。' })

    // 翻好了：默认显示译文
    await waitFor(() =>
      expect(screen.getByTestId('reasoning-text')).toHaveTextContent(
        '我先读一下配置文件，然后写补丁。'
      )
    )
    expect(screen.getByTestId('reasoning-text')).toHaveAttribute('data-showing', 'translated')
    expect(screen.queryByTestId('reasoning-translating')).not.toBeInTheDocument()

    // 切回原文 / 再切回译文（两个 chip 都在）
    fireEvent.click(screen.getByTestId('reasoning-show-original'))
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent(ENGLISH)
    expect(screen.getByTestId('reasoning-text')).toHaveAttribute('data-showing', 'original')
    fireEvent.click(screen.getByTestId('reasoning-show-translated'))
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent(
      '我先读一下配置文件，然后写补丁。'
    )

    // 切来切去不会重新调服务
    expect(bridge.translate.run).toHaveBeenCalledTimes(1)
  })

  it('失败：留着原文 + 一句人话 + 「重试」；点了重试真再打一次，成了就显示译文', async () => {
    const bridge = installKyclawBridge()
    bridge.translate.run.mockResolvedValueOnce({ ok: false, message: '连不上翻译服务' })
    settingsWith({ enabled: true, mode: 'full' })

    render(<ReasoningPart text={ENGLISH} />)
    // 折叠的内容要开过一次才上 DOM（TraceFold 口径）；全量模式下展开就当译文已经在路上
    fireEvent.click(screen.getByTestId('reasoning-toggle'))

    expect(await screen.findByTestId('reasoning-translate-error')).toHaveTextContent(
      '连不上翻译服务'
    )
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent(ENGLISH)
    expect(screen.getByTestId('reasoning-translate-action')).toHaveTextContent('重试')

    bridge.translate.run.mockResolvedValueOnce({ ok: true, text: '译文来了。' })
    fireEvent.click(screen.getByTestId('reasoning-translate-action'))

    await waitFor(() =>
      expect(screen.getByTestId('reasoning-text')).toHaveTextContent('译文来了。')
    )
    expect(bridge.translate.run).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('reasoning-translate-error')).not.toBeInTheDocument()
  })
})

describe('翻译按钮模式', () => {
  it('显示原文 + 「翻译」，点了才翻；翻好显示译文、可切回原文再切回来（缓存不再打服务）', async () => {
    const bridge = installKyclawBridge()
    bridge.translate.run.mockResolvedValue({ ok: true, text: '我先读一下配置文件，然后写补丁。' })
    settingsWith({ enabled: true, mode: 'button' })

    render(<ReasoningPart text={ENGLISH} />)
    fireEvent.click(screen.getByTestId('reasoning-toggle'))

    expect(screen.getByTestId('reasoning-text')).toHaveTextContent(ENGLISH)
    expect(screen.getByTestId('reasoning-translate-action')).toHaveTextContent('翻译')
    expect(bridge.translate.run).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('reasoning-translate-action'))

    await waitFor(() =>
      expect(screen.getByTestId('reasoning-text')).toHaveTextContent(
        '我先读一下配置文件，然后写补丁。'
      )
    )
    expect(bridge.translate.run).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('reasoning-show-original'))
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent(ENGLISH)
    fireEvent.click(screen.getByTestId('reasoning-show-translated'))
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent(
      '我先读一下配置文件，然后写补丁。'
    )
    expect(bridge.translate.run).toHaveBeenCalledTimes(1)
  })
})

describe('缓存与"不该动作"的情形', () => {
  it('同一段 + 同一目标语言只翻一次：重挂一次直接显示上次的译文，不再调服务', async () => {
    const bridge = installKyclawBridge()
    bridge.translate.run.mockResolvedValue({ ok: true, text: '译文。' })
    settingsWith({ enabled: true, mode: 'full' })

    const first = render(<ReasoningPart text={ENGLISH} />)
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    await waitFor(() => expect(screen.getByTestId('reasoning-text')).toHaveTextContent('译文。'))
    first.unmount()

    render(<ReasoningPart text={ENGLISH} />)
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    await waitFor(() => expect(screen.getByTestId('reasoning-text')).toHaveTextContent('译文。'))
    expect(bridge.translate.run).toHaveBeenCalledTimes(1)
  })

  it('语言一致（中文思考 + 目标中文）：不调服务、不出任何翻译控件', async () => {
    const bridge = installKyclawBridge()
    settingsWith({ enabled: true, mode: 'full' })

    render(<ReasoningPart text={CHINESE} />)
    fireEvent.click(screen.getByTestId('reasoning-toggle'))

    await waitFor(() =>
      expect(screen.queryByTestId('reasoning-translate-bar')).not.toBeInTheDocument()
    )
    expect(bridge.translate.run).not.toHaveBeenCalled()
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent(CHINESE)
  })

  it('开关关着：什么都不做（即使全文是英文）', async () => {
    const bridge = installKyclawBridge()
    settingsWith({ enabled: false, mode: 'full' })

    render(<ReasoningPart text={ENGLISH} />)

    await waitFor(() => expect(bridge.translate.run).not.toHaveBeenCalled())
    expect(screen.queryByTestId('reasoning-translate-bar')).not.toBeInTheDocument()
  })

  it('目标语言改成英文（与思考一致）：不出控件、不调服务', async () => {
    const bridge = installKyclawBridge()
    settingsWith({ enabled: true, mode: 'button', targetLanguage: 'English' })

    render(<ReasoningPart text={ENGLISH} />)

    await waitFor(() => expect(bridge.translate.run).not.toHaveBeenCalled())
    expect(screen.queryByTestId('reasoning-translate-bar')).not.toBeInTheDocument()
  })
})
