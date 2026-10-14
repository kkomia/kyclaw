import { describe, expect, it } from 'vitest'
import { createAskUserTool } from '../ask-user'
import { validateAskUserInput } from '../../../shared/ask-user'

const questionInput = {
  questions: [
    {
      id: 'format',
      header: 'Format',
      question: 'Which format should I use?',
      options: [
        { id: 'pdf', label: 'PDF', recommended: true },
        { id: 'docx', label: 'Word' }
      ]
    }
  ]
}

describe('ask_user tool', () => {
  it('suspends the complete validated question set on the initial call', async () => {
    const tool = await createAskUserTool()
    let payload: unknown
    const result = await tool.execute!(questionInput, {
      agent: {
        suspend: async (value: unknown) => {
          payload = value
        }
      }
    } as never)
    expect(payload).toEqual(validateAskUserInput(questionInput))
    expect(result).toBeUndefined()
  })

  it('validates resumeData and returns original questions with selected labels', async () => {
    const tool = await createAskUserTool()
    const result = await tool.execute!(questionInput, {
      agent: {
        resumeData: {
          status: 'answered',
          answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
        }
      }
    } as never)
    expect(result).toEqual({
      status: 'answered',
      questions: questionInput.questions,
      answers: [{ questionId: 'format', selectedOptionIds: ['pdf'], selectedLabels: ['PDF'] }]
    })
  })

  it('fails clearly outside an interactive agent context', async () => {
    const tool = await createAskUserTool()
    await expect(tool.execute!(questionInput, {} as never)).rejects.toThrow(/不支持挂起/)
  })
})
