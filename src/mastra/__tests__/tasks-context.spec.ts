import { describe, expect, it } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { ProcessInputStepArgs } from '@mastra/core/processors'
import { createTasksContext } from '../tasks-context'

function step(
  requestContext: RequestContext,
  threadId: string,
  messageId?: string,
  runId?: string
): ProcessInputStepArgs {
  return {
    requestContext,
    messageId,
    runId,
    messages: [
      {
        id: 'user',
        role: 'user',
        threadId,
        content: { format: 2, parts: [] },
        createdAt: new Date()
      }
    ]
  } as unknown as ProcessInputStepArgs
}

describe('任务请求上下文', () => {
  it('每请求独立，可信 response 身份通过 RequestContext 传递，不接受手工构造值', async () => {
    const ctx = createTasksContext()
    const a = ctx.prepareRequest('a'),
      b = ctx.prepareRequest('b')
    expect(a.runId).not.toBe(b.runId)
    expect(ctx.identityOf(a.requestContext, 'a')).toBeNull()
    await ctx.processor.processInputStep!(step(a.requestContext, 'a', 'message-a', a.runId))
    await ctx.processor.processInputStep!(step(b.requestContext, 'b', 'message-b', b.runId))
    expect(ctx.identityOf(a.requestContext, 'a')).toEqual({
      threadId: 'a',
      messageId: 'message-a',
      runId: a.runId
    })
    expect(ctx.identityOf(b.requestContext, 'b')?.messageId).toBe('message-b')
    expect(ctx.identityOf(a.requestContext, 'b')).toBeNull()
    expect(ctx.identityOf(new RequestContext(), 'a')).toBeNull()
  })
  it('缺失 messageId 清理旧身份，错误线程和不一致 runId 拒绝', async () => {
    const ctx = createTasksContext()
    const request = ctx.prepareRequest('a')
    await ctx.processor.processInputStep!(step(request.requestContext, 'a', 'm'))
    expect(ctx.identityOf(request.requestContext, 'a')?.messageId).toBe('m')
    await ctx.processor.processInputStep!(step(request.requestContext, 'a'))
    expect(ctx.identityOf(request.requestContext, 'a')).toBeNull()
    await ctx.processor.processInputStep!(step(request.requestContext, 'b', 'm'))
    expect(ctx.identityOf(request.requestContext, 'a')).toBeNull()
    expect(() =>
      ctx.processor.processInputStep!(step(request.requestContext, 'a', 'm', 'wrong-run'))
    ).toThrow('runId 不一致')
  })
})
