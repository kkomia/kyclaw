import { MessageList } from '@mastra/core/agent'
import { describe, expect, it } from 'vitest'
import { createRulesProcessor, RULES_PROCESSOR_ID } from '../rules'

describe('规则系统消息生命周期', () => {
  it('真实 MessageList 多轮重复、切项目、清空不积累旧规则，其他系统消息不变', async () => {
    const messageList = new MessageList()
    messageList.addSystem('应用硬约束')
    messageList.addSystem('其他处理器', 'other')
    let projectId: string | null = 'a'
    let global = '全局'
    const processor = createRulesProcessor({
      sessionProjects: { get: () => projectId },
      projects: () => ['a', 'b'].map((id) => ({ id, name: id, path: id, createdAt: '' })),
      readGlobalRules: () => ({ text: global, diagnostics: [] }),
      readProjectRules: (project) => ({ text: `项目-${project.id}`, diagnostics: [] }),
      onDiagnostics: () => {
        throw new Error('观察者故障')
      }
    })
    const input = processor.processInput as unknown as (args: unknown) => Promise<unknown>
    const args = { messageList, requestContext: { get: () => ({ thread: { id: 't' } }) } }
    await input(args)
    await input(args)
    expect(messageList.getSystemMessages(RULES_PROCESSOR_ID)).toHaveLength(1)
    projectId = 'b'
    await input(args)
    expect(JSON.stringify(messageList.getSystemMessages(RULES_PROCESSOR_ID))).toContain('项目-b')
    expect(JSON.stringify(messageList.getSystemMessages(RULES_PROCESSOR_ID))).not.toContain(
      '项目-a'
    )
    global = ''
    projectId = null
    await input(args)
    expect(messageList.getSystemMessages(RULES_PROCESSOR_ID)).toEqual([])
    expect(messageList.getAllSystemMessages().map((message) => message.content)).toEqual([
      '应用硬约束',
      '其他处理器'
    ])
  })
})
