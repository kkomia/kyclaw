/**
 * kyclaw agent 的装配（身份 + 模型 + 工具集）。
 *
 * 工具集本任务固定为空：文件/命令类工具在 T11 才进来，现在先不假装有——
 * system 指令里也照实说明"还没有工具"，免得模型编造执行结果。
 * Agent 类是 ESM-only（@mastra/core），所以工厂是异步的：运行时靠动态 import() 拿。
 */
import type { Agent } from '@mastra/core/agent'
import type { KyclawModel } from '../model'

/** agent id：chat 路由 /chat/kyclaw-agent 与 IPC 契约里都用它 */
export const KYCLAW_AGENT_ID = 'kyclaw-agent'

/** kyclaw 的身份与行为底线（本任务只有身份，不做人格化/话题设定） */
export const KYCLAW_INSTRUCTIONS = `你是 kyclaw，运行在用户自己电脑上的个人 AI agent。
- 默认用用户的语言回答（中文提问就用中文），先给结论，再给必要的细节。
- 你只能看到用户在这个对话里给你的内容；不确定就直说，不要编造事实或执行结果。
- 当前没有挂任何工具：需要读写文件、跑命令时如实说明你做不到，不要假装做过。`

export async function createKyclawAgent(model: KyclawModel): Promise<Agent> {
  const { Agent: AgentClass } = await import('@mastra/core/agent')

  return new AgentClass({
    id: KYCLAW_AGENT_ID,
    name: KYCLAW_AGENT_ID,
    instructions: KYCLAW_INSTRUCTIONS,
    model,
    tools: {}
  })
}
