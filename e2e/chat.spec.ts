import { expect, test } from '@playwright/test'
import { MOCK_REPLY_CHUNKS, MOCK_WRITE_MARKER } from '../src/mastra/model'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * 对话冒烟（plan T16 Step 2）：`KYCLAW_FORCE_MOCK=1`（R3）下走真链路——
 * 渲染端 → 内嵌 agent 服务（随机端口 + token）→ mock provider 的逐段流。
 * 断言用的是 mock 那份真身（`MOCK_REPLY_CHUNKS`，服务侧单测同一份），不是另抄的字符串。
 */
const REPLY_FULL = MOCK_REPLY_CHUNKS.join('')

test('对话：mock 流式回复逐段到达（先首段、后全文）', async () => {
  const launched = await launchApp()
  const { page } = launched

  try {
    await waitForChat(page)
    await sendMessage(page, '你好，kyclaw')

    // 自己的消息先上屏
    await expect(page.getByTestId('message-list')).toContainText('你好，kyclaw')

    // 流式：首段先到，此刻还不是全文（后两段各隔 250ms，够看）
    const reply = page.getByTestId('message-text')
    await expect(reply).toContainText(MOCK_REPLY_CHUNKS[0], { timeout: 20_000 })
    expect(await reply.innerText()).not.toContain(MOCK_REPLY_CHUNKS[MOCK_REPLY_CHUNKS.length - 1])

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
    await stop.click()

    // 停止后立刻回到"发送"态
    await expect(page.getByTestId('composer-send')).toBeVisible()

    // 停在哪儿就是哪儿：等 1.2s（够再走完两段 250ms 的增量）文本不许再长
    const reply = page.getByTestId('message-text')
    const settled = (await reply.count()) > 0 ? await reply.innerText() : ''
    await page.waitForTimeout(1200)
    const later = (await reply.count()) > 0 ? await reply.innerText() : ''

    expect(later).toBe(settled)
    // 收到的是全文的"前缀"：没有半截乱码、没有拼接出来的怪东西
    expect(REPLY_FULL.startsWith(later)).toBe(true)
  } finally {
    await closeApp(launched)
  }
})

/** 冒烟自带一次自检：E2E 认的口令与 mock 真身必须是同一个（否则审批冒烟会静默失联） */
test('自检：mock 的写文件口令能被识别（E2E 与 src 共用一份）', () => {
  expect(MOCK_WRITE_MARKER.test('创建 [[write:demo.txt]]')).toBe(true)
})
