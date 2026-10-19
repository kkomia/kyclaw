import { expect, test } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * round 49 · 会话切换的可见性（用户实报）：
 * "一个项目对话，发送了之后 假如说，AI 还没回复 就切换到其他项目，这个对话会消失。"
 *
 * 机制：侧栏的草稿行只在 activeId 还停在草稿上时渲染，而服务端镜像要等轮末才刷新 ——
 * 发送后、回复前切走，两边都不在，那一行就没了。修复 = 发送那一刻先物化成真线程。
 *
 * 这里跑真链路（0.2.0：kernel stub 逐段流 ≈750ms，三段文本与旧 mock 逐字一致）：发送后立刻切走，那一行必须还在。
 * 断言给的窗口刻意短（500ms）：修复前它要等这一轮收尾（≈750ms 后）才回来，会落在这个窗口外。
 */
test('发送后 AI 还没回就切走会话：侧栏那一行还在', async () => {
  const launched = await launchApp()
  const { page } = launched

  try {
    await waitForChat(page)

    // 第一轮跑完（会话落成真线程，列表里有它）
    await sendMessage(page, '第一个会话')
    await expect(page.getByTestId('message-text').last()).toContainText('我是 kyclaw。', {
      timeout: 20_000
    })
    await expect(page.getByTestId('composer-send')).toBeVisible()

    const rows = page.locator('[data-testid^="session-item-"]')
    const firstRowId = await rows.first().getAttribute('data-testid')
    expect(firstRowId).not.toBeNull()

    // 新会话（草稿）→ 发出第一条，AI 还在流
    await page.getByTestId('new-session').click()
    await expect(rows).toHaveCount(2)
    const rowIds = await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-testid') ?? '')
    )
    const newRowId = rowIds.find((id) => id !== firstRowId)
    expect(newRowId).toBeTruthy()

    await sendMessage(page, '第二个会话')

    // AI 还没回就切回第一个会话：第二个会话那一行必须还在（修复前：它随 activeId 换走而消失）
    await page.getByTestId(firstRowId as string).click()
    await expect(page.getByTestId(newRowId as string)).toBeVisible({ timeout: 500 })
  } finally {
    await closeApp(launched)
  }
})
