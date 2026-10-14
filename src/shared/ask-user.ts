import { z } from './zod'

const TEXT_MAX = 4000
const DESCRIPTION_MAX = 2000
const OTHER_TEXT_MAX = 2000

const text = z.string().trim().min(1).max(TEXT_MAX)

export const askUserOptionSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(TEXT_MAX),
  description: z.string().trim().min(1).max(DESCRIPTION_MAX).optional(),
  recommended: z.boolean().optional()
})

export const askUserQuestionSchema = z.object({
  id: z.string().trim().min(1).max(200),
  header: z.string().trim().min(1).max(200),
  question: text,
  options: z.array(askUserOptionSchema).min(2).max(4),
  multiSelect: z.boolean().optional()
})

export const askUserInputSchema = z.object({
  questions: z.array(askUserQuestionSchema).min(1).max(4)
})

export const askUserAnswerSchema = z.object({
  status: z.literal('answered'),
  answers: z
    .array(
      z.object({
        questionId: z.string().trim().min(1).max(200),
        selectedOptionIds: z.array(z.string().trim().min(1).max(200)).max(4),
        otherText: z.string().trim().max(OTHER_TEXT_MAX).optional()
      })
    )
    .min(1)
    .max(4)
})

export const askUserOutputSchema = z.object({
  status: z.literal('answered'),
  questions: z.array(askUserQuestionSchema).min(1).max(4),
  answers: z.array(
    z.object({
      questionId: z.string(),
      selectedOptionIds: z.array(z.string()),
      selectedLabels: z.array(z.string()),
      otherText: z.string().optional()
    })
  )
})

export type AskUserInput = z.infer<typeof askUserInputSchema>
export type AskUserAnswer = z.infer<typeof askUserAnswerSchema>
export type AskUserOutput = z.infer<typeof askUserOutputSchema>

export function validateAskUserInput(value: unknown): AskUserInput {
  const input = askUserInputSchema.parse(value)
  const questionIds = new Set<string>()
  for (const question of input.questions) {
    if (questionIds.has(question.id)) throw new Error(`问题 ID 重复：${question.id}`)
    questionIds.add(question.id)
    const optionIds = new Set<string>()
    const labels = new Set<string>()
    let recommended = 0
    for (const option of question.options) {
      if (optionIds.has(option.id)) throw new Error(`选项 ID 重复：${option.id}`)
      if (labels.has(option.label)) throw new Error(`选项 label 重复：${option.label}`)
      optionIds.add(option.id)
      labels.add(option.label)
      if (option.recommended === true) recommended += 1
    }
    if (recommended > 1) throw new Error(`问题「${question.id}」至多只能有一个推荐项`)
  }
  return input
}

export function validateAskUserAnswer(input: AskUserInput, value: unknown): AskUserAnswer {
  const answer = askUserAnswerSchema.parse(value)
  if (answer.answers.length !== input.questions.length) throw new Error('必须一次回答全部问题')
  const questionIds = new Set(input.questions.map((question) => question.id))
  const seen = new Set<string>()
  for (const item of answer.answers) {
    if (!questionIds.has(item.questionId)) throw new Error(`未知问题 ID：${item.questionId}`)
    if (seen.has(item.questionId)) throw new Error(`问题重复回答：${item.questionId}`)
    seen.add(item.questionId)
    const question = input.questions.find((candidate) => candidate.id === item.questionId)!
    const optionIds = new Set(question.options.map((option) => option.id))
    const selected = new Set<string>()
    for (const id of item.selectedOptionIds) {
      if (!optionIds.has(id)) throw new Error(`问题「${item.questionId}」包含未知选项 ID：${id}`)
      if (selected.has(id)) throw new Error(`问题「${item.questionId}」选项重复`)
      selected.add(id)
    }
    const hasOther = item.otherText !== undefined && item.otherText.trim() !== ''
    if (!hasOther) delete item.otherText
    if (question.multiSelect === true) {
      if (selected.size === 0 && !hasOther)
        throw new Error(`问题「${item.questionId}」至少选择一项或填写其它`)
    } else if ((selected.size > 0 && hasOther) || selected.size + (hasOther ? 1 : 0) !== 1) {
      throw new Error(`问题「${item.questionId}」必须选择一个选项或填写其它，二者互斥`)
    }
  }
  if (seen.size !== questionIds.size) throw new Error('必须一次回答全部问题')
  return answer
}

export function askUserOutput(input: AskUserInput, answer: AskUserAnswer): AskUserOutput {
  return {
    status: 'answered',
    questions: input.questions,
    answers: answer.answers.map((item) => {
      const question = input.questions.find((candidate) => candidate.id === item.questionId)!
      const labels = new Map(question.options.map((option) => [option.id, option.label]))
      return {
        questionId: item.questionId,
        selectedOptionIds: item.selectedOptionIds,
        selectedLabels: item.selectedOptionIds.map((id) => labels.get(id)!),
        ...(item.otherText === undefined ? {} : { otherText: item.otherText.trim() })
      }
    })
  }
}
