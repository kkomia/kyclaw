import { describe, expect, it } from 'vitest'
import { askUserInputSchema, validateAskUserAnswer, validateAskUserInput } from '../ask-user'

const input = {
  questions: [
    {
      id: 'format',
      header: 'Format',
      question: 'Which format should I use?',
      options: [
        { id: 'pdf', label: 'PDF', recommended: true },
        { id: 'docx', label: 'Word' }
      ]
    },
    {
      id: 'tone',
      header: 'Tone',
      question: 'Which tone?',
      multiSelect: true,
      options: [
        { id: 'brief', label: 'Brief' },
        { id: 'detailed', label: 'Detailed' }
      ]
    }
  ]
}

describe('askUserInputSchema', () => {
  it('accepts bounded question/option counts', () => {
    expect(askUserInputSchema.safeParse(input).success).toBe(true)
    expect(askUserInputSchema.safeParse({ questions: [] }).success).toBe(false)
  })

  it('rejects duplicate ids and labels, and multiple recommendations', () => {
    expect(() =>
      validateAskUserInput({
        questions: [
          { ...input.questions[0], id: 'format' },
          { ...input.questions[0], id: 'format' }
        ]
      })
    ).toThrow(/问题 ID 重复/)
    expect(() =>
      validateAskUserInput({
        questions: [
          {
            ...input.questions[0],
            options: [
              { id: 'a', label: 'Same' },
              { id: 'b', label: 'Same' }
            ]
          }
        ]
      })
    ).toThrow(/label 重复/)
    expect(() =>
      validateAskUserInput({
        questions: [
          {
            ...input.questions[0],
            options: [
              { id: 'a', label: 'A', recommended: true },
              { id: 'b', label: 'B', recommended: true }
            ]
          }
        ]
      })
    ).toThrow(/推荐项/)
  })
})

describe('validateAskUserAnswer', () => {
  it('accepts complete answers, including multi-select plus trimmed other text', () => {
    const parsed = validateAskUserInput(input)
    expect(
      validateAskUserAnswer(parsed, {
        status: 'answered',
        answers: [
          { questionId: 'format', selectedOptionIds: ['pdf'] },
          { questionId: 'tone', selectedOptionIds: ['brief'], otherText: '  Match house style  ' }
        ]
      }).answers[1].otherText
    ).toBe('Match house style')
  })

  it('rejects missing/unknown/duplicate answers and invalid selection cardinality', () => {
    const parsed = validateAskUserInput(input)
    expect(() => validateAskUserAnswer(parsed, { status: 'answered', answers: [] })).toThrow()
    expect(() =>
      validateAskUserAnswer(parsed, {
        status: 'answered',
        answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
      })
    ).toThrow(/全部问题/)
    expect(
      validateAskUserAnswer(parsed, {
        status: 'answered',
        answers: [
          { questionId: 'format', selectedOptionIds: ['pdf'], otherText: '   ' },
          { questionId: 'tone', selectedOptionIds: ['brief'] }
        ]
      }).answers[0]
    ).not.toHaveProperty('otherText')
    expect(() =>
      validateAskUserAnswer(parsed, {
        status: 'answered',
        answers: [
          { questionId: 'unknown', selectedOptionIds: ['pdf'] },
          { questionId: 'tone', selectedOptionIds: ['brief'] }
        ]
      })
    ).toThrow(/未知问题/)
    expect(() =>
      validateAskUserAnswer(parsed, {
        status: 'answered',
        answers: [
          { questionId: 'format', selectedOptionIds: ['pdf', 'docx'] },
          { questionId: 'tone', selectedOptionIds: ['brief'] }
        ]
      })
    ).toThrow(/必须选择一个/)
    expect(() =>
      validateAskUserAnswer(parsed, {
        status: 'answered',
        answers: [
          { questionId: 'format', selectedOptionIds: ['pdf'], otherText: 'also' },
          { questionId: 'tone', selectedOptionIds: ['brief'] }
        ]
      })
    ).toThrow(/互斥/)
    expect(() =>
      validateAskUserAnswer(parsed, {
        status: 'answered',
        answers: [
          { questionId: 'format', selectedOptionIds: ['pdf'] },
          { questionId: 'tone', selectedOptionIds: ['brief', 'brief'] }
        ]
      })
    ).toThrow(/重复/)
  })
})
