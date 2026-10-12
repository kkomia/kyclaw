import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * R62 真实场景探针（不进常规 e2e 闸门；只在 KYCLAW_R62_REAL=1 时运行）：
 * 用**真实 DeepSeek + 真实产出物工具**串行跑四个日常场景（Word / 表格 / PPT / 写代码），
 * 度量每回合墙钟耗时、收产出物清单与大小，并把隔离实例的 kyclaw.db 拷出来（token 复盘用）。
 *
 * 前置：先 `pnpm build`（harness 起的是 out/ 产物）。
 * 密钥播种：safeStorage 的密文与应用身份（含 userData 路径）绑定——预置真密钥的密文在隔离
 * userData 下解不开（实测），所以**走设置页把明文交给应用自己加密**（应用加密=应用解密，
 * 零猜测）；明文来自本机探针产物 `_r62-probe-app/_r62-lf-keys.json`，只进输入框、不落文件。
 * 用法：KYCLAW_R62_REAL=1 pnpm exec playwright test e2e/_r62-scenarios.spec.ts
 */
const repoRoot = resolve(__dirname, '..')
const evidenceDir = join(repoRoot, '.superpowers/sdd/2026-10-10-kyclaw-mvp')
const realUserData = join(process.env.APPDATA ?? '', 'kyclaw')

const SCENARIOS: Array<{ id: string; prompt: string; expectExt: string }> = [
  {
    id: 'word',
    prompt:
      '用 create_docx 生成一份《kyclaw 测试周报》Word 文档：标题 + 「本周进展 / 遇到的问题 / 下周计划」三节，每节 2-3 条要点。做完告诉我文件路径。',
    expectExt: '.docx'
  },
  {
    id: 'excel',
    prompt:
      '用 create_excel 做一张 2026 年 10 月个人开支表：列 = 日期 / 项目 / 金额 / 备注，填 8 行示例数据，金额一列给合计行。做完告诉我文件路径。',
    expectExt: '.xlsx'
  },
  {
    id: 'ppt',
    prompt:
      '用 create_ppt 做一个《kyclaw 产品介绍》PPT：封面 + 三页正文 + 结尾页。做完告诉我文件路径。',
    expectExt: '.pptx'
  },
  {
    id: 'code',
    prompt:
      '在工作区写一个 Python 脚本 fib_stats.py：打印斐波那契前 20 项与它们之和；然后用 bash 运行它，把输出贴给我。',
    expectExt: '.py'
  }
]

/** 等这一回合跑完：先进忙态（停止钮），回到空闲（发送钮回来且稳住）为止 */
async function waitForIdle(page: Page, timeoutMs = 420_000): Promise<void> {
  const send = page.getByTestId('composer-send')
  const stop = page.getByTestId('composer-stop')
  await expect(stop).toBeVisible({ timeout: 30_000 })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await send.isVisible()) && !(await stop.isVisible())) {
      await page.waitForTimeout(2_000)
      if (await send.isVisible()) return
    }
    await page.waitForTimeout(500)
  }
  throw new Error('等待回合结束超时')
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

test.describe('R62 真实场景（真模型真产出）', () => {
  test.skip(process.env.KYCLAW_R62_REAL !== '1', 'KYCLAW_R62_REAL=1 时才跑真模型场景')

  test('四个场景串行：Word / 表格 / PPT / 写代码', async () => {
    test.setTimeout(60 * 60 * 1000)
    const realSettings = JSON.parse(readFileSync(join(realUserData, 'settings.json'), 'utf8')) as {
      providers?: unknown
      langfuse?: unknown
    }
    const ws = mkdtempSync(join(tmpdir(), 'kyclaw-r62-ws-'))
    const plainSource = JSON.parse(
      readFileSync(join(evidenceDir, '_r62-probe-app', '_r62-lf-keys.json'), 'utf8')
    ) as Record<string, string>
    const launched = await launchApp({
      settings: {
        providers: realSettings.providers as never,
        defaultWorkspace: ws,
        workspaces: [{ path: ws, mode: 'full' }],
        ...(realSettings.langfuse === undefined ? {} : { langfuse: realSettings.langfuse as never })
      },
      env: { KYCLAW_FORCE_MOCK: '0' }
    })
    const { page } = launched
    const results: Array<Record<string, unknown>> = []
    try {
      await waitForChat(page)
      // 密钥交给**应用自己**加密（safeStorage 密文与身份绑定，预置密文在隔离 userData 下解不开）：
      // 设置页 → 模型 → 展开 deepseek → 填入明文 → 保存 → 「已配置」；明文只进输入框。
      await page.evaluate(() => {
        window.location.hash = '#/settings/model'
      })
      await page.getByTestId('provider-deepseek').getByRole('button').first().click()
      await page.getByTestId('provider-deepseek-key').fill(plainSource['deepseek__plain'] ?? '')
      await page.getByTestId('provider-deepseek-save').click()
      await expect(page.getByTestId('provider-deepseek-key-status')).toHaveText('已配置', {
        timeout: 20_000
      })
      await page.evaluate(() => {
        window.location.hash = '#/chat'
      })
      await waitForChat(page)
      for (const scenario of SCENARIOS) {
        const started = Date.now()
        await sendMessage(page, scenario.prompt)
        await waitForIdle(page)
        const durationMs = Date.now() - started
        results.push({ id: scenario.id, durationMs })
        console.log(`[r62] ${scenario.id} 回合耗时 ${(durationMs / 1000).toFixed(1)}s`)
      }
      const files = listFiles(ws).map((file) => ({
        path: relative(ws, file),
        bytes: statSync(file).size
      }))
      for (const file of files) console.log(`[r62] 产出 ${file.path} (${file.bytes} bytes)`)
      writeFileSync(
        join(evidenceDir, '_r62-scenarios-result.json'),
        `${JSON.stringify({ results, files }, null, 2)}\n`,
        'utf8'
      )
    } finally {
      // DB 快照要在 closeApp 之前（closeApp 会删掉临时 userData）；WAL/SHM 一起拷
      try {
        for (const suffix of ['', '-wal', '-shm']) {
          const src = join(launched.userDataDir, `kyclaw.db${suffix}`)
          if (existsSync(src)) {
            cpSync(src, join(evidenceDir, `_r62-scenarios-kyclaw.db${suffix}`), { force: true })
          }
        }
      } catch {
        /* 快照失败不影响断言 */
      }
      await closeApp(launched)
    }
    // 四类产出物都真的落了盘
    const produced = listFiles(ws)
    for (const scenario of SCENARIOS) {
      expect(
        produced.some((file) => file.toLowerCase().endsWith(scenario.expectExt)),
        `${scenario.id} 场景应产出 ${scenario.expectExt}（实际：${produced.map((f) => relative(ws, f)).join('、')}）`
      ).toBe(true)
    }
  })
})
