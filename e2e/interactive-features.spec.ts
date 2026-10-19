import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { sessionDirOf } from '../src/shared/session-dir'
import { sendMessage } from './harness'
import {
  createInteractiveApp,
  functionEvidence,
  startInteractiveProvider
} from './fixtures/interactive'

test.describe('interactive features — production UI functional evidence', () => {
  test.setTimeout(120_000)

  const diagnostics = async (page: Page, filename: string): Promise<void> => {
    const result = await page.evaluate(async () => {
      const endpoint = await window.kyclaw.agent.endpoint()
      const headers = { Authorization: `Bearer ${endpoint.token}` }
      const threads = await (await fetch(`${endpoint.baseUrl}/api/threads`, { headers })).json()
      const records = []
      for (const thread of threads.threads) {
        const messages = await (
          await fetch(`${endpoint.baseUrl}/api/threads/${encodeURIComponent(thread.id)}/messages`, {
            headers
          })
        ).json()
        records.push({ threadId: thread.id, messages })
      }
      return records
    })
    mkdirSync('.superpowers/interactive-acceptance', { recursive: true })
    writeFileSync(
      join('.superpowers/interactive-acceptance', filename),
      JSON.stringify(result, null, 2)
    )
  }

  const rowId = async (page: Page): Promise<string> => {
    const id = await page
      .locator('[data-testid^="session-item-"]')
      .first()
      .getAttribute('data-testid')
    if (!id) throw new Error('Session was not materialized')
    return id
  }
  const selectSession = async (page: Page, id: string): Promise<void> => {
    await page.evaluate(() => {
      location.hash = '/'
    })
    await page.getByTestId(id).click()
  }
  /**
   * round 81：常驻的模式按钮收进了输入卡左下角的 ＋ 菜单（不再有工具条上的「进入规划模式」）——
   * 进入规划 = 点 ＋ → 点「进入规划模式」那一条。
   *
   * 等它可用再点：挂载那一下 ask-user 的取数还没回来（`locked` 因此为真），条目会短暂禁用；
   * 点一条禁用条目等于没点（菜单照旧关掉），所以先轮询到 data-disabled 消失。
   */
  const clickModeEntry = async (page: Page, testId: string): Promise<void> => {
    const entry = page.getByTestId(testId)
    await expect(async () => {
      if (!(await entry.isVisible())) await page.getByTestId('composer-plus').click()
      await expect(entry).toBeVisible()
      expect(await entry.getAttribute('data-disabled')).toBeNull()
    }).toPass({ timeout: 20_000 })
    await entry.click()
  }
  const enterPlanAt = async (page: Page): Promise<void> => {
    await clickModeEntry(page, 'composer-mode-plan')
    await expect(page.getByTestId('plan-approval-dock')).toBeVisible()
  }
  /** round 81：计划详情默认收起（只铺摘要）——要看正文/反馈框得先点开摘要那行 */
  const expandPlanAt = async (page: Page): Promise<void> => {
    const toggle = page.getByTestId('plan-approval-toggle')
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await expect(page.getByRole('region', { name: '计划正文与反馈' })).toBeVisible()
  }
  /** round 81：任务详情同样默认收起（摘要常显、点开看列表） */
  const expandTasksAt = async (page: Page): Promise<void> => {
    const toggle = page.getByTestId('task-dock-toggle')
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await expect(page.getByRole('list', { name: '任务列表' })).toBeVisible()
  }

  test('AskUser: single/multiple/other answers, durable pending after restart, submit and stop', async () => {
    test.skip(true, '旧交互状态机，0.2.0 走内核交互，见 PB-026')
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    const questions = {
      questions: [
        {
          id: 'single',
          header: '格式',
          question: '选一种格式',
          options: [
            { id: 'a', label: '文档' },
            { id: 'b', label: '表格' }
          ]
        },
        {
          id: 'multi',
          header: '范围',
          question: '选范围或补充其它',
          multiSelect: true,
          options: [
            { id: 'a', label: '摘要' },
            { id: 'b', label: '明细' }
          ]
        }
      ]
    }
    try {
      provider.enqueue({ tool: 'ask_user', input: questions }, { text: 'ASKUSER_SUBMITTED' })
      await sendMessage(app.page, 'INTERACTIVE_ASKUSER')
      await expect(app.page.getByTestId('ask-user-card')).toBeVisible()
      const session = await rowId(app.page)
      await functionEvidence(app.page, 'ask-user-pending.png')
      await app.restart()
      await selectSession(app.page, session)
      const card = app.page.getByTestId('ask-user-card')
      await expect(card).toBeVisible()
      // round 81：多题**逐题显示**（一次只铺一道），题间用「下一题」翻页
      await expect(app.page.getByTestId('ask-user-page')).toHaveText('第 1/2 题')
      await card.getByRole('radio', { name: '文档', exact: true }).check()
      await app.page.getByTestId('ask-user-next').click()
      await expect(app.page.getByTestId('ask-user-page')).toHaveText('第 2/2 题')
      await card.getByRole('checkbox', { name: '摘要', exact: true }).check()
      await card.getByRole('checkbox', { name: '明细', exact: true }).check()
      // round 82：「其它」就是选项行里的输入框 —— 直接填字即勾上，不必先点一次「其它」
      await card.getByLabel('其它内容').fill('补充统计')
      await expect(card.getByRole('checkbox', { name: '其它', exact: true })).toBeChecked()
      await functionEvidence(app.page, 'ask-user-selected.png')
      await card.getByRole('button', { name: '提交全部回答' }).click()
      await expect(app.page.getByTestId('message-text').last()).toContainText('ASKUSER_SUBMITTED')
      const resumed = provider.requests.filter((request) => request.stream).at(-1)
      expect(JSON.stringify(resumed?.messages)).toContain('补充统计')
      expect(JSON.stringify(resumed?.messages)).toContain('摘要')
      provider.enqueue({ tool: 'ask_user', input: questions })
      await sendMessage(app.page, 'INTERACTIVE_ASKUSER_STOP')
      await expect(card).toBeVisible()
      // round 82：取消从底部「停止本轮」搬到卡片右上角 ×（同一个取消 handler）
      await card.getByRole('button', { name: '取消本轮提问' }).click()
      await expect(card).toHaveCount(0)
      await app.restart()
      await selectSession(app.page, session)
      await expect(app.page.getByTestId('ask-user-card')).toHaveCount(0)
      await app.page.getByTestId('composer-input').fill('停止后可继续的新消息')
      await expect(app.page.getByTestId('composer-send')).toBeEnabled()
      await functionEvidence(app.page, 'ask-user-stopped-restart.png')
    } finally {
      await app.close()
      await provider.close()
    }
  })

  test('Todo and Rules: production todo progress persists across sessions/restart; saved rules reach next provider request', async () => {
    test.skip(true, 'tasks/memory/rules 路由 0.2.0 下架，见 PB-022')
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    try {
      provider.enqueue(
        {
          tool: 'todo',
          input: {
            action: 'replace',
            expectedRevision: 0,
            items: [
              { title: '收集资料', status: 'in_progress' },
              { title: '整理结果', status: 'pending' }
            ]
          }
        },
        { text: 'TODO_CREATED' }
      )
      await sendMessage(app.page, 'INTERACTIVE_TODO')
      await expect(app.page.getByTestId('message-text').last()).toContainText('TODO_CREATED')
      const first = await rowId(app.page)
      const dock = app.page.getByTestId('task-list-dock')
      await expect(dock).toBeVisible()
      await expect(dock).toContainText('0/2 已完成')
      await dock.getByRole('button', { name: '刷新任务' }).click()
      await diagnostics(app.page, 'todo-diagnostic.json')
      await functionEvidence(app.page, 'todo-before-progress.png')
      await expect(dock).toContainText('0/2 已完成')
      // round 81：详情默认收起（摘要常显），要改状态先点开
      await expandTasksAt(app.page)
      // 状态菜单走 portal：条目从 page 查，不从 dock 内查
      await dock.getByRole('button', { name: '任务状态：收集资料' }).click()
      await app.page.getByRole('menuitem', { name: '已完成' }).click()
      await expect(dock).toContainText('1/2 已完成')
      await functionEvidence(app.page, 'todo-progress.png')
      await app.page.getByTestId('new-session').click()
      await expect(app.page.getByTestId('task-list-dock')).toHaveCount(0)
      await app.page.getByTestId(first).click()
      await expect(app.page.getByTestId('task-list-dock')).toContainText('1/2 已完成')
      await app.restart()
      await selectSession(app.page, first)
      await expect(app.page.getByTestId('task-list-dock')).toContainText('1/2 已完成')

      await app.page.evaluate(() => {
        location.hash = '/settings/rules'
      })
      // 返工后编辑器收在「记忆指令」二级弹窗里：老深链只定位到那一行，得先点开入口
      await app.page.getByTestId('rules-open').click()
      await app.page.getByLabel('全局记忆指令').fill('INTERACTIVE_RULE_NEXT_TURN_唯一标记')
      await app.page.getByRole('button', { name: '保存', exact: true }).click()
      await expect(app.page.getByText('已保存', { exact: true })).toBeVisible()
      await functionEvidence(app.page, 'rules-saved.png')
      // 关掉弹窗再离开这一页（后续步骤在对话页；表单状态不留给下一段）
      await app.page.keyboard.press('Escape')
      await expect(app.page.getByTestId('rules-dialog-body')).toHaveCount(0)
      await selectSession(app.page, first)
      const before = provider.requests.length
      provider.enqueue({ text: 'RULES_REQUEST_VERIFIED' })
      await sendMessage(app.page, 'INTERACTIVE_RULES_NEXT_TURN')
      await expect(app.page.getByTestId('message-text').last()).toContainText(
        'RULES_REQUEST_VERIFIED'
      )
      const chatRequest = provider.requests.slice(before).find((request) => request.stream)
      expect(chatRequest).toBeDefined()
      expect(
        chatRequest?.messages.some(
          (message) =>
            message.role === 'system' &&
            JSON.stringify(message.content).includes('INTERACTIVE_RULE_NEXT_TURN_唯一标记')
        )
      ).toBe(true)
      await functionEvidence(app.page, 'rules-next-turn.png')

      await app.page.getByTestId('new-session').click()
      await app.page.getByTestId('composer-project').click()
      await app.page.getByTestId('project-pick-new-blank').click()
      await app.page.getByTestId('project-name-input').fill('InteractiveRulesProject')
      await expect(app.page.getByTestId('project-path-value')).toContainText(app.workspace)
      await app.page.getByTestId('project-create-save').click()
      await expect(app.page.getByTestId('composer-project')).toContainText(
        'InteractiveRulesProject'
      )
      const project = await app.page.evaluate(async () => {
        const settings = await window.kyclaw.settings.get()
        const selected = settings.projects.find((item) => item.name === 'InteractiveRulesProject')
        if (!selected) throw new Error('UI project creation did not persist')
        return selected
      })
      await app.page.evaluate(() => {
        location.hash = '/settings/rules'
      })
      // 同上：编辑器在二级弹窗里，先点开「记忆指令」入口
      await app.page.getByTestId('rules-open').click()
      await app.page
        .getByLabel('全局记忆指令')
        .fill('INTERACTIVE_GLOBAL_FORMAT：同一事项默认使用文档。')
      await app.page.getByRole('button', { name: '保存', exact: true }).click()
      await expect(app.page.getByText('已保存', { exact: true })).toBeVisible()
      // 002：项目选择器是产品自定义下拉（不再是原生 select）——点开面板，再点那条项目
      await app.page.getByTestId('rules-project-select').click()
      await app.page.getByTestId(`rules-project-${project.id}`).click()
      const projectRules = 'INTERACTIVE_PROJECT_FORMAT：同一事项改用表格，覆盖全局默认。'
      const editor = app.page.getByLabel('项目记忆指令', { exact: true })
      await editor.fill(projectRules)
      await editor.locator('..').getByRole('button', { name: '保存', exact: true }).click()
      await expect
        .poll(() => {
          const file = join(project.path, '.kyclaw', 'rules.md')
          return existsSync(file) ? readFileSync(file, 'utf8') : null
        })
        .toBe(projectRules)
      // 008：来源只说项目内的相对位置；长绝对路径挂在 tooltip 上（悬停可核对）
      const source = app.page.getByText('.kyclaw/rules.md（项目内）', { exact: true })
      await expect(source).toBeVisible()
      await expect(source).toHaveAttribute('title', join(project.path, '.kyclaw', 'rules.md'))
      await functionEvidence(app.page, 'project-rules-saved-source.png')
      await app.page.evaluate(() => {
        location.hash = '/chat'
      })
      await expect(app.page.getByTestId('composer-project')).toContainText(
        'InteractiveRulesProject'
      )
      const projectBefore = provider.requests.length
      provider.enqueue({ text: 'PROJECT_RULES_REQUEST_VERIFIED' })
      await sendMessage(app.page, 'INTERACTIVE_PROJECT_RULES_NEXT_TURN')
      await expect(app.page.getByTestId('message-text').last()).toContainText(
        'PROJECT_RULES_REQUEST_VERIFIED'
      )
      const projectRequest = provider.requests
        .slice(projectBefore)
        .find((request) => request.stream)
      const system = JSON.stringify(
        projectRequest?.messages.filter((message) => message.role === 'system')
      )
      expect(system).toContain('INTERACTIVE_GLOBAL_FORMAT')
      expect(system).toContain('INTERACTIVE_PROJECT_FORMAT')
      expect(system).toContain('source: bound project .kyclaw/rules.md')
      expect(system).toContain('project preferences override global preferences on the same matter')
      await functionEvidence(app.page, 'project-rules-bound-next-turn.png')
    } finally {
      await app.close()
      await provider.close()
    }
  })

  test('Plan: enter/submit/revise/restart/approve does not bypass write approval; stop survives restart', async () => {
    test.skip(true, '旧 plan 状态机→DSH plan mode，见 PB-044')
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    const state = async (
      page: Page,
      session: string
    ): Promise<{ planId: string; revision: number; version: number; mode: string }> =>
      page.evaluate(
        async (threadId) => {
          if (!window.kyclaw) throw new Error('Missing bridge')
          const endpoint = await window.kyclaw.agent.endpoint()
          const response = await fetch(
            `${endpoint.baseUrl}/plans/state?threadId=${encodeURIComponent(threadId)}`,
            { headers: { Authorization: `Bearer ${endpoint.token}` } }
          )
          if (!response.ok) throw new Error(`Plan state returned ${response.status}`)
          return (await response.json()).state as {
            planId: string
            revision: number
            version: number
            mode: string
          }
        },
        session.replace('session-item-', '')
      )
    try {
      await enterPlanAt(app.page)
      await expandPlanAt(app.page)
      const session = await rowId(app.page)
      const initial = await state(app.page, session)
      expect(initial.mode).toBe('planning')
      provider.enqueue(
        { tool: 'enter_plan', input: { expectedVersion: initial.version } },
        {
          tool: 'submit_plan',
          input: {
            planId: initial.planId,
            revision: initial.revision,
            version: initial.version,
            body: '# 初版计划\n创建验收文件。'
          }
        }
      )
      await sendMessage(app.page, 'INTERACTIVE_PLAN_SUBMIT')
      const panel = app.page.getByRole('region', { name: '计划审批' })
      await expect(panel.getByRole('button', { name: '批准此计划' })).toBeEnabled()
      await expandPlanAt(app.page)
      await panel.getByLabel('修改反馈（修改计划时必填）').fill('增加验证步骤')
      provider.enqueue({
        tool: 'submit_plan',
        input: async () => {
          const current = await state(app.page, session)
          return {
            planId: current.planId,
            revision: current.revision,
            version: current.version,
            body: '# 修改后的计划\n创建文件后读取验证。'
          }
        }
      })
      await panel.getByRole('button', { name: '修改计划', exact: true }).click()
      // 修订回来是新版本：计划卡按新 key 重挂 → 详情回到收起态，要看正文得再点开
      await expect(app.page.getByTestId('plan-approval-toggle')).toHaveAttribute(
        'aria-expanded',
        'false'
      )
      await expandPlanAt(app.page)
      await expect(panel).toContainText('修改后的计划')
      await functionEvidence(app.page, 'plan-revised.png')
      await app.restart()
      await selectSession(app.page, session)
      await expandPlanAt(app.page)
      await expect(app.page.getByRole('region', { name: '计划审批' })).toContainText('修改后的计划')
      provider.enqueue(
        { tool: 'write', input: { path: 'plan-e2e.txt', content: 'PLAN_APPROVED_FILE\n' } },
        { text: 'PLAN_WRITE_FINISHED' }
      )
      await app.page.getByRole('button', { name: '批准此计划', exact: true }).click()
      await expect(app.page.getByTestId('approval-card')).toBeVisible()
      const target = join(
        sessionDirOf(app.workspace, session.replace('session-item-', '')),
        'plan-e2e.txt'
      )
      expect(existsSync(target)).toBe(false)
      await functionEvidence(app.page, 'plan-approved-write-still-gated.png')
      await app.page.getByTestId('approval-allow-once').click()
      await expect.poll(() => existsSync(target)).toBe(true)
      expect(readFileSync(target, 'utf8')).toBe('PLAN_APPROVED_FILE\n')
      await expect(app.page.getByTestId('message-text').last()).toContainText('PLAN_WRITE_FINISHED')
      await expect.poll(async () => (await state(app.page, session)).mode).toBe('normal')
      await expect(app.page.getByRole('region', { name: '计划审批' })).toHaveCount(0)
      await functionEvidence(app.page, 'plan-natural-completion-normal.png')

      await enterPlanAt(app.page)
      await expect.poll(async () => (await state(app.page, session)).mode).toBe('planning')
      const cancelPlan = await state(app.page, session)
      provider.enqueue({
        tool: 'submit_plan',
        input: {
          planId: cancelPlan.planId,
          revision: cancelPlan.revision,
          version: cancelPlan.version,
          body: '# 待取消的独立计划\n本轮不批准也不执行。'
        }
      })
      await sendMessage(app.page, 'INTERACTIVE_PLAN_CANCEL_PENDING')
      await expect(app.page.getByRole('button', { name: '批准此计划', exact: true })).toBeEnabled()
      await expect.poll(async () => (await state(app.page, session)).mode).toBe('awaiting_approval')
      await functionEvidence(app.page, 'plan-cancel-pending.png')
      const oldState = await state(app.page, session)
      const oldRef = {
        planId: oldState.planId,
        revision: oldState.revision,
        version: oldState.version
      }
      const stoppedEvidence = async (): Promise<{ resumeStatus: number; history: string }> =>
        app.page.evaluate(
          async ({ threadId, ref }) => {
            const endpoint = await window.kyclaw.agent.endpoint()
            const headers = {
              Authorization: `Bearer ${endpoint.token}`,
              'content-type': 'application/json'
            }
            const resume = await fetch(`${endpoint.baseUrl}/plans/resume`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ threadId, ref })
            })
            const history = await fetch(
              `${endpoint.baseUrl}/api/threads/${encodeURIComponent(threadId)}/messages`,
              { headers }
            )
            if (!history.ok) throw new Error(`History returned ${history.status}`)
            return { resumeStatus: resume.status, history: await history.text() }
          },
          { threadId: session.replace('session-item-', ''), ref: oldRef }
        )
      await app.page
        .getByRole('region', { name: '计划审批' })
        .getByRole('button', { name: '停止本轮' })
        .click()
      await expect.poll(async () => (await state(app.page, session)).mode).toBe('normal')
      await expect(app.page.getByRole('button', { name: '批准此计划', exact: true })).toHaveCount(0)
      const stopped = await stoppedEvidence()
      expect(stopped.resumeStatus).toBe(409)
      expect(stopped.history).toContain('cancelled')
      await app.restart()
      await selectSession(app.page, session)
      expect((await state(app.page, session)).mode).toBe('normal')
      const restarted = await stoppedEvidence()
      expect(restarted.resumeStatus).toBe(409)
      expect(restarted.history).toContain('cancelled')
      await expect(app.page.getByRole('button', { name: '批准此计划', exact: true })).toHaveCount(0)
      await functionEvidence(app.page, 'plan-stopped-restart.png')
    } finally {
      await app.close()
      await provider.close()
    }
  })

  test('Narrow window: 800 铺满内容区不卸载聊天、1280 回并列，侧栏/拖宽边界即时重判', async () => {
    const provider = await startInteractiveProvider()
    const app = await createInteractiveApp(provider.url)
    const page = app.page
    const DRAFT = '窄窗草稿保留标记 NARROW_DRAFT_KEPT'
    /** 观测到的壳状态逐段落盘（数字说话，UI 复核与报告都读它） */
    const observations: Record<string, unknown> = {}
    const record = (label: string, value: unknown): void => {
      observations[label] = value
    }
    const writeObservations = (filename: string): void => {
      mkdirSync('.superpowers/interactive-acceptance', { recursive: true })
      writeFileSync(
        join('.superpowers/interactive-acceptance', filename),
        `${JSON.stringify(observations, null, 2)}\n`
      )
    }

    interface ShellSnapshot {
      innerWidth: number
      mainCount: number
      mainDisplay: string | null
      mainWidth: number
      panelWidth: number
      panelFullscreen: string | null
      panelSource: string | null
      panelPreference: string
      sidebar: string | null
      composerDraft: string | null
      resizerCount: number
      /** round 79：拖动残留判据 —— 面板是否还挂着 transition-none */
      panelDragging: boolean | null
      /** 把手高亮线的计算底色（没在拖 = bg-transparent = rgba(0, 0, 0, 0)；把手不在 = null） */
      resizerLineColor: string | null
    }

    /** 壳的实测状态：布局结论一律量出来，不看类名猜（收起的面板 DOM 还在，宽度才是判据） */
    const shell = (): Promise<ShellSnapshot> =>
      page.evaluate(() => {
        const main = document.querySelector('[data-testid="main-column"]')
        const panel = document.querySelector('[data-testid="work-panel"]')
        const widthOf = (node: Element | null): number =>
          node === null ? -1 : Math.round(node.getBoundingClientRect().width)
        return {
          innerWidth: window.innerWidth,
          mainCount: document.querySelectorAll('[data-testid="main-column"]').length,
          mainDisplay: main === null ? null : getComputedStyle(main).display,
          mainWidth: widthOf(main),
          panelWidth: widthOf(panel),
          panelFullscreen: panel?.getAttribute('data-fullscreen') ?? null,
          panelSource: panel?.getAttribute('data-fullscreen-source') ?? null,
          panelPreference:
            panel instanceof HTMLElement ? panel.style.getPropertyValue('--work-panel-width') : '',
          sidebar:
            document.querySelector('[data-testid="app-root"]')?.getAttribute('data-sidebar') ??
            null,
          composerDraft:
            (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement | null)
              ?.value ?? null,
          resizerCount: document.querySelectorAll('[data-testid="work-panel-resizer"]').length,
          // round 79：拖动残留的判据 —— transition-none 与强调蓝线（bg-transparent = rgba(0,0,0,0)）
          panelDragging: panel?.classList.contains('transition-none') ?? null,
          resizerLineColor:
            document.querySelector('[data-testid="work-panel-resizer"] span') === null
              ? null
              : getComputedStyle(
                  document.querySelector('[data-testid="work-panel-resizer"] span') as Element
                ).backgroundColor
        }
      })

    /**
     * 量"过渡停了"的壳状态：面板收放带 `transition-[width,margin-left]`，紧接决策位翻转读到的
     * 尺寸是中间帧（实测撞过两次：source 已 auto 面板宽还在路上；侧栏收起时帧间差值只剩十来个像素，
     * 「连续两次相等」会在动画尾部误判成停稳）。所以要求**连续三次**几何读数完全一致（≈240ms 不动）
     * 才算停稳，把帧间巧合挡掉。
     */
    const settledShell = async (): Promise<Awaited<ReturnType<typeof shell>>> => {
      let previous = await shell()
      let streak = 0
      for (let attempt = 0; attempt < 40; attempt++) {
        await page.waitForTimeout(120)
        const next = await shell()
        const still =
          next.panelWidth === previous.panelWidth &&
          next.mainWidth === previous.mainWidth &&
          next.innerWidth === previous.innerWidth
        streak = still ? streak + 1 : 0
        previous = next
        if (streak >= 3) return next
      }
      return previous
    }

    /** 收/放真窗口到指定宽度（Electron 侧改几何；等渲染端 innerWidth 跟到位） */
    const resizeTo = async (width: number): Promise<void> => {
      await app.app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]?.setBounds({
            ...(size as { width: number }),
            height: 800
          })
        },
        { width }
      )
      await page.waitForFunction((expected) => Math.abs(window.innerWidth - expected) <= 4, width, {
        timeout: 10_000
      })
    }

    /** 面板没开才点开关：`work-panel-toggle` 开/关两种形态都在（见 ui-final/capture.mjs 的坑） */
    const openPanel = async (): Promise<void> => {
      if ((await shell()).panelWidth <= 0) await page.getByTestId('work-panel-toggle').click()
      await expect.poll(async () => (await shell()).panelWidth).toBeGreaterThan(0)
    }

    const sidebarWidth = 240
    // 0.2.0 壳层：左侧还有 primary nav rail（--primary-nav-rail-width=56）；panel 的实际起点是 rail+sidebar。
    // 800 宽实测：sidebar.x=56(w240) → panel.x=296(w498)，右缘 794=800−6；不再单独减 rail 会把期望算大 56。
    const primaryNavRail = 56
    const edgeGap = 6
    const minChatWidth = 480
    const filesPanel = page.locator(
      '[data-testid="workbench-panel"][data-kind="files"][data-active="true"]'
    )

    /**
     * round 77 那条判据的独立复算：内容区实测宽 − 侧栏遮挡（展开 240 / 收起 0） − 面板宽度
     * （store 里那条，不是铺满后的实测宽） < --chat-min-readable-width(480) ⇒ 铺满。
     * 与 `data-fullscreen-source` 对账 —— 等于把 shell-store 的纯函数在真浏览器里跑一遍。
     */
    const expectedSource = (state: Awaited<ReturnType<typeof shell>>): 'auto' | 'none' => {
      const safeLeft = state.sidebar === 'collapsed' ? 0 : sidebarWidth
      const panelWidth = Number.parseFloat(state.panelPreference) || 400
      // 0.2.0 壳：内容区起点含 primary-nav-rail(56)，与 shell-store 的 auto 判据保持一致
      return state.innerWidth - primaryNavRail - edgeGap - safeLeft - panelWidth < minChatWidth
        ? 'auto'
        : 'none'
    }

    try {
      // 起点 = 默认 1280、面板没开：中列就是聊天
      const start = await shell()
      expect(start.innerWidth).toBeGreaterThanOrEqual(1276)
      expect(start.mainCount).toBe(1)
      expect(start.mainDisplay).not.toBe('none')
      expect(start.panelWidth).toBe(0)
      expect(start.panelSource).toBe('none')

      // 先在输入框留一条草稿：这一圈若把中列卸载了，草稿就没了
      await page.getByTestId('composer-input').fill(DRAFT)

      // ── 800 宽：开面板 → 铺满内容区（来源 auto），中列 hidden 但仍挂载 ──
      await resizeTo(800)
      await openPanel()
      await expect.poll(async () => (await shell()).panelSource).toBe('auto')
      const narrow = await settledShell()
      expect(narrow.panelFullscreen).toBe('true')
      expect(narrow.mainCount).toBe(1)
      expect(narrow.mainDisplay).toBe('none')
      // 铺满宽 = innerWidth − primary-nav-rail(56) − sidebar(240) − edge-gap(6)（含左侧 rail）
      expect(
        Math.abs(
          narrow.panelWidth - (narrow.innerWidth - primaryNavRail - sidebarWidth - edgeGap)
        )
      ).toBeLessThanOrEqual(8)
      // 铺满是算出来的布局结果，不是偏好：store 里的宽度没被动过
      expect(narrow.panelPreference).toBe('400px')
      expect(narrow.composerDraft).toBe(DRAFT)
      // 与独立复算的判据对账（内容区 − 侧栏遮挡 − 面板宽 < 480 ⇒ auto）
      expect(narrow.panelSource).toBe(expectedSource(narrow))

      // files 工具真开在这块铺满的面板里（Ctrl+Shift+E 是既有的开标签口径）
      await page.keyboard.press('Control+Shift+E')
      await expect(filesPanel).toBeVisible()
      await expect
        .poll(async () => (await filesPanel.boundingBox())?.width ?? 0)
        .toBeGreaterThan(200)
      // 800 太窄：靠收窄面板也摆不开（min 面板 280 + min 聊天 480 > 794 − 240）→ 槽位给"返回对话"这条真动作，
      // 不再摆一个按不动的禁用图标；可访问名就是它干的事
      await expect(page.getByTestId('workbench-fullscreen')).toHaveCount(0)
      await expect(page.getByTestId('workbench-restore-split')).toHaveCount(0)
      const backToChat = page.getByTestId('workbench-back-to-chat')
      await expect(backToChat).toBeVisible()
      await expect(backToChat).toHaveAccessibleName('返回对话')
      await functionEvidence(page, 'narrow-800-files-autofill.png')

      // 这条真动作要真走得出去：点它回聊天（中列回来、草稿还在），再展开回来仍是 auto，标签也没丢
      await backToChat.click()
      await expect.poll(async () => (await shell()).panelWidth).toBe(0)
      const backAt800 = await settledShell()
      expect(backAt800.panelSource).toBe('none')
      expect(backAt800.panelFullscreen).toBe('false')
      expect(backAt800.mainDisplay).not.toBe('none')
      expect(backAt800.composerDraft).toBe(DRAFT)
      await openPanel()
      await expect.poll(async () => (await shell()).panelSource).toBe('auto')
      await expect(filesPanel).toBeVisible()
      await expect(page.getByTestId('workbench-back-to-chat')).toBeVisible()
      record('backToChat800', backAt800)

      // 800 里收侧栏：仍摆不开 docked（794 − 400 = 394 < 480）→ 结论不变，面板改铺整幅
      await page.getByTestId('sidebar-toggle').click()
      await expect.poll(async () => (await shell()).sidebar).toBe('collapsed')
      const collapsed = await settledShell()
      expect(collapsed.panelSource).toBe('auto')
      expect(collapsed.panelSource).toBe(expectedSource(collapsed))
      // 侧栏收起：面板从 rail(56) 后起铺满 → 宽 = innerWidth − primary-nav-rail − edge-gap
      expect(
        Math.abs(collapsed.panelWidth - (collapsed.innerWidth - primaryNavRail - edgeGap))
      ).toBeLessThanOrEqual(8)
      // 展开回来：遮挡加回去，结论照旧
      await page.getByTestId('sidebar-toggle').click()
      await expect.poll(async () => (await shell()).sidebar).toBe('expanded')
      const expanded = await settledShell()
      expect(expanded.panelSource).toBe('auto')
      expect(expanded.panelSource).toBe(expectedSource(expanded))
      // 侧栏展开：面板从 rail+sidebar 后起铺满 → 宽 = innerWidth − rail(56) − sidebar(240) − edge-gap(6)
      expect(
        Math.abs(
          expanded.panelWidth - (expanded.innerWidth - primaryNavRail - sidebarWidth - edgeGap)
        )
      ).toBeLessThanOrEqual(8)

      // 收面板 → 回聊天：走 800 里唯一有意义的那个动作（"返回对话"），中列回来、草稿还在（一直挂着，不是重挂）
      await page.getByTestId('workbench-back-to-chat').click()
      await expect.poll(async () => (await shell()).panelWidth).toBe(0)
      const back = await settledShell()
      expect(back.panelSource).toBe('none')
      expect(back.panelFullscreen).toBe('false')
      expect(back.mainDisplay).not.toBe('none')
      expect(back.mainWidth).toBeGreaterThan(480)
      expect(back.composerDraft).toBe(DRAFT)
      await functionEvidence(page, 'narrow-800-closed-back-to-chat.png')

      // ── 1280：恢复并列（docked），中列可见宽回到 480 以上 ──
      await resizeTo(1280)
      await openPanel()
      await expect.poll(async () => (await shell()).panelSource).toBe('none')
      const wide = await settledShell()
      expect(wide.panelFullscreen).toBe('false')
      expect(wide.mainDisplay).not.toBe('none')
      expect(Math.abs(wide.panelWidth - 400)).toBeLessThanOrEqual(4)
      expect(wide.mainWidth).toBeGreaterThanOrEqual(480)
      expect(wide.panelSource).toBe(expectedSource(wide))

      // ── 拖宽边界：先往下限拖（往右），夹到 280 且仍 docked ──
      const dragTo = async (deltaX: number, steps = 8): Promise<void> => {
        const box = (await page.getByTestId('work-panel-resizer').boundingBox())!
        const y = box.y + box.height / 2
        await page.mouse.move(box.x + 2, y)
        await page.mouse.down()
        await page.mouse.move(box.x + 2 + deltaX, y, { steps })
        await page.mouse.up()
      }
      await dragTo(400)
      await expect.poll(async () => (await shell()).panelPreference).toBe('280px')
      const atMin = await settledShell()
      expect(atMin.panelSource).toBe('none')
      expect(atMin.mainDisplay).not.toBe('none')
      expect(atMin.panelSource).toBe(expectedSource(atMin))

      // 双击把手复位默认 400
      await page.getByTestId('work-panel-resizer').dblclick()
      await expect.poll(async () => (await shell()).panelPreference).toBe('400px')

      // 往上限方向慢慢拖：面板越过 554（= 1274 − 240 − 480）时聊天已不足最小可读宽 → 立刻转 auto
      const box = (await page.getByTestId('work-panel-resizer').boundingBox())!
      const y = box.y + box.height / 2
      await page.mouse.move(box.x + 2, y)
      await page.mouse.down()
      let crossing: Awaited<ReturnType<typeof shell>> | null = null
      for (const delta of [80, 100, 120, 140, 160, 180, 200, 240, 300]) {
        await page.mouse.move(box.x + 2 - delta, y)
        const now = await shell()
        if (now.panelSource === 'auto') {
          crossing = now
          break
        }
      }
      await page.mouse.up()
      expect(crossing, '拖宽到聊天不足最小可读宽时应立刻转 auto').not.toBeNull()
      // auto 触发后 preference 仍停在用户最后一次显式宽度（500），实际 panelWidth 已铺满；
      // 用实测宽对账：panelWidth ≈ innerWidth − rail(56) − gap(6)（1280 下 ≈ 1218）。
      expect(crossing!.mainDisplay).toBe('none')
      expect(
        Math.abs(
          crossing!.panelWidth -
            (crossing!.innerWidth - primaryNavRail - sidebarWidth - edgeGap)
        )
      ).toBeLessThanOrEqual(8)
      expect(crossing!.panelSource).toBe(expectedSource(crossing!))
      // 松手后停稳：仍是 auto（宽度停在越界那一步，不会回弹）
      const pastBoundary = await settledShell()
      expect(pastBoundary.panelSource).toBe('auto')
      expect(pastBoundary.mainDisplay).toBe('none')
      expect(pastBoundary.panelSource).toBe(expectedSource(pastBoundary))
      // round 79：越界那一刻把手被卸载，拖动态要跟着收尾（否则 transition-none 永久挂着 = 拖拽手感没了）
      expect(pastBoundary.panelDragging).toBe(false)
      await functionEvidence(page, 'narrow-1280-drag-past-boundary.png')

      // ── 就地恢复并排（round 78）：auto 时头部给"恢复并排布局"这条真动作，点它把宽度收进可用宽 ──
      const restore = page.getByTestId('workbench-restore-split')
      await expect(restore).toBeVisible()
      await expect(restore).toHaveAccessibleName('恢复并排布局')
      await expect(page.getByTestId('workbench-fullscreen')).toHaveCount(0)
      await restore.click()
      await expect.poll(async () => (await shell()).panelSource).toBe('none')
      const restored = await settledShell()
      expect(restored.panelSource).toBe('none')
      expect(restored.mainDisplay).not.toBe('none')
      expect(restored.mainWidth).toBeGreaterThanOrEqual(minChatWidth)
      expect(restored.resizerCount).toBe(1)
      // 只往窄收（不会把宽度撑大）、不动用户的全屏偏好
      const restoredPreference = Number.parseFloat(restored.panelPreference)
      expect(restoredPreference).toBeLessThan(560)
      expect(restoredPreference).toBeGreaterThanOrEqual(280)
      expect(restored.panelFullscreen).toBe('false')
      expect(restored.panelSource).toBe(expectedSource(restored))
      // round 79：恢复后不能留着拖动残留 —— 没有 transition-none，把手线也不是强调蓝
      expect(restored.panelDragging).toBe(false)
      expect(restored.resizerLineColor).toBe('rgba(0, 0, 0, 0)')
      await functionEvidence(page, 'narrow-1280-restored-in-place.png')
      // 记录（不断言）：拖拽在 auto 翻转时把把手卸载了，pointerup 落不到它身上 —— 看恢复之后
      // WorkPanel 是不是还停在 dragging（表现：面板带 transition-none、把手高亮线还是强调色）。
      // 这是给 owner 的观察，不是本轮的断言口径，所以只记事实。
      record(
        'resizerAfterRestore',
        await page.evaluate(() => {
          const panel = document.querySelector('[data-testid="work-panel"]')
          const handle = document.querySelector('[data-testid="work-panel-resizer"]')
          const highlight = handle?.querySelector('span') ?? null
          return {
            panelHasTransitionNone: panel?.classList.contains('transition-none') ?? null,
            resizerPresent: handle !== null,
            highlightBackground:
              highlight === null ? null : getComputedStyle(highlight).backgroundColor
          }
        })
      )

      // 恢复：拉宽窗口 → 立刻重判回 docked（app-shell 注释里那条"拉宽窗口都会立刻重新判定"）
      await resizeTo(1400)
      await expect.poll(async () => (await shell()).panelSource).toBe('none')
      const recovered = await settledShell()
      expect(recovered.mainDisplay).not.toBe('none')
      expect(recovered.resizerCount).toBe(1)
      // 回到 400 再收窄到 1280：仍是并列
      await page.getByTestId('work-panel-resizer').dblclick()
      await expect.poll(async () => (await shell()).panelPreference).toBe('400px')
      await resizeTo(1280)
      await expect.poll(async () => (await shell()).panelSource).toBe('none')
      const final = await settledShell()
      expect(final.mainDisplay).not.toBe('none')
      expect(final.mainWidth).toBeGreaterThanOrEqual(480)
      await functionEvidence(page, 'narrow-1280-docked.png')

      // ── 编译 CSS 的 C2 行高 token：不只认类名，实际计算值必须是 14px ──
      // 探针元素挂在真页面上，量到的就是**构建产物里这条规则**在本机引擎里的计算值
      const c2 = await page.evaluate(() => {
        const probe = document.createElement('div')
        probe.className = 'h-(--ui-C2-line-height)'
        document.body.appendChild(probe)
        const computed = getComputedStyle(probe)
        const measured = {
          token: computed.getPropertyValue('--ui-C2-line-height').trim(),
          height: computed.height,
          rect: Math.round(probe.getBoundingClientRect().height),
          fontTier: document.documentElement.getAttribute('data-font-size')
        }
        probe.remove()
        return measured
      })
      // 0.2.0 组件库把该 token 写成 calc(14px * 1.000)（等比缩放变量），字面量不再固定 '14px'
      expect(c2.token).toMatch(/^(14px|calc\(14px \* 1(?:\.0+)?\))$/)
      expect(c2.height).toBe('14px')
      expect(c2.rect).toBe(14)
      record('c2LineHeight', c2)

      record('states', {
        start,
        narrow800: narrow,
        collapsed800: collapsed,
        expanded800: expanded,
        closed800: back,
        wide1280: wide,
        dragMin280: atMin,
        dragCrossing: crossing,
        dragPastBoundary: pastBoundary,
        restoredInPlace: restored,
        widened1400: recovered,
        final1280: final
      })
      writeObservations('narrow-window-observations.json')
    } finally {
      await app.close()
      await provider.close()
    }
  })
})
