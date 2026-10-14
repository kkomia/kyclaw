import type { Tool } from '@mastra/core/tools'
import {
  askUserInputSchema,
  askUserOutputSchema,
  askUserOutput,
  validateAskUserAnswer,
  validateAskUserInput,
  type AskUserInput,
  type AskUserOutput
} from '../../shared/ask-user'

export async function createAskUserTool(): Promise<Tool<AskUserInput, AskUserOutput>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'ask_user',
    description:
      "Ask the user for a small set of related choices only when their answer changes the next step. Use the user's language for all questions and choices. Combine related questions into one call, recommend one option without treating it as authorization, and do not ask again for a choice or authorization the user already explicitly gave.",
    inputSchema: askUserInputSchema,
    outputSchema: askUserOutputSchema,
    execute: async (rawInput, context) => {
      const input = validateAskUserInput(rawInput)
      const agent = context?.agent
      const resumeData = agent?.resumeData
      if (resumeData !== undefined) {
        return askUserOutput(input, validateAskUserAnswer(input, resumeData))
      }
      if (agent?.suspend === undefined) {
        throw new Error('ask_user 只支持在 agent 对话上下文中交互，当前调用不支持挂起')
      }
      await agent.suspend(input)
      return undefined as never
    }
  })
}
