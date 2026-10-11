import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type AppSettings } from '@shared/settings'
import { createMockTransport } from './mock-transport'

/**
 * 图片真的发出去了吗（模块 2 的接线验证）：走**真 ChatSession + 真 Composer**，
 * 在最后一步的请求体里断言 file part 真的在（data URL 完好）。
 *
 * 这一步补的是"composer 造对了载荷"与"wire 能到 provider"之间的缝：
 * 单测里 composer 只验载荷形状、wire spec 只验 server→provider，
 * ChatPage 这一层（sendMessage 收 `{text, files}`）得有东西钉住。
 * 真链路（provider 请求体里出现 image_url）钉在 src/mastra/__tests__/vision-wire.spec.ts。
 */
function settingsWithVision(): AppSettings {
  return {
    ...defaultSettings(),
    providers: [
      {
        id: 'p1',
        type: 'openai-compatible',
        model: 'my-vision-model',
        isDefault: true,
        baseUrl: 'http://x/v1'
      }
    ],
    modelCapabilities: { 'my-vision-model': { vision: true } }
  }
}

afterEach(() => {
  cleanup()
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

describe('模块 2 · ChatPage 发送图片（file part 真的进请求）', () => {
  it('vision=true 时：图片 chip → 发送 → 请求体末条 user 消息里带 file part', async () => {
    const initial = settingsWithVision()
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })

    const control = createMockTransport()
    render(
      <MemoryRouter>
        <ChatSession
          transport={control.transport}
          threadId="thread-vision"
          runtime={{
            transport: control.transport,
            loadHistory: async () => [],
            onTurnEnd: () => {}
          }}
        />
      </MemoryRouter>
    )
    await screen.findByTestId('composer-input')

    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [new File(['png-bytes'], 'shot.png', { type: 'image/png' })] }
    })
    await screen.findByTestId('composer-attachment-shot.png')

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '这是什么' } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    await waitFor(() => expect(control.requests).toHaveLength(1))
    const sent = control.requests[0].messages.at(-1)
    expect(sent?.role).toBe('user')
    const file = sent?.parts.find((part) => part.type === 'file')
    expect(file).toMatchObject({ type: 'file', mediaType: 'image/png', filename: 'shot.png' })
    if (file?.type === 'file') {
      expect(file.url.startsWith('data:image/png;base64,')).toBe(true)
    }
    expect(sent?.parts.some((part) => part.type === 'text' && part.text === '这是什么')).toBe(true)
  })

  it('vision=false 时：图片在 composer 就被拦下，不会发出任何请求', async () => {
    const initial: AppSettings = { ...defaultSettings() }
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })

    const control = createMockTransport()
    render(
      <MemoryRouter>
        <ChatSession
          transport={control.transport}
          threadId="thread-no-vision"
          runtime={{
            transport: control.transport,
            loadHistory: async () => [],
            onTurnEnd: () => {}
          }}
        />
      </MemoryRouter>
    )
    await screen.findByTestId('composer-input')

    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] }
    })

    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent('当前模型不支持看图')
    )
    expect(control.requests).toHaveLength(0)
  })
})
