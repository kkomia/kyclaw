import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, waitForChat } from './harness'

/**
 * 006 / 008 的**真机面**（真 Electron + 真鼠标事件 + 真 crypto.subtle）：
 *
 * jsdom 里钉不动的两件事，这一条钉：
 *   1. **鼠标 hover**（真 pointer 事件，不是 `fireEvent.focus`）让发送时间显形 —— 008 返工后
 *      是**裸文字**：无背景 / 无边框 / 无气泡，靠 opacity 显隐；
 *   2. 真渲染端确实有平台能力 `crypto.subtle`（metadata 里的 SHA-256 就是用它算的 —— 没有它
 *      整条隐藏链会安全退化成显示原文，所以"附件段被藏住"本身就间接证了它，这里再显式看一眼）。
 *
 * 附件走**拖拽**那条真入口（合成 DataTransfer：与「＋ 上传 / 粘贴」同一条 `pickFiles` 管线；
 * 合成 File 没有磁盘路径 → 正好走"拿不到路径"的文本内联兜底，围栏内容进正文）。
 *
 * 隐藏口径（138 裁决"验过才藏"）：气泡先按原文渲染，渲染端算完 SHA-256 才把追加段藏起来 ——
 * 所以 006 那一条里"藏住了 + 图标项出现"本身就意味着真渲染端的摘要复核通过了。
 *
 * 跑法：`pnpm build && pnpm exec playwright test e2e/_r95-message-context.spec.ts`
 *
 * 已知环境特性（实测，探针里按它做了重试，不是产品行为的口径）：
 *   - 刚 build 完的第一次启动明显更慢（新写的 8MB bundle 被 Windows Defender 扫），且启动窗口里
 *     `composer-input` 已经可见但"实例还没就绪"（发送钮 disabled）；
 *   - 在那一小段里填字**偶尔**落在 remount 窗口上（草稿过桥那一瞬），填进去的字会被丢掉 ——
 *     探针因此用 `sendText`：填 + 等按钮可用 + 点 + 确认自己的话上屏，不成功就再试一次。
 */
const NOTE_BODY = ['kyclaw probe line one', 'kyclaw probe line two'].join('\n')

/** 本机时区的 `YYYY-MM-DD HH:mm`（与渲染端展示口径一致；允许跨分钟的那一档） */
function localMinuteLabel(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * 填一句、发出去、并确认自己的话真的上了屏（启动窗口里的 remount 可能吞掉一次填写）。
 * 只在这条探针里用 —— 产品侧的草稿过桥口径不在这里钉。
 */
async function sendText(page: Page, text: string): Promise<void> {
  const deadline = Date.now() + 120_000
  for (;;) {
    await page.getByTestId('composer-input').fill(text)
    if (
      await page
        .getByTestId('composer-send')
        .isEnabled()
        .catch(() => false)
    ) {
      await page.getByTestId('composer-send').click()
      const appeared = await page
        .locator('[data-role="user"]')
        .last()
        .getByText(text.slice(0, 8))
        .isVisible()
        .catch(() => false)
      if (appeared) {
        // 一轮收尾再看后续（避开流式中的中间态）
        await expect(page.getByTestId('composer-send')).toBeVisible({ timeout: 60_000 })
        return
      }
    }
    if (Date.now() > deadline) throw new Error(`发送没成功：${text.slice(0, 20)}`)
    await page.waitForTimeout(2000)
  }
}

test('008：真鼠标 hover 用户气泡 → 裸文字发送时间（无背景 / 无边框 / 无气泡）', async () => {
  test.setTimeout(180_000)
  const launched = await launchApp()
  const { page } = launched

  try {
    await waitForChat(page)
    await sendText(page, '顶针消息')

    const article = page.locator('[data-role="user"]').last()
    await expect(article).toContainText('顶针消息')

    // 没 hover 时：时间节点在 DOM 里，但 opacity 0（不是靠挂载 / 卸载 tooltip 来显隐）
    await page.mouse.move(0, 0)
    const sentAt = article.getByTestId('message-sent-at')
    await expect(sentAt).toHaveCSS('opacity', '0')

    // 真鼠标 hover：裸文字显形，文案是本地 `YYYY-MM-DD HH:mm` 且就是刚刚
    await article.getByTestId('message-body').hover()
    await expect(sentAt).toHaveCSS('opacity', '1')
    const label = ((await sentAt.textContent()) ?? '').trim()
    // 刚发出去的消息走**自有时间键**（精确发送时刻）：文案就是裸时间，不带"（记录时间）"限定
    expect(label).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(label).not.toContain('记录时间')
    const previous = new Date(Date.now() - 60_000)
    expect([localMinuteLabel(new Date()), localMinuteLabel(previous)]).toContain(label)

    // 裸文字口径（真 computed style）：无背景色、无边框、无圆角
    await expect(sentAt).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(sentAt).toHaveCSS('border-top-width', '0px')
    await expect(sentAt).toHaveCSS('border-radius', '0px')

    // 键盘焦点那一档（真 focus 事件；先把鼠标移开，证明不是 hover 撑着）
    await page.mouse.move(0, 0)
    await expect(sentAt).toHaveCSS('opacity', '0')
    await article.getByTestId('message-body').focus()
    await expect(sentAt).toHaveCSS('opacity', '1')
  } finally {
    await closeApp(launched)
  }
})

test('006：拖入的附件藏进气泡下方图标项；手写【附件】标记不被误吃', async () => {
  test.setTimeout(180_000)
  const launched = await launchApp()
  const { page } = launched

  try {
    await waitForChat(page)
    expect(await page.evaluate(() => typeof crypto?.subtle?.digest)).toBe('function')

    // 1. 手写【附件】块（没有 metadata 的旧/手打消息）：一个字节都不许吃
    const handwritten = '我自己写的\n\n【附件】手写.md\n```\n手写的内容\n```'
    await sendText(page, handwritten)
    const handwrittenArticle = page.locator('[data-role="user"]').first()
    await expect(handwrittenArticle).toContainText('【附件】手写.md')
    await expect(handwrittenArticle).toContainText('手写的内容')
    await expect(handwrittenArticle.getByTestId('message-context-item')).toHaveCount(0)

    // 2. 拖拽一个 .md 进输入卡（同一条 pickFiles 管线）→ 附件条出现
    const transfer = await page.evaluateHandle((body: string) => {
      const file = new File([body], 'note.md', { type: 'text/markdown' })
      const data = new DataTransfer()
      data.items.add(file)
      return data
    }, NOTE_BODY)
    await page.getByTestId('composer').dispatchEvent('drop', { dataTransfer: transfer })
    await expect(page.getByTestId('composer-attachment-note.md')).toBeVisible({ timeout: 30_000 })

    await sendText(page, '看这个文件')

    // 3. 气泡里只剩用户那句话；追加段（抬头 + 附件正文）都藏了；下方一枚图标项写着文件名
    const article = page.locator('[data-role="user"]').last()
    await expect(article).toContainText('看这个文件')
    await expect(article).not.toContainText('【附件】')
    await expect(article).not.toContainText('kyclaw probe line one')
    const item = article.getByTestId('message-context-item')
    await expect(item).toBeVisible()
    await expect(item).toContainText('note.md')
  } finally {
    await closeApp(launched)
  }
})
