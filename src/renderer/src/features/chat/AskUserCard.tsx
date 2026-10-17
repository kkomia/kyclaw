import { useId, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Textarea } from '@renderer/components/ui/input'
import { validateAskUserAnswer, type AskUserAnswer, type AskUserInput } from '@shared/ask-user'
import {
  ASK_USER_OTHER_TEXT_MAX,
  askUserQuestionDraft,
  type AskUserDraft,
  type AskUserQuestionDraft
} from './ask-user-ui'

/** 单道问题（服务端协议里的一题；不从 shared 另开导出，直接用输入类型的那一格） */
type AskUserQuestion = AskUserInput['questions'][number]
/** 单道题的答案（整包 answers 里的一项） */
type AskUserAnswerItem = AskUserAnswer['answers'][number]

/**
 * 模型自己塞进来的「其他」选项（round 83 用户口径「这俩选项要合并成一个」）——形如「其他」
 * 「其他（我在回答里补充）」「Other (please specify)」。卡片本来就有一条内置的「其它 + 输入框」，
 * 两者说的是同一件事，一起铺出来就是两条重样的行。
 *
 * 判定刻意收窄：只有「其他 / 其它 / other」**单独成词**（其后是结尾、括号、冒号或空白）才算，
 * 「其它格式」这类正常选项一律不动。
 */
const ASK_USER_OTHER_LABEL = /^(?:其他|其它|other)(?:$|[（(\s:：])/iu

export interface AskUserCardProps {
  input: AskUserInput
  draft: AskUserDraft
  onDraftChange: (draft: AskUserDraft) => void
  onSubmit: (answer: AskUserAnswer) => void
  onStop: () => void
  submitting?: boolean
  stopping?: boolean
  error?: string | null
}

/**
 * 提问卡（round 81 起**一次只铺一道题**；round 82 三处形态调整）。
 *
 * 为什么分页（用户口径「AskUser多题真正分页」）：多题平铺时一屏里塞着四五个 fieldset，
 * 输入框被挤到看不见，用户也不知道"还剩几题、现在在第几题"。现在每次只渲染 `questions[page]`
 * 那一道，配一枚「第 x/y 题」与上一题 / 下一题；最后一题才给「提交全部回答」。
 *
 * 三条硬口径：
 *   - **草稿仍归父层**（受控；翻页只是换渲染哪一道题，选中项 / 多选 / 「其它」文本一个字不动）；
 *   - **下一题校验当前题**、**提交校验全部题并跳到第一道没答的题** —— 不静默丢回答；
 *   - **仍是一次请求提交完整 answers**（`validateAskUserAnswer` 一次冻结全题），服务端问答协议不变。
 *
 * 换页状态不新增平行草稿源：分页只记「第几题」，且与"这一份问题清单"绑在一起 —— 清单变了
 * （同一调用换了题 / 换了请求）就回到第一题。请求整体的更换由 AskUserDock 的 key 重挂兜底。
 * 单题不给翻页器（没有可翻的），提交中一切控件禁用（不重复提交）。
 *
 * round 82（用户口径，形态三改）：
 *   ① **取消移右上角**：底部的「停止本轮」去掉，改成卡片右上角一枚 `×`（`取消本轮提问`）。
 *      它走的是**同一个取消 handler**（`onStop`）与同一份禁用口径（`stopping` 时禁用，
 *      提交中不禁用）—— 只是换了位置，不是把取消藏起来留一个悬挂调用。
 *   ② **「其它」选项就是输入框**：原先"先勾其它、下方再冒出 textarea"，现在选项行里直接是输入框，
 *      焦点或输入即自然选中「其它」（单选替代原选择、多选与其它选项共存），不再有一次多余的点选。
 *      「其它」的校验语义一个字不动（勾了必须有非空文本；超长有上限），取消规则也照旧
 *      （单选换选别的项 / 多选取消勾选都只留草稿不交答案）。
 *   ③ **卡片自己不再滚**：底部操作行去掉 sticky 与内层夹高（见 AskUserDock），当前题完整撑开。
 *
 * round 83（用户口径「这俩选项要合并成一个」）：模型自带的「其他」选项（如「其他（我在回答里补充）」）
 * 与内置的「其它 + 输入框」是同一件事 —— 现在**只铺一条**：那一项不再作为独立选项行渲染，
 * 内置输入行的文案改用它的，它自己的 `recommended` 徽标与 `description`（含 radio 的 aria-describedby）
 * 一并搬过来，不静默丢提示（判定见 `ASK_USER_OTHER_LABEL`，正常选项不受影响）。答案形状与校验
 * 一个字不动（仍是 `otherText`，该选项 id 不再可点选；草稿只在内存里，带不走旧选中项）。
 * 同一轮还修掉一处实拍复现：**翻到末页的那次「下一题」顺带提交**——见底部操作行的 key 注释。
 */
export function AskUserCard({
  input,
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  submitting = false,
  stopping = false,
  error
}: AskUserCardProps): React.JSX.Element {
  const id = useId()
  const [validationErrors, setValidationErrors] = useState<Map<string, string>>(() => new Map())
  const busy = submitting || stopping
  const questions = input.questions
  const total = questions.length

  /** 分页状态与"这一份问题清单"绑定：清单变了就回到第一题（render 期按 props 调 state，同 CollapsibleRow） */
  const pageKey = questions.map((question) => question.id).join('\u0000')
  const [paging, setPaging] = useState({ key: pageKey, index: 0 })
  if (paging.key !== pageKey) setPaging({ key: pageKey, index: 0 })
  const page = paging.key === pageKey ? Math.min(paging.index, Math.max(0, total - 1)) : 0
  const goTo = (index: number): void => setPaging({ key: pageKey, index })

  const change = (questionId: string, next: AskUserQuestionDraft): void => {
    if (busy) return
    setValidationErrors(new Map())
    onDraftChange({ ...draft, [questionId]: next })
  }

  /** 一道题的答案形状（其它文本只在勾了「其它」时带上） */
  const answerOf = (question: AskUserQuestion, value: AskUserQuestionDraft): AskUserAnswerItem => ({
    questionId: question.id,
    selectedOptionIds: [...value.selectedOptionIds],
    ...(value.otherSelected ? { otherText: value.otherText } : {})
  })

  /** 单题校验：问题在哪就说哪句（与既有文案一致），没问题给 null */
  const problemOf = (question: AskUserQuestion): string | null => {
    const value = askUserQuestionDraft(draft, question.id)
    if (value.otherSelected && !value.otherText.trim()) return '请填写其它内容，或取消选择其它。'
    if (value.otherSelected && value.otherText.length > ASK_USER_OTHER_TEXT_MAX) {
      return `其它内容不能超过 ${ASK_USER_OTHER_TEXT_MAX} 字。`
    }
    try {
      validateAskUserAnswer(
        { questions: [question] },
        { status: 'answered', answers: [answerOf(question, value)] }
      )
    } catch {
      return question.multiSelect
        ? '请至少选择一项或填写其它内容。'
        : '请选择一个选项或填写其它内容，二者互斥。'
    }
    return null
  }

  /** 下一题：先校验当前题；没过就停在这一题（错误说清哪里没答） */
  const next = (): void => {
    if (busy) return
    const question = questions[page]
    const problem = question === undefined ? null : problemOf(question)
    setValidationErrors(
      problem === null || question === undefined ? new Map() : new Map([[question.id, problem]])
    )
    if (problem !== null) return
    goTo(Math.min(page + 1, total - 1))
  }

  /** 提交：校验**全题**，有漏就跳到第一道没答完的题；全过才一次性交出完整 answers */
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    const answers = questions.map((question) =>
      answerOf(question, askUserQuestionDraft(draft, question.id))
    )
    const errors = new Map<string, string>()
    for (const question of questions) {
      const problem = problemOf(question)
      if (problem !== null) errors.set(question.id, problem)
    }
    setValidationErrors(errors)
    if (errors.size > 0) {
      const first = questions.findIndex((question) => errors.has(question.id))
      if (first >= 0) goTo(first)
      return
    }
    onSubmit(validateAskUserAnswer(input, { status: 'answered', answers }))
  }

  const question = questions[page]
  const questionIndex = page
  const questionId = `${id}-question-${questionIndex}`
  const errorId = `${questionId}-error`
  const otherId = `${questionId}-other`
  const otherCountId = `${questionId}-count`
  /** 被合并进来的那条「其他」选项自己的说明（有才铺；id 交给合并行的 radio 用 aria-describedby 指） */
  const otherDescriptionId = `${questionId}-other-description`
  const value = question === undefined ? null : askUserQuestionDraft(draft, question.id)
  const questionError = question === undefined ? undefined : validationErrors.get(question.id)
  const controlType = question?.multiSelect === true ? 'checkbox' : 'radio'

  /**
   * 模型自带的「其他」选项（round 83）：并进内置「其它 + 输入框」那一行，不再铺成独立选项。
   * 按引用比较 —— 同一份 input 里的同一个对象，重渲染不会认错。
   */
  const mergedOther =
    question === undefined
      ? null
      : (question.options.find((option) => ASK_USER_OTHER_LABEL.test(option.label.trim())) ?? null)
  /** 真正铺出来的选项行：吸掉被合并的那一项（`optionIndex` 取过滤后的下标，描述 id 与 aria 同步） */
  const optionRows = (question === undefined ? [] : question.options).filter(
    (option) => option !== mergedOther
  )

  /**
   * 「其它」输入框被聚焦 / 输入时**自然选中其它**（round 82 用户口径）：点进输入框就等于选了这一项，
   * 不必先点一次「其它」。
   *   - 单选：替代原选择（与选项行互斥，同 `change` 的既有规则）；
   *   - 多选：与已勾的预设共存，不动 `selectedOptionIds`。
   * 只改"选中"这一格，`otherText` 仍由各自的 onChange 写 —— 清空输入不等于取消勾选，
   * 校验语义因此不变（勾了其它但没文本 = 提交时拦下）。
   */
  const activateOther = (): void => {
    if (busy || question === undefined || value === null || value.otherSelected) return
    change(question.id, {
      ...value,
      otherSelected: true,
      selectedOptionIds: question.multiSelect ? value.selectedOptionIds : []
    })
  }

  return (
    <form
      data-testid="ask-user-card"
      aria-label="回答问题"
      aria-busy={busy || undefined}
      onSubmit={submit}
      noValidate
      className="chat-dock-enter relative flex min-w-0 flex-col gap-3 rounded-panel border-(length:--hairline-width) border-surface-border bg-secondary px-3 py-2.5 [overflow-wrap:anywhere]"
    >
      {/* 取消在右上角（round 82 用户口径）：同一枚 onStop、同一份禁用口径 —— 只是从底部搬上来 */}
      <IconButton
        data-testid="ask-user-cancel"
        label="取消本轮提问"
        icon={<X />}
        disabled={stopping}
        onClick={() => {
          if (!stopping) onStop()
        }}
        className="absolute top-1 right-1 border-transparent hover:bg-hover"
      />
      {/* 右上角那枚 × 的位置留出来（pr-10），标题行换行也不会被它压住 */}
      <div className="flex min-w-0 flex-wrap items-center gap-2 pr-10 text-b2 text-ink">
        <span>需要你的回答</span>
        <span className="rounded-badge bg-(--fill-selected) px-1.5 py-0.5 text-c2 text-warning">
          {total} 个问题
        </span>
      </div>
      {question === undefined || value === null ? null : (
        <fieldset
          disabled={busy}
          aria-describedby={`${questionId}-prompt${questionError ? ` ${errorId}` : ''}`}
          className="min-w-0 space-y-2"
        >
          <legend className="max-w-full text-b2 font-medium text-ink">
            {question.header}
            <span className="ml-2 text-c1 font-normal text-ink-tertiary">
              {question.multiSelect ? '多选' : '单选'}
            </span>
          </legend>
          <p id={`${questionId}-prompt`} className="whitespace-pre-wrap text-b2 text-ink-secondary">
            {question.question}
          </p>
          {optionRows.map((option, optionIndex) => (
            <label
              key={option.id}
              className="flex min-w-0 items-start gap-2 rounded-control bg-surface px-2 py-2 text-b2 text-ink"
            >
              <input
                type={controlType}
                name={questionId}
                value={option.id}
                checked={value.selectedOptionIds.includes(option.id)}
                aria-invalid={questionError ? true : undefined}
                aria-describedby={
                  [
                    option.description ? `${questionId}-option-${optionIndex}` : '',
                    questionError ? errorId : ''
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                onChange={(event) =>
                  change(question.id, {
                    ...value,
                    selectedOptionIds: question.multiSelect
                      ? event.target.checked
                        ? [...value.selectedOptionIds, option.id]
                        : value.selectedOptionIds.filter((selected) => selected !== option.id)
                      : [option.id],
                    otherSelected: question.multiSelect ? value.otherSelected : false
                  })
                }
                className="mt-1 size-3.5 shrink-0 accent-(--text-primary)"
              />
              <span className="min-w-0 flex-1">
                <span className="whitespace-pre-wrap">{option.label}</span>
                {option.recommended ? (
                  <span className="ml-2 inline-block rounded-badge bg-(--fill-selected) px-1.5 py-0.5 text-c2 text-ink-secondary">
                    推荐
                  </span>
                ) : null}
                {option.description ? (
                  <span
                    id={`${questionId}-option-${optionIndex}`}
                    className="mt-1 block whitespace-pre-wrap text-c1 text-ink-secondary"
                  >
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
          {/* 「其它」选项行**直接就是输入框**（round 82 用户口径）：不再"先点其它、下方再冒出一个框"。
              焦点 / 输入自然选中其它（activateOther），清空输入不取消勾选 —— 校验语义与取消规则照旧。
              round 83：模型自带的「其他」选项被并进这一行（文案取它，选项行不再铺）—— 一行只此一条；
              它自己的 `recommended` / `description` 一并搬过来，不静默丢提示。 */}
          <div className="rounded-control bg-surface px-2 py-2">
            <div className="flex min-w-0 items-start gap-2">
              <label className="flex shrink-0 items-center gap-2 pt-2.5 text-b2 text-ink">
                <input
                  type={controlType}
                  name={questionId}
                  checked={value.otherSelected}
                  aria-invalid={questionError ? true : undefined}
                  aria-describedby={
                    [
                      mergedOther?.description ? otherDescriptionId : '',
                      questionError ? errorId : ''
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  onChange={(event) =>
                    change(question.id, {
                      ...value,
                      otherSelected: event.target.checked,
                      selectedOptionIds: question.multiSelect ? value.selectedOptionIds : []
                    })
                  }
                  className="size-3.5 shrink-0 accent-(--text-primary)"
                />
                <span className="min-w-0">
                  <span className="whitespace-pre-wrap">
                    {mergedOther === null ? '其它' : mergedOther.label.trim()}
                  </span>
                  {mergedOther?.recommended ? (
                    <span className="ml-2 inline-block rounded-badge bg-(--fill-selected) px-1.5 py-0.5 text-c2 text-ink-secondary">
                      推荐
                    </span>
                  ) : null}
                </span>
              </label>
              <div className="min-w-0 flex-1">
                <Textarea
                  id={otherId}
                  aria-label="其它内容"
                  placeholder="请填写内容"
                  rows={1}
                  value={value.otherText}
                  disabled={busy}
                  maxLength={ASK_USER_OTHER_TEXT_MAX}
                  aria-invalid={questionError ? true : undefined}
                  aria-describedby={
                    [value.otherText.length > 0 ? otherCountId : '', questionError ? errorId : '']
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  onFocus={activateOther}
                  onChange={(event) =>
                    change(question.id, {
                      ...value,
                      otherSelected: true,
                      otherText: event.target.value.slice(0, ASK_USER_OTHER_TEXT_MAX)
                    })
                  }
                  className="field-sizing-content max-h-40 min-w-0 border-surface-border [overflow-wrap:anywhere]"
                />
                {/* 计数只在有字时出现（没有字时这一行只是噪音）；没有它时 aria-describedby 也不指它 */}
                {value.otherText.length > 0 ? (
                  <p id={otherCountId} className="mt-1 text-c1 text-ink-tertiary">
                    {value.otherText.length}/{ASK_USER_OTHER_TEXT_MAX} 字
                  </p>
                ) : null}
              </div>
            </div>
            {/* 被合并选项的说明：与普通选项行同形（灰字一行），留在这一行的底色里 */}
            {mergedOther?.description ? (
              <p
                id={otherDescriptionId}
                className="mt-1 pl-6 whitespace-pre-wrap text-c1 text-ink-secondary"
              >
                {mergedOther.description}
              </p>
            ) : null}
          </div>
          {questionError ? (
            <p id={errorId} role="alert" className="text-c1 text-warning">
              {questionError}
            </p>
          ) : null}
        </fieldset>
      )}
      {error ? (
        <p role="alert" className="whitespace-pre-wrap text-c1 text-warning">
          {error}
        </p>
      ) : null}
      {/* 翻页 / 提交那一行：round 82 起不再 sticky、不再自带底色 —— 卡片自己不长高（见 AskUserDock），
          没有了内层滚动区也就没有"贴住"的对象；常流排在卡末即可。取消已移到右上角那枚 ×。 */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {total > 1 ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="ask-user-prev"
              disabled={busy || page === 0}
              onClick={() => goTo(Math.max(0, page - 1))}
            >
              上一题
            </Button>
            <span data-testid="ask-user-page" role="status" className="text-c1 text-ink-secondary">
              第 {page + 1}/{total} 题
            </span>
          </>
        ) : null}
        {/* 下一题 / 提交用**不同 key**（同一位置的两枚按钮）：不给 key 时 React 会把同一个 DOM 按钮
            就地改 `type`（button → submit），浏览器据此把**这次 click** 的默认动作判成提交 ——
            翻页顺带把整份答案校验一遍，末页立刻冒出下一题的校验提示（round 83 实拍复现）。
            不同 key = 重新挂载，被点的那个元素始终是 `type=button`，默认动作落空；
            真正的提交行为一个字不动（末页那枚仍是 `type=submit`，走表单 onSubmit）。 */}
        {total > 1 && page < total - 1 ? (
          <Button
            key="ask-user-next"
            type="button"
            size="sm"
            data-testid="ask-user-next"
            disabled={busy}
            onClick={next}
          >
            下一题
          </Button>
        ) : (
          <Button
            key="ask-user-submit"
            type="submit"
            size="sm"
            disabled={busy}
            loading={submitting}
          >
            提交全部回答
          </Button>
        )}
      </div>
    </form>
  )
}
