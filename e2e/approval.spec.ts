import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/** 旧内置 mock 的写文件内容（逐字保留，仅本 spec 断言用；0.2.0 该 mock 已随旧内核删除） */
const APPROVAL_WRITE_CONTENT = 'kyclaw 离线 mock 写下的内容。\n'

/**
 * 审批冒烟（plan T16 Step 3）：write → 审批卡 → 允许一次 → 断言文件真落盘。
 *
 * ⚠️ 0.2.0 / PB-021 收口（Lead 2026-10-19 拍板）：**本 spec 暂停（test.skip），保留可追溯，不删**。
 * 原因：它依赖旧内置 mock 的 `[[write:…]]` 口令 + 宿主真写盘；0.2.0 的工具在内核进程里执行，
 * kernel stub 只回放协议帧、不执行产品工具（不假装工具产出），靠它无法证明内核审批。
 * 真审批闭环已由 gated 真内核探针承担：
 *   `src/main/kernel/__tests__/nia-approval-real.integration.spec.ts`
 *   （`KYCLAW_KERNEL_E2E=1`；确定性触发 = `write` + `sandbox_permissions:'danger-full-access'` + `justification`；
 *    覆盖 allow→文件真落盘 / reject→不落盘且正文不被替换 / HTTP 面 respond 闭环 + 重复提交 409）。
 * 契约与证据见 `.superpowers/dev-verify/20261019-0.2.0/nia/kernel-stub-contract.md` §8。
 *
 * 授权面：临时目录当工作区（mode=ask）经 settings.json 预置 —— 写类必须先问。
 *
 * 顺带留证：两张截图落 `smoke-t16/`（审批卡、允许后落盘），报告直接引用。
 */
const EVIDENCE_DIR = resolve(__dirname, '..', '.superpowers/sdd/2026-10-10-kyclaw-mvp/smoke-t16')

test('审批：写入文件 → 审批卡 → 允许一次 → 文件按内容落盘', async () => {
  test.skip(
    true,
    'PB-021：旧 mock 审批路径暂停；真审批已迁到 src/main/kernel/__tests__/nia-approval-real.integration.spec.ts（gated）'
  )
  const rootDir = mkdtempSync(join(tmpdir(), 'kyclaw-e2e-workspace-'))
  const workspace = join(rootDir, '工作区')
  mkdirSync(workspace, { recursive: true })
  const fileName = 'e2e-审批.txt'
  const target = join(workspace, fileName)

  const launched = await launchApp({ settings: { workspaces: [{ path: workspace, mode: 'ask' }] } })
  const { page } = launched

  try {
    await waitForChat(page)
    await sendMessage(page, `帮我创建 ${fileName}：[[write:${fileName}]]`)

    // 审批卡：目标文件 + 四个决策按钮都在
    const card = page.getByTestId('approval-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('approval-target')).toContainText(fileName)
    for (const id of [
      'approval-allow-once',
      'approval-allow-session',
      'approval-allow-forever',
      'approval-deny'
    ]) {
      await expect(page.getByTestId(id)).toBeVisible()
    }

    // 审批是真闸门：还没点"允许"，文件不许在盘上
    expect(existsSync(target)).toBe(false)
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: join(EVIDENCE_DIR, 'E2E-审批卡-写入文件.png') })

    await page.getByTestId('approval-allow-once').click()

    // 允许后：工具真执行 → 文件真落盘 → 内容与 mock 写的一字不差
    await expect.poll(() => existsSync(target), { timeout: 30_000 }).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(APPROVAL_WRITE_CONTENT)

    // 工具卡也收尾了（过程块跑完自动收起 → 展开看一眼"已完成"；过程块默认收起是 round 6 的口径）
    await expect(page.getByTestId('trace-block')).toHaveAttribute('data-open', 'false')
    await page.getByTestId('trace-toggle').click()
    await expect(page.getByTestId('tool-card')).toHaveAttribute('data-state', 'output-available')
    await expect(page.getByTestId('tool-state')).toHaveText('已完成')
    await page.screenshot({ path: join(EVIDENCE_DIR, 'E2E-允许后-落盘与已完成.png') })
  } finally {
    await closeApp(launched)
    rmSync(rootDir, { recursive: true, force: true })
  }
})
