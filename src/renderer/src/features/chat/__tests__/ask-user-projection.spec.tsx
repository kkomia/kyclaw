import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@shared/threads'
import { mapStoredMessages } from '@renderer/lib/message-map'
import { buildTrajectory } from '@renderer/features/trajectory/model'
import { ToolCard } from '../parts/ToolCard'
import { toToolCardPart } from '../parts/tool-part'
import { hasPendingAskUser } from '../ask-user'

function stored(state: string, result?: unknown): StoredMessage {
  return {
    id: 'assistant',
    role: 'assistant',
    content: {
      format: 2,
      parts: [
        {
          type: 'tool-invocation',
          toolInvocation: { state, toolName: 'ask_user', toolCallId: 'call', args: {}, result }
        }
      ]
    }
  } as StoredMessage
}
describe('AskUser history and trajectory', () => {
  it.each([
    ['call', undefined, '等待回答', true],
    ['result', { status: 'answered', answers: [] }, '已回答', false],
    ['result', { status: 'cancelled' }, '已取消', false]
  ] as const)('%s/%j 恢复状态 %s', (state, result, label, pending) => {
    const messages = mapStoredMessages([stored(state, result)])
    expect(hasPendingAskUser(messages[0])).toBe(pending)
    const part = toToolCardPart(messages[0].parts[0])!
    render(<ToolCard part={part} />)
    expect(screen.getByTestId('tool-state')).toHaveTextContent(label)
    const trajectory = buildTrajectory({ messages: [stored(state, result)] })
    const tool = trajectory.rows.find((row) => row.kind === 'tool')!
    expect(tool.text).toContain(label)
    expect(tool.pending).toBe(pending)
  })
})
