import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * Step 4 的会话级行为：流式中发送排队、停止、编辑=截断重发。
 * 全部走真实交互路径（往输入框里敲 + 回车 / 点按钮），底层是注入的假 transport。
 */
function renderSession(control: MockTransport): void {
  render(
    <MemoryRouter>
      <ChatSession transport={control.transport} />
    </MemoryRouter>
  )
}

function type(text: string): void {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
}

function send(text: string): void {
  type(text)
  fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
}

/** 请求历史里的用户消息文本（断言截断/队列时最直观） */
function userTexts(control: MockTransport, index: number): string[] {
  return control.requests[index].messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
}

describe('流式中发送 = 入队（最简队列）', () => {
  it('流式中的发送先排队，当前回复结束后自动发出', async () => {
    const control = createMockTransport()
    renderSession(control)

    await act(async () => {
      send('第一个问题')
    })
    expect(control.requests).toHaveLength(1)

    // 流式中的第二条：进队列，不并发请求
    await act(async () => {
      send('第二个问题')
    })
    expect(control.requests).toHaveLength(1)
    expect(screen.getByTestId('composer-queue')).toHaveTextContent('已排队 1 条')

    await act(async () => {
      control.push('答一')
      control.finish()
    })

    // 流结束 → 队列自动发出（无状态服务端，第二轮带上全量历史）
    await waitFor(() => {
      expect(control.requests).toHaveLength(2)
    })
    expect(userTexts(control, 1)).toEqual(['第一个问题', '第二个问题'])
    expect(screen.queryByTestId('composer-queue')).not.toBeInTheDocument()
  })

  it('停止后队列也不丢：回到可发送态时把它发出去', async () => {
    const control = createMockTransport()
    renderSession(control)

    await act(async () => {
      send('第一个问题')
    })
    await act(async () => {
      send('排队中的问题')
    })
    expect(control.requests).toHaveLength(1)

    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-stop'))
    })

    await waitFor(() => {
      expect(control.requests).toHaveLength(2)
    })
    expect(userTexts(control, 1)).toEqual(['第一个问题', '排队中的问题'])
  })
})

describe('停止', () => {
  it('停止后保留已生成的内容，并回到可发送态', async () => {
    const control = createMockTransport()
    renderSession(control)

    await act(async () => {
      send('问题')
    })
    await act(async () => {
      control.push('半句回答')
    })
    expect(screen.getByTestId('message-list')).toHaveTextContent('半句回答')

    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-stop'))
    })

    expect(screen.getByTestId('composer-send')).toBeInTheDocument()
    expect(screen.queryByTestId('composer-stop')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toHaveTextContent('半句回答')
  })
})

describe('编辑 = 客户端截断重发', () => {
  it('编辑中间那条用户消息：后面的消息被截断，请求带着改过的历史重发', async () => {
    const control = createMockTransport()
    renderSession(control)

    await act(async () => {
      send('第一个问题')
    })
    await act(async () => {
      control.push('答一')
      control.finish()
    })
    await act(async () => {
      send('第二个问题')
    })
    await act(async () => {
      control.push('答二')
      control.finish()
    })
    expect(control.requests).toHaveLength(2)

    const editedId = control.requests[0].messages[0].id
    expect(screen.getByTestId('message-list')).toHaveTextContent('第二个问题')

    fireEvent.click(screen.getAllByTestId('message-edit')[0])
    fireEvent.change(screen.getByTestId('message-edit-input'), {
      target: { value: '改过的第一个问题' }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-edit-save'))
    })

    await waitFor(() => {
      expect(control.requests).toHaveLength(3)
    })
    // 截断：只留改过的那一条（同一个消息 id，替换而不是新增）；第二问与两条回答都不在历史里
    expect(control.requests[2].messages).toHaveLength(1)
    expect(control.requests[2].messages[0].id).toBe(editedId)
    expect(userTexts(control, 2)).toEqual(['改过的第一个问题'])
    expect(screen.queryByText('第二个问题')).not.toBeInTheDocument()
    expect(screen.queryByText('答二')).not.toBeInTheDocument()
  })

  it('取消编辑：不改历史、不发请求', async () => {
    const control = createMockTransport()
    renderSession(control)

    await act(async () => {
      send('原始问题')
    })
    await act(async () => {
      control.push('答')
      control.finish()
    })

    fireEvent.click(screen.getByTestId('message-edit'))
    fireEvent.change(screen.getByTestId('message-edit-input'), {
      target: { value: '改了一半' }
    })
    fireEvent.click(screen.getByTestId('message-edit-cancel'))

    expect(screen.queryByTestId('message-edit-input')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toHaveTextContent('原始问题')
    expect(control.requests).toHaveLength(1)
  })

  it('流式中不给编辑入口（避免编辑触发的请求和当前这条流并发）', async () => {
    const control = createMockTransport()
    renderSession(control)

    await act(async () => {
      send('问题')
    })
    expect(screen.queryByTestId('message-edit')).not.toBeInTheDocument()

    await act(async () => {
      control.push('答')
      control.finish()
    })
    expect(screen.getByTestId('message-edit')).toBeInTheDocument()
  })
})
