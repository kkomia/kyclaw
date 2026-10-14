import type { AskUserInput } from '@shared/ask-user'

export interface AskUserQuestionDraft {
  readonly selectedOptionIds: readonly string[]
  readonly otherSelected: boolean
  readonly otherText: string
}

export type AskUserDraft = Readonly<Record<string, AskUserQuestionDraft | undefined>>

export interface AskUserCallIdentity {
  readonly threadId: string
  readonly runId: string
  readonly toolCallId: string
}

export const ASK_USER_OTHER_TEXT_MAX = 2000

export const EMPTY_ASK_USER_QUESTION_DRAFT: AskUserQuestionDraft = {
  selectedOptionIds: [],
  otherSelected: false,
  otherText: ''
}

export function askUserQuestionDraft(
  draft: AskUserDraft,
  questionId: string
): AskUserQuestionDraft {
  return Object.prototype.hasOwnProperty.call(draft, questionId)
    ? (draft[questionId] ?? EMPTY_ASK_USER_QUESTION_DRAFT)
    : EMPTY_ASK_USER_QUESTION_DRAFT
}

export function createAskUserDraft(input: AskUserInput): AskUserDraft {
  return Object.fromEntries(
    input.questions.map((question) => [
      question.id,
      { selectedOptionIds: [], otherSelected: false, otherText: '' }
    ])
  )
}

export function askUserCallKey(identity: AskUserCallIdentity): string {
  return JSON.stringify([identity.threadId, identity.runId, identity.toolCallId])
}
