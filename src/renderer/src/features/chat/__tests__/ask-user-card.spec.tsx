import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AskUserAnswer, AskUserInput } from '@shared/ask-user'
import { AskUserCard, type AskUserCardProps } from '../AskUserCard'
import { createAskUserDraft, type AskUserDraft } from '../ask-user-ui'

const input: AskUserInput = {
  questions: [
    {
      id: 'format',
      header: '格式',
      question: '选择输出格式',
      options: [
        { id: 'pdf', label: 'PDF', description: '适合阅读', recommended: true },
        { id: 'docx', label: 'Word' }
      ]
    },
    {
      id: 'content',
      header: '内容',
      question: '选择需要的内容',
      multiSelect: true,
      options: [
        { id: 'summary', label: '摘要' },
        { id: 'details', label: '明细' }
      ]
    }
  ]
}

function Harness({
  initialDraft = createAskUserDraft(input),
  onDraftChange = () => {},
  ...props
}: Omit<AskUserCardProps, 'draft' | 'onDraftChange'> & {
  initialDraft?: AskUserDraft
  onDraftChange?: (draft: AskUserDraft) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(initialDraft)
  return (
    <AskUserCard
      {...props}
      draft={draft}
      onDraftChange={(next) => {
        setDraft(next)
        onDraftChange(next)
      }}
    />
  )
}

function setup(overrides: Partial<AskUserCardProps> = {}): {
  onSubmit: ReturnType<typeof vi.fn<(answer: AskUserAnswer) => void>>
  onStop: ReturnType<typeof vi.fn<() => void>>
} {
  const onSubmit = vi.fn<(answer: AskUserAnswer) => void>()
  const onStop = vi.fn<() => void>()
  render(<Harness input={input} onSubmit={onSubmit} onStop={onStop} {...overrides} />)
  return { onSubmit, onStop }
}

function group(header: string): HTMLElement {
  return screen.getByRole('group', { name: new RegExp(header) })
}

function nextPage(): void {
  fireEvent.click(screen.getByTestId('ask-user-next'))
}

function previousPage(): void {
  fireEvent.click(screen.getByTestId('ask-user-prev'))
}

function submitForm(): void {
  fireEvent.submit(screen.getByRole('form', { name: '回答问题' }))
}

function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: '提交全部回答' })
}

function completePresetAnswers(): void {
  fireEvent.click(screen.getByRole('radio', { name: /PDF/ }))
  nextPage()
  fireEvent.click(screen.getByRole('checkbox', { name: '摘要' }))
}

describe('AskUserCard', () => {
  it.each(['__proto__', 'constructor', 'toString'])(
    '有效问题 ID %s 不读取继承属性，空草稿报错且可正常回答',
    (questionId) => {
      const specialInput: AskUserInput = {
        questions: [{ ...input.questions[0], id: questionId }]
      }
      const onSubmit = vi.fn()
      const onDraftChange = vi.fn()
      expect(() =>
        render(
          <Harness
            input={specialInput}
            initialDraft={{}}
            onDraftChange={onDraftChange}
            onSubmit={onSubmit}
            onStop={vi.fn()}
          />
        )
      ).not.toThrow()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(() => fireEvent.click(submitButton())).not.toThrow()
      expect(onSubmit).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent('请选择一个选项')
      fireEvent.click(screen.getByRole('radio', { name: /PDF/ }))
      const next = onDraftChange.mock.calls[0][0] as AskUserDraft
      expect(Object.prototype.hasOwnProperty.call(next, questionId)).toBe(true)
      expect(Object.getPrototypeOf(next)).toBe(Object.prototype)
      fireEvent.click(submitButton())
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        status: 'answered',
        answers: [{ questionId, selectedOptionIds: ['pdf'] }]
      })
      const initialized = createAskUserDraft(specialInput)
      expect(Object.prototype.hasOwnProperty.call(initialized, questionId)).toBe(true)
      expect(initialized[questionId]?.selectedOptionIds).toEqual([])
    }
  )

  it('一次只铺一道题：位置指示与上一题/下一题，最后一题才给提交', () => {
    setup()
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 1/2 题')
    expect(screen.getByTestId('ask-user-prev')).toBeDisabled()
    expect(screen.queryByRole('button', { name: '提交全部回答' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /PDF/ }))
    nextPage()
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 2/2 题')
    expect(screen.getByTestId('ask-user-prev')).toBeEnabled()
    expect(screen.queryByTestId('ask-user-next')).not.toBeInTheDocument()
    expect(submitButton()).toBeEnabled()
    previousPage()
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 1/2 题')
    // 翻页不丢草稿：回到第一题还是刚才那个选择
    expect(screen.getByRole('radio', { name: /PDF/ })).toBeChecked()
  })

  it('推荐不预选，题目使用 fieldset/legend，描述关联选项，每题带单选/多选标记', () => {
    setup()
    expect(screen.getByText('推荐')).toBeInTheDocument()
    expect(screen.getAllByRole('group')).toHaveLength(1)
    for (const control of screen.getAllByRole('radio')) expect(control).not.toBeChecked()
    expect(group('格式').tagName).toBe('FIELDSET')
    expect(group('格式').querySelector('legend')).toHaveTextContent('格式')
    expect(screen.getByRole('radio', { name: /PDF/ })).toHaveAccessibleDescription('适合阅读')
    expect(group('格式')).toHaveAccessibleDescription('选择输出格式')
    expect(group('格式').querySelector('legend')).toHaveTextContent('单选')
    fireEvent.click(screen.getByRole('radio', { name: /PDF/ }))
    nextPage()
    expect(group('内容').querySelector('legend')).toHaveTextContent('多选')
    expect(screen.getAllByRole('group')).toHaveLength(1)
    for (const control of screen.getAllByRole('checkbox')) expect(control).not.toBeChecked()
  })

  it('草稿受控：只通知父层，不偷偷更新选择', () => {
    const onDraftChange = vi.fn()
    render(
      <AskUserCard
        input={input}
        draft={{}}
        onDraftChange={onDraftChange}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('radio', { name: /PDF/ }))
    expect(onDraftChange).toHaveBeenCalledWith({
      format: { selectedOptionIds: ['pdf'], otherSelected: false, otherText: '' }
    })
    expect(screen.getByRole('radio', { name: /PDF/ })).not.toBeChecked()
  })

  it('下一题只校验当前题（不放过也不越题），末页提交一次交出全部答案', () => {
    const { onSubmit } = setup()
    nextPage()
    // 当前题没答：停在原地并把话说清
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 1/2 题')
    expect(screen.getByRole('alert')).toHaveTextContent('请选择一个选项')
    expect(screen.getByRole('radio', { name: /PDF/ })).toHaveAttribute('aria-invalid', 'true')
    fireEvent.click(screen.getByRole('radio', { name: /PDF/ }))
    nextPage()
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 2/2 题')
    fireEvent.click(submitButton())
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 2/2 题')
    expect(screen.getByRole('alert')).toHaveTextContent('请至少选择一项')
    fireEvent.click(screen.getByRole('checkbox', { name: '摘要' }))
    fireEvent.click(submitButton())
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      status: 'answered',
      answers: [
        { questionId: 'format', selectedOptionIds: ['pdf'] },
        { questionId: 'content', selectedOptionIds: ['summary'] }
      ]
    })
  })

  it('提交校验全题并跳到第一道没答完的题（外层草稿被刷新也不放过）', () => {
    const onSubmit = vi.fn()
    const answered: AskUserDraft = {
      format: { selectedOptionIds: ['pdf'], otherSelected: false, otherText: '' },
      content: { selectedOptionIds: ['summary'], otherSelected: false, otherText: '' }
    }
    const { rerender } = render(
      <AskUserCard
        input={input}
        draft={answered}
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
        onStop={vi.fn()}
      />
    )
    nextPage()
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 2/2 题')
    // 外层草稿被刷新（服务端重取把第一题清空了）：人还停在末页，一次提交要跳回第一道没答完的题
    rerender(
      <AskUserCard
        input={input}
        draft={{}}
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
        onStop={vi.fn()}
      />
    )
    fireEvent.click(submitButton())
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 1/2 题')
    expect(screen.getByRole('alert')).toHaveTextContent('请选择一个选项')
  })

  it('「其它」就是选项行里的输入框：聚焦即选中（单选替代原选择），文本切走保留但不随预设答案提交', () => {
    const { onSubmit } = setup()
    fireEvent.click(screen.getByRole('radio', { name: /PDF/ }))
    const other = within(group('格式')).getByRole('textbox', { name: '其它内容' })
    // 不必先点「其它」：聚焦输入框就等于选了这一项，单选互斥地把原选择顶掉
    fireEvent.focus(other)
    expect(screen.getByRole('radio', { name: '其它' })).toBeChecked()
    expect(screen.getByRole('radio', { name: /PDF/ })).not.toBeChecked()
    fireEvent.change(other, { target: { value: ' Markdown ' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Word' }))
    expect(screen.getByRole('radio', { name: '其它' })).not.toBeChecked()
    nextPage()
    fireEvent.click(screen.getByRole('checkbox', { name: '摘要' }))
    fireEvent.click(submitButton())
    expect(onSubmit.mock.calls[0][0].answers[0]).toEqual({
      questionId: 'format',
      selectedOptionIds: ['docx']
    })
    // 翻回第一题：切走时留下的「其它」文本还在（翻页不丢草稿）
    previousPage()
    const back = within(group('格式')).getByRole('textbox', { name: '其它内容' })
    expect(back).toHaveValue(' Markdown ')
    fireEvent.focus(back)
    nextPage()
    fireEvent.click(submitButton())
    expect(onSubmit.mock.calls[1][0].answers[0]).toEqual({
      questionId: 'format',
      selectedOptionIds: [],
      otherText: 'Markdown'
    })
  })

  it('多选与其它共存：输入即勾上其它且不动已勾预设，取消勾选仅保留预设', () => {
    const { onSubmit } = setup()
    completePresetAnswers()
    const multiple = within(group('内容'))
    fireEvent.click(multiple.getByRole('checkbox', { name: '明细' }))
    fireEvent.change(multiple.getByRole('textbox', { name: '其它内容' }), {
      target: { value: '附录' }
    })
    expect(multiple.getByRole('checkbox', { name: '其它' })).toBeChecked()
    expect(multiple.getByRole('checkbox', { name: '摘要' })).toBeChecked()
    fireEvent.click(submitButton())
    expect(onSubmit.mock.calls[0][0].answers[1]).toEqual({
      questionId: 'content',
      selectedOptionIds: ['summary', 'details'],
      otherText: '附录'
    })
    fireEvent.click(multiple.getByRole('checkbox', { name: '摘要' }))
    fireEvent.click(multiple.getByRole('checkbox', { name: '其它' }))
    fireEvent.click(submitButton())
    expect(onSubmit.mock.calls[1][0].answers[1]).toEqual({
      questionId: 'content',
      selectedOptionIds: ['details']
    })
  })

  it('选中其它必须有非空文本，即使多选已有预设也不能提交空其它', () => {
    const { onSubmit } = setup()
    completePresetAnswers()
    fireEvent.change(within(group('内容')).getByRole('textbox', { name: '其它内容' }), {
      target: { value: '  ' }
    })
    fireEvent.click(submitButton())
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('请填写其它内容')
  })

  it('其它文本上限 2000，输入截断并显示计数；空文本时不铺计数行', () => {
    setup()
    const other = within(group('格式')).getByRole('textbox', { name: '其它内容' })
    expect(other).toHaveAttribute('maxlength', '2000')
    expect(screen.queryByText(/\/2000 字/)).not.toBeInTheDocument()
    fireEvent.change(other, { target: { value: '字'.repeat(2001) } })
    expect(other).toHaveValue('字'.repeat(2000))
    expect(screen.getByText('2000/2000 字')).toBeInTheDocument()
    expect(within(group('格式')).getByRole('radio', { name: '其它' })).toBeChecked()
  })

  it('恢复的超长其它草稿仍必须校验，不能依赖 DOM maxlength', () => {
    const onSubmit = vi.fn()
    render(
      <Harness
        input={input}
        initialDraft={{
          format: { selectedOptionIds: [], otherSelected: true, otherText: '字'.repeat(2001) },
          content: { selectedOptionIds: ['summary'], otherSelected: false, otherText: '' }
        }}
        onSubmit={onSubmit}
        onStop={vi.fn()}
      />
    )
    submitForm()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('不能超过 2000')
  })

  it('单题不给无意义翻页器，提交钮就在原地', () => {
    const single = { questions: [input.questions[0]] }
    render(
      <Harness
        input={single}
        initialDraft={createAskUserDraft(single)}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
      />
    )
    expect(screen.queryByTestId('ask-user-page')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ask-user-prev')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ask-user-next')).not.toBeInTheDocument()
    expect(submitButton()).toBeInTheDocument()
  })

  it('右上角「取消本轮提问」独立于答案有效性（同一个 onStop），不触发提交，底部不再有停止钮', () => {
    const { onStop, onSubmit } = setup()
    expect(screen.queryByRole('button', { name: '停止本轮' })).not.toBeInTheDocument()
    const cancel = screen.getByRole('button', { name: '取消本轮提问' })
    expect(cancel).toHaveAttribute('data-testid', 'ask-user-cancel')
    fireEvent.click(cancel)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['submitting', 'stopping'] as const)(
    '%s 时控件与草稿禁用，表单事件也不能重复提交',
    (pending) => {
      const { onSubmit, onStop } = setup({ [pending]: true, error: '服务暂时不可用' })
      expect(screen.getByTestId('ask-user-next')).toBeDisabled()
      expect(screen.getByTestId('ask-user-prev')).toBeDisabled()
      expect(screen.getByRole('radio', { name: /PDF/ })).toBeDisabled()
      expect(screen.getByRole('textbox', { name: '其它内容' })).toBeDisabled()
      expect(screen.getByRole('form', { name: '回答问题' })).toHaveAttribute('aria-busy', 'true')
      submitForm()
      expect(onSubmit).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent('服务暂时不可用')
      // 取消的禁用口径沿用原来的停止钮：只有 stopping 时禁用（提交中仍可取消，且点了也只走一次 onStop）
      const cancel = screen.getByRole('button', { name: '取消本轮提问' })
      if (pending === 'stopping') {
        expect(cancel).toBeDisabled()
        fireEvent.click(cancel)
        expect(onStop).not.toHaveBeenCalled()
      } else {
        expect(cancel).toBeEnabled()
      }
    }
  )

  it('submitting 时单题的提交钮也禁用（不重复提交）', () => {
    const single = { questions: [input.questions[0]] }
    render(
      <Harness
        input={single}
        initialDraft={createAskUserDraft(single)}
        submitting
        onSubmit={vi.fn()}
        onStop={vi.fn()}
      />
    )
    expect(submitButton()).toBeDisabled()
  })

  it('原生可聚焦控件和 form 提交支持键盘路径，其它 textarea 不劫持 Enter', () => {
    const { onSubmit } = setup()
    const radio = screen.getByRole('radio', { name: /PDF/ })
    radio.focus()
    expect(radio).toHaveFocus()
    fireEvent.click(radio)
    nextPage()
    const textbox = within(group('内容')).getByRole('textbox', { name: '其它内容' })
    textbox.focus()
    expect(textbox).toHaveFocus()
    fireEvent.change(textbox, { target: { value: '第一行\n第二行' } })
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    submitForm()
    expect(onSubmit.mock.calls[0][0].answers[1].otherText).toBe('第一行\n第二行')
  })

  it('卡片自己不带内层滚动约束（无 max-height / overflow-y-auto / sticky 操作行）', () => {
    setup()
    const card = screen.getByTestId('ask-user-card')
    expect(card.className).not.toContain('max-h-')
    expect(card.className).not.toContain('overflow-y-auto')
    expect(card.className).not.toContain('sticky')
    // 当前题一屏铺开：选项 + 其它输入框 + 主操作同在一张卡里，没有需要滚才点得到的东西
    expect(within(card).getByRole('textbox', { name: '其它内容' })).toBeInTheDocument()
    expect(within(card).getByTestId('ask-user-next')).toBeInTheDocument()
  })

  it('支持 4 题各 4 项，长文本保留并设置窄屏换行约束', () => {
    const longInput: AskUserInput = {
      questions: Array.from({ length: 4 }, (_, index) => ({
        id: `q${index}`,
        header: `问题${index}`,
        question: '长问题'.repeat(100),
        options: Array.from({ length: 4 }, (_, option) => ({
          id: `o${option}`,
          label: `长选项${option}`.repeat(100)
        }))
      }))
    }
    render(<Harness input={longInput} onSubmit={vi.fn()} onStop={vi.fn()} />)
    expect(screen.getAllByRole('group')).toHaveLength(1)
    expect(screen.getAllByRole('radio')).toHaveLength(5)
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 1/4 题')
    expect(screen.getByTestId('ask-user-card').className).toContain('[overflow-wrap:anywhere]')
    expect(screen.getByTestId('ask-user-card').className).toContain('border-surface-border')
  })

  it('round 83：模型自带的「其他」选项并进内置输入行，只铺一条', () => {
    const roleQuestion: AskUserInput = {
      questions: [
        {
          id: 'role',
          header: '你的角色',
          question: '你主要是以什么身份在用我？',
          options: [
            { id: 'employee', label: '上班族 / 企业员工' },
            { id: 'student', label: '学生 / 科研人员' },
            { id: 'freelance', label: '自由职业 / 创业者' },
            { id: 'other', label: '其他（我在回答里补充）' }
          ]
        }
      ]
    }
    const onSubmit = vi.fn<(answer: AskUserAnswer) => void>()
    render(
      <Harness
        input={roleQuestion}
        initialDraft={createAskUserDraft(roleQuestion)}
        onSubmit={onSubmit}
        onStop={vi.fn()}
      />
    )
    // 四条：三条真选项 + 一条（合并后的）「其他」输入行 —— 改前是五条（模型那条另铺一行）
    expect(screen.getAllByRole('radio')).toHaveLength(4)
    expect(screen.getByRole('radio', { name: '上班族 / 企业员工' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '其他（我在回答里补充）' })).toBeInTheDocument()
    // 合并行就是输入行：打字即勾上它，预设选项被顶掉
    const other = screen.getByRole('textbox', { name: '其它内容' })
    fireEvent.click(screen.getByRole('radio', { name: '学生 / 科研人员' }))
    fireEvent.focus(other)
    expect(screen.getByRole('radio', { name: '其他（我在回答里补充）' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '学生 / 科研人员' })).not.toBeChecked()
    fireEvent.change(other, { target: { value: ' 独立开发 ' } })
    fireEvent.click(submitButton())
    // 答案形状不变：走 otherText，被合并的选项 id 不入 selectedOptionIds（单选互斥）
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      status: 'answered',
      answers: [{ questionId: 'role', selectedOptionIds: [], otherText: '独立开发' }]
    })
  })

  it('round 83：被合并选项的「推荐」与说明照旧展示（不静默丢提示）', () => {
    const described: AskUserInput = {
      questions: [
        {
          id: 'role',
          header: '你的角色',
          question: '你主要是以什么身份在用我？',
          options: [
            { id: 'employee', label: '上班族 / 企业员工' },
            { id: 'student', label: '学生 / 科研人员' },
            {
              id: 'other',
              label: '其他（我在回答里补充）',
              description: '选这一项就在输入框里写清楚，别只填「其他」。',
              recommended: true
            }
          ]
        }
      ]
    }
    const onSubmit = vi.fn<(answer: AskUserAnswer) => void>()
    render(
      <Harness
        input={described}
        initialDraft={createAskUserDraft(described)}
        onSubmit={onSubmit}
        onStop={vi.fn()}
      />
    )
    // 合并行仍是那条唯一入口：文案、推荐徽标、说明都还在，说明还挂在它的可访问描述上
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    const other = screen.getByRole('radio', { name: /^其他（我在回答里补充）/ })
    expect(screen.getByText('推荐')).toBeInTheDocument()
    expect(screen.getByText('选这一项就在输入框里写清楚，别只填「其他」。')).toBeInTheDocument()
    expect(other).toHaveAccessibleDescription('选这一项就在输入框里写清楚，别只填「其他」。')
    fireEvent.focus(screen.getByRole('textbox', { name: '其它内容' }))
    fireEvent.change(screen.getByRole('textbox', { name: '其它内容' }), {
      target: { value: '独立开发' }
    })
    fireEvent.click(submitButton())
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      status: 'answered',
      answers: [{ questionId: 'role', selectedOptionIds: [], otherText: '独立开发' }]
    })
  })

  it('round 83：翻到末页的那次「下一题」不触发提交，末页未答也不弹校验；点提交才校验', () => {
    const { onSubmit } = setup()
    fireEvent.click(screen.getByRole('radio', { name: /PDF/ }))
    // 末页按钮是**另一枚节点**（key 不同）：这次 click 的默认动作不能落成提交
    nextPage()
    expect(screen.getByTestId('ask-user-page')).toHaveTextContent('第 2/2 题')
    expect(screen.getByRole('button', { name: '提交全部回答' })).toBeInTheDocument()
    expect(screen.queryByTestId('ask-user-next')).not.toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
    // 末页还没答：翻页不该替用户校验出提示来（改前这里会冒出「请至少选择一项…」）
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '摘要' })).not.toHaveAttribute('aria-invalid')
    // 人真去点提交才校验，并停在这一题
    fireEvent.click(submitButton())
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('请至少选择一项')
    fireEvent.click(screen.getByRole('checkbox', { name: '摘要' }))
    fireEvent.click(submitButton())
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      status: 'answered',
      answers: [
        { questionId: 'format', selectedOptionIds: ['pdf'] },
        { questionId: 'content', selectedOptionIds: ['summary'] }
      ]
    })
  })

  it('round 83：正常选项里的「其它X」不误伤，无合并项时内置行仍叫「其它」', () => {
    const formats: AskUserInput = {
      questions: [
        {
          id: 'format',
          header: '格式',
          question: '要哪种文件？',
          options: [
            { id: 'doc', label: '其它格式的文档' },
            { id: 'sheet', label: '表格' }
          ]
        }
      ]
    }
    render(
      <Harness
        input={formats}
        initialDraft={createAskUserDraft(formats)}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
      />
    )
    // 两条真选项 + 一条内置「其它」输入行，一个不少
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: '其它格式的文档' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^其它$/ })).toBeInTheDocument()
  })
})
