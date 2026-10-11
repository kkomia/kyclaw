import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, REASONING_TRANSLATE_PRESET } from '@shared/settings'
import { ReasoningTranslateSettings } from '../ReasoningTranslateSettings'

/**
 * 设置页「模型」栏的「思考翻译」组（round 32）：开关 + 模式二选一 + 翻译服务三项 + 目标语言。
 * 开关/模式当场落盘（settings:update）；服务三项与目标语言改完点「保存」；可选 API Key
 * 走 translate 通道（写方向见一次明文，读方向只有"有没有 / 要不要重录"）。
 * 预置口径同语义召回：落盘为空时表单按预置填，保存写下去的就是表单里看到的。
 */
beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

/** 直接摆一份渲染端看到的设置（组件读的是设置副本，不是桥的初值） */
function withSettings(
  patch: Partial<ReturnType<typeof defaultSettings>['reasoningTranslate']>
): void {
  const base = defaultSettings()
  useSettingsStore.setState({
    settings: { ...base, reasoningTranslate: { ...base.reasoningTranslate, ...patch } },
    loaded: true
  })
}

describe('「思考翻译」组', () => {
  it('默认：开关是关的，翻译服务与目标语言都不出现（不开就不铺一屏）', () => {
    installKyclawBridge()
    render(<ReasoningTranslateSettings />)

    expect(screen.getByTestId('translate-enabled')).toHaveAttribute('aria-checked', 'false')
    for (const testId of [
      'translate-mode-full',
      'translate-base-url',
      'translate-model',
      'translate-api-key',
      'translate-target-language'
    ]) {
      expect(screen.queryByTestId(testId), testId).not.toBeInTheDocument()
    }
  })

  it('打开开关：整组落盘（enabled=true，其余保持原值）', async () => {
    const bridge = installKyclawBridge()
    render(<ReasoningTranslateSettings />)

    fireEvent.click(screen.getByTestId('translate-enabled'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        reasoningTranslate: {
          enabled: true,
          mode: 'full',
          baseUrl: REASONING_TRANSLATE_PRESET.baseUrl,
          model: REASONING_TRANSLATE_PRESET.model,
          targetLanguage: REASONING_TRANSLATE_PRESET.targetLanguage
        }
      })
    )
  })

  it('模式二选一：缺省「全量翻译」，点「翻译按钮」当场落盘', async () => {
    const bridge = installKyclawBridge()
    withSettings({ enabled: true })
    render(<ReasoningTranslateSettings />)

    expect(screen.getByTestId('translate-mode-full')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('translate-mode-button')).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByTestId('translate-mode-button'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoningTranslate: expect.objectContaining({ mode: 'button', enabled: true })
        })
      )
    )
    expect(screen.getByTestId('translate-mode-button')).toHaveAttribute('aria-pressed', 'true')
  })

  it('落盘为空串（没配过）时表单先按预置填：贴可选 key 保存，地址与模型一并落盘', async () => {
    const bridge = installKyclawBridge()
    withSettings({ enabled: true, baseUrl: '', model: '', targetLanguage: '' })
    render(<ReasoningTranslateSettings />)

    expect(screen.getByTestId('translate-base-url')).toHaveValue(REASONING_TRANSLATE_PRESET.baseUrl)
    expect(screen.getByTestId('translate-model')).toHaveValue(REASONING_TRANSLATE_PRESET.model)
    expect(screen.getByTestId('translate-target-language')).toHaveValue(
      REASONING_TRANSLATE_PRESET.targetLanguage
    )

    fireEvent.change(screen.getByTestId('translate-api-key'), { target: { value: 'sk-translate' } })
    fireEvent.click(screen.getByTestId('translate-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        reasoningTranslate: {
          enabled: true,
          mode: 'full',
          baseUrl: REASONING_TRANSLATE_PRESET.baseUrl,
          model: REASONING_TRANSLATE_PRESET.model,
          targetLanguage: REASONING_TRANSLATE_PRESET.targetLanguage
        }
      })
    )
    await waitFor(() => expect(bridge.translate.setKey).toHaveBeenCalledWith('sk-translate'))
    // 密钥草稿保存后清空（永远不回显）
    expect(screen.getByTestId('translate-api-key')).toHaveValue('')
  })

  it('服务三项可改成任意 OpenAI 兼容端点 + 目标语言：保存的就是用户填的值（trim 之后）', async () => {
    const bridge = installKyclawBridge()
    render(<ReasoningTranslateSettings />)
    fireEvent.click(screen.getByTestId('translate-enabled'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalled())

    fireEvent.change(screen.getByTestId('translate-base-url'), {
      target: { value: ' https://api.example.com/v1 ' }
    })
    fireEvent.change(screen.getByTestId('translate-model'), {
      target: { value: ' my-translate ' }
    })
    fireEvent.change(screen.getByTestId('translate-target-language'), {
      target: { value: ' English ' }
    })
    fireEvent.click(screen.getByTestId('translate-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        reasoningTranslate: {
          enabled: true,
          mode: 'full',
          baseUrl: 'https://api.example.com/v1',
          model: 'my-translate',
          targetLanguage: 'English'
        }
      })
    )
  })

  it('已存过密钥：占位提示"要换就填新的"，「清除密钥」走翻译通道', async () => {
    const bridge = installKyclawBridge()
    withSettings({ enabled: true })
    bridge.translate.keyState.mockResolvedValue({ hasKey: true, needsReentry: false })
    render(<ReasoningTranslateSettings />)

    const keyInput = await screen.findByTestId('translate-api-key')
    await waitFor(() => expect(keyInput).toHaveAttribute('placeholder', '已保存；要换就填新的'))

    fireEvent.click(screen.getByTestId('translate-clear-key'))
    await waitFor(() => expect(bridge.translate.clearKey).toHaveBeenCalled())
  })

  it('密钥读不到（换机）：提示重新录入', async () => {
    const bridge = installKyclawBridge()
    withSettings({ enabled: true })
    bridge.translate.keyState.mockResolvedValue({ hasKey: false, needsReentry: true })
    render(<ReasoningTranslateSettings />)

    expect(await screen.findByTestId('translate-reentry')).toHaveTextContent('请重新录入')
  })

  it('目标语言 / 地址 / 模型都留空也能保存（空串 = 用预置；保存失败才会行内报错）', async () => {
    const bridge = installKyclawBridge()
    withSettings({ enabled: true })
    bridge.update.mockRejectedValueOnce(new Error('设置落盘失败'))

    render(<ReasoningTranslateSettings />)
    fireEvent.click(screen.getByTestId('translate-save'))

    expect(await screen.findByTestId('translate-error')).toHaveTextContent('设置落盘失败')
  })
})
