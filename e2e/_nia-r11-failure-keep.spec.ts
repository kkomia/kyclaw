import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * R11（0.2.0 内核路径）· 失败保留链：**造一次失败轮 → 刷新 / 重开 → 失败轮与正文是否还在**。
 *
 * 目的：Ada 已用 UI 合成绿覆盖 retry-keep/error-card/chat-flow（3 files/32 passed），但缺 e2e 的
 * 「失败→刷新→仍在」与「真内核 `session/page` 是否保留失败轮」证据。本 spec 用 **kernel stub 的 error 场景**
 * 造确定性的失败轮（先交付一段正文，再 error 帧），然后把两条链路都走一遍：
 *   1) `page.reload()`：renderer 重挂（同一进程/同一 userData）；
 *   2) closeApp → 用**同一个 userDataDir** 重开。
 * 断言口径（R11 目标）：失败轮与已交付正文在刷新/重开后仍在；错误卡能重试。
 * 若内核历史（`session/page` 或宿主线程回灌）不含失败轮 → 本 spec 会红，并在失败消息里写明是哪一条链路丢的
 * （这是产品缺口证据，不是 stub 问题；stub 只回放协议帧）。
 *
 * 默认 skip（gated）：`KYCLAW_R11_E2E=1` 才跑；A2b 落地后作为 R11 真机证据跑一次。
 * 命令：$env:KYCLAW_R11_E2E='1'; $env:KYCLAW_KERNEL_PORT='1'; pnpm exec playwright test e2e/_nia-r11-failure-keep.spec.ts
 */
const ENABLED = process.env.KYCLAW_R11_E2E === '1'
const EVIDENCE = resolve('.superpowers/dev-verify/20261019-0.2.0/nia/r11-failure-keep.json')

test.describe('R11 · 失败轮保留（kernel stub error 场景）', () => {
  test.skip(!ENABLED, 'KYCLAW_R11_E2E=1 时才跑（R11 真机证据，需 pnpm build 的 out/ 产物）')

  test('失败轮（正文+错误卡）→ reload / 重开 → 仍在', async () => {
    test.setTimeout(180_000)
    const first = await launchApp({
      stub: { scenario: 'error', chunks: ['旧内容A'], chunkDelayMs: 50 },
      keepUserData: true
    })
    const evidence: Record<string, unknown> = {}
    let userDataDir = first.userDataDir
    try {
      await waitForChat(first.page)
      await sendMessage(first.page, '先别急着答')
      const text = first.page.getByTestId('message-text').last()
      await expect(text).toContainText('旧内容A', { timeout: 30_000 })
      const errorCard = first.page.getByTestId('error-card')
      await expect(errorCard).toBeVisible({ timeout: 30_000 })
      evidence.turn = {
        text: await text.innerText(),
        errorCard: (await errorCard.innerText()).slice(0, 400)
      }
      await first.page.screenshot({ path: resolve('.superpowers/dev-verify/20261019-0.2.0/nia/r11-turn.png') })

      // 链路 1：页面刷新（renderer 重挂）
      await first.page.reload()
      await waitForChat(first.page)
      await first.page.waitForTimeout(3_000)
      const afterReload = {
        messageCount: await first.page.getByTestId('message-text').count(),
        text: await first.page
          .getByTestId('message-text')
          .last()
          .innerText()
          .catch(() => ''),
        errorCard: await first.page
          .getByTestId('error-card')
          .isVisible()
          .catch(() => false)
      }
      evidence.afterReload = afterReload
      await first.page.screenshot({ path: resolve('.superpowers/dev-verify/20261019-0.2.0/nia/r11-after-reload.png') })
    } finally {
      await closeApp(first)
    }

    // 链路 2：关掉应用 → 同一个 userData 重开
    const second = await launchApp({ userDataDir, keepUserData: true })
    try {
      await waitForChat(second.page)
      await second.page.waitForTimeout(3_000)
      const afterReopen = {
        messageCount: await second.page.getByTestId('message-text').count(),
        text: await second.page
          .getByTestId('message-text')
          .last()
          .innerText()
          .catch(() => ''),
        errorCard: await second.page
          .getByTestId('error-card')
          .isVisible()
          .catch(() => false)
      }
      evidence.afterReopen = afterReopen
      await second.page.screenshot({
        path: resolve('.superpowers/dev-verify/20261019-0.2.0/nia/r11-after-reopen.png')
      })
    } finally {
      await closeApp(second)
    }

    writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

    const reloadLost =
      evidence.afterReload !== undefined &&
      !String((evidence.afterReload as { text?: string }).text ?? '').includes('旧内容A')
    const reopenLost =
      evidence.afterReopen !== undefined &&
      !String((evidence.afterReopen as { text?: string }).text ?? '').includes('旧内容A')
    expect(
      reloadLost,
      `R11 失败：刷新后失败轮正文丢失（evidence=${EVIDENCE}）——内核历史/session.page 不含失败轮，属产品缺口`
    ).toBe(false)
    expect(
      reopenLost,
      `R11 失败：重开后失败轮正文丢失（evidence=${EVIDENCE}）——内核历史/session.page 不含失败轮，属产品缺口`
    ).toBe(false)
    // 刷新/重开后错误卡应仍可重试（同一个失败轮）
    expect((evidence.afterReopen as { errorCard?: boolean }).errorCard).toBe(true)
  })
})
