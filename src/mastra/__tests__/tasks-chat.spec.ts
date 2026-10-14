import { describe, expect, it } from 'vitest'
import { createTasksContext } from '../tasks-context'
import { prepareTaskChatParams, validateTaskChatBody } from '../tasks-chat'

const body = {
  messages: [],
  memory: { thread: 't1', resource: 'local-user' },
  providerOptions: { example: { thinking: true } }
}

describe('生产 chat 任务身份边界', () => {
  it.each([
    'requestContext',
    'inputProcessors',
    'outputProcessors',
    'tools',
    'toolsets',
    'activeTools',
    'onFinish',
    'onStepFinish',
    'instructions',
    'hooks'
  ])('拒绝客户端覆盖 %s', (field) => {
    expect(() => validateTaskChatBody({ ...body, [field]: {} })).toThrow(
      field === 'inputProcessors' || field === 'outputProcessors'
        ? 'server-owned-processors'
        : 'server-owned-chat-options'
    )
  })
  it('保留模型设置，初始 runId 服务器生成，恢复使用已校验原 runId', () => {
    const ctx = createTasksContext()
    const initial = prepareTaskChatParams(validateTaskChatBody(body), ctx, 't1')
    expect(initial.providerOptions).toEqual(body.providerOptions)
    expect(initial.runId).toEqual(expect.any(String))
    expect(() => validateTaskChatBody({ ...body, runId: 'forged' })).toThrow('server-owned-run-id')
    const resume = prepareTaskChatParams(
      validateTaskChatBody({ ...body, runId: 'original', toolCallId: 'call', resumeData: {} }),
      ctx,
      't1',
      'original'
    )
    expect(resume.runId).toBe('original')
    expect(resume.requestContext).not.toBe(initial.requestContext)
  })
})
