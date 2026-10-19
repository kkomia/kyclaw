import { expect, test } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'
import { STUB_REPLY_CHUNKS } from './kernel-stub/mock-reply'

/**
 * 对话冒烟（plan T16 Step 2；0.2.0 / PB-021 迁移到 kernel stub）：
 * 渲染端 → 内嵌 agent 服务（随机端口 + token）→ **stub 内核进程**按协议回放逐段流。
 *
 * 断言用的分片来自 `e2e/kernel-stub/mock-reply.ts`（与 stub 默认分片同一份），
 * 不再是旧内置 mock（0.2.0 随旧内核删除）。
 */
const REPLY_FULL = STUB_REPLY_CHUNKS.join('')

test('对话：内核 stub 流式回复逐段到达（先首段、后全文）', async () => {
  const launched = await launchApp()
  const { page } = launched

  try {
    await waitForChat(page)
    await sendMessage(page, '你好，kyclaw')

    // 自己的消息先上屏
    await expect(page.getByTestId('message-list')).toContainText('你好，kyclaw')

    // 流式：首段先到，此刻还不是全文（后两段各隔 250ms，够看）
    const reply = page.getByTestId('message-text')
    await expect(reply).toContainText(STUB_REPLY_CHUNKS[0], { timeout: 20_000 })
    expect(await reply.innerText()).not.toContain(STUB_REPLY_CHUNKS[STUB_REPLY_CHUNKS.length - 1])

    // 收尾：全文落地
    await expect(reply).toHaveText(REPLY_FULL, { timeout: 20_000 })
    // 流结束（发送钮回来）
    await expect(page.getByTestId('composer-send')).toBeVisible()
  } finally {
    await closeApp(launched)
  }
})

test('停止：流式中给的是停止钮；点停 → 回到发送钮，文本不再增长', async () => {
  const launched = await launchApp()
  const { page } = launched

  try {
    await waitForChat(page)
    await sendMessage(page, '先别急着答')

    const stop = page.getByTestId('composer-stop')
    await expect(stop).toBeVisible()

    // 先等首段真的上屏再停：首段到之前点停等于什么都没验证（旧版断言会在这里空转）
    const reply = page.getByTestId('message-text')
    await expect(reply).toContainText(STUB_REPLY_CHUNKS[0], { timeout: 20_000 })
    await stop.click()

    // 停止后立刻回到"发送"态
    await expect(page.getByTestId('composer-send')).toBeVisible()

    // 停在哪儿就是哪儿：等 1.2s（够再走完两段 250ms 的增量）文本不许再长；
    // 两次都必须取到非空值（"双空相等"不算通过）
    const settled = await reply.innerText()
    expect(settled.length).toBeGreaterThan(0)
    await page.waitForTimeout(1200)
    const later = await reply.innerText()
    expect(later.length).toBeGreaterThan(0)
    expect(later).toBe(settled)
    // 收到的是全文的"前缀"：没有半截乱码、没有拼接出来的怪东西
    expect(REPLY_FULL.startsWith(later)).toBe(true)
  } finally {
    await closeApp(launched)
  }
})

// 旧第三例「自检：mock 的写文件口令能被识别」随旧 mock 删除：
// 0.2.0 的 write 工具在内核进程里执行，stub 只回放协议帧、不执行产品工具（不假装工具产出）。
// 审批/写文件链路的 e2e 口径改为真内核集成探针（见 nia/kernel-stub-contract.md §5）。
