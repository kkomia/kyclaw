import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * PB-050 复现探针（**门控**，日常 e2e 门禁 skip；`KYCLAW_PB050_PROBE=1` 时跑）：S6 偶发「服务暂时不可用」。
 *
 * 场景 A（空闲态 kill，8 次）：起 app（stub 内核）→ 发一条成功 → 从 kernel.log 取 pid → taskkill -F
 *   → 再发一条 → 抓错误卡主文案 / 详情原文 / kernel.log 尾部。
 * 场景 B（in-flight kill，4 次）：起 app → 发一条慢速流（chunkDelayMs=500）→ 流到一半 kill
 *   → 抓错误卡（覆盖"竞态"假设）。
 *
 * 证据：每次一行 PB050_ITER JSON；最后 PB050_SUMMARY。落盘由外部 tee。
 * 0.2.1 修复后复跑（场景 B 应全部 classify=detailed）。
 */
const OUT = process.env.PB050_OUT ?? join(process.cwd(), 'pb050-evidence.jsonl')
const ITER_A = Number(process.env.PB050_ITER_A ?? '8')
const ITER_B = Number(process.env.PB050_ITER_B ?? '4')
const enabled = process.env.KYCLAW_PB050_PROBE === '1'
const lines: string[] = []

function readKernelLog(userDataDir: string): string {
  const file = join(userDataDir, 'logs', 'kernel.log')
  if (!existsSync(file)) return ''
  return readFileSync(file, 'utf8')
}

function lastReadyPid(log: string): number | undefined {
  const ready = log
    .split('\n')
    .filter((line) => line.includes(' kernel.ready '))
    .at(-1)
  if (ready === undefined) return undefined
  const match = /\{.*\}/.exec(ready)
  if (match === null) return undefined
  try {
    const data = JSON.parse(match[0]) as { pid?: unknown }
    return typeof data.pid === 'number' ? data.pid : undefined
  } catch {
    return undefined
  }
}

async function captureCard(page: import('@playwright/test').Page): Promise<{
  cardCount: number
  message: string
  raw: string
  allText: string
}> {
  const card = page.getByTestId('error-card').last()
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  const message = (
    await card
      .getByTestId('error-message')
      .innerText()
      .catch(() => '')
  ).trim()
  const raw = (
    (await card
      .getByTestId('error-raw')
      .textContent({ timeout: 5_000 })
      .catch(() => '')) ?? ''
  ).trim()
  const allText = await card.innerText().catch(() => '')
  const cardCount = await page.getByTestId('error-card').count()
  return { cardCount, message, raw, allText }
}

function classify(message: string, raw: string): 'detailed' | 'generic' | 'other' {
  if (message.includes('服务暂时不可用')) return 'generic'
  if (message.includes('内核进程已退出') || raw.includes('内核进程已退出')) return 'detailed'
  return 'other'
}

test.describe.configure({ mode: 'serial' })

test('PB-050 场景 A：空闲态杀内核 × N', async () => {
  test.skip(!enabled, '门控探针：KYCLAW_PB050_PROBE=1（需先构建 out/）')
  test.setTimeout(600_000)
  for (let index = 1; index <= ITER_A; index += 1) {
    const launched = await launchApp({ kernel: 'stub', keepUserData: true })
    const { page, userDataDir } = launched
    let record: Record<string, unknown> = { scenario: 'A', iteration: index }
    try {
      await waitForChat(page)
      await sendMessage(page, `第 ${String(index)} 次：先正常回一条`)
      await page.getByTestId('message-text').first().waitFor({ state: 'visible', timeout: 30_000 })
      const logBefore = readKernelLog(userDataDir)
      const pid = lastReadyPid(logBefore)
      if (pid === undefined) throw new Error('kernel.ready 里没有 pid')
      const kill = spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' })
      record.pid = pid
      record.kill = `${String(kill.status)} ${kill.stdout ?? ''} ${kill.stderr ?? ''}`.trim()
      await page.waitForTimeout(600)
      await sendMessage(page, '崩溃后再发一条')
      const card = await captureCard(page)
      const logAfter = readKernelLog(userDataDir)
      const crashed = logAfter.split('\n').filter((line) => line.includes(' kernel.crashed '))
      record = {
        ...record,
        message: card.message,
        raw: card.raw.slice(0, 600),
        cardCount: card.cardCount,
        hasExitCode: /exitCode=|signal /.test(`${card.message}\n${card.raw}`),
        hasLogPath: card.raw.includes('kernel.log'),
        crashedLines: crashed.length,
        crashedTail: crashed.at(-1)?.slice(0, 500) ?? null,
        classify: classify(card.message, card.raw)
      }
    } catch (error) {
      record = { ...record, error: error instanceof Error ? error.message : String(error) }
    } finally {
      lines.push(JSON.stringify(record))
      writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
      await closeApp(launched)
    }
  }
})

test('PB-050 场景 B：in-flight 杀内核 × N（慢速流中 kill）', async () => {
  test.skip(!enabled, '门控探针：KYCLAW_PB050_PROBE=1（需先构建 out/）')
  test.setTimeout(600_000)
  for (let index = 1; index <= ITER_B; index += 1) {
    const launched = await launchApp({
      kernel: 'stub',
      keepUserData: true,
      stub: { chunkDelayMs: 500 }
    })
    const { page, userDataDir } = launched
    let record: Record<string, unknown> = { scenario: 'B', iteration: index }
    try {
      await waitForChat(page)
      const pid = lastReadyPid(readKernelLog(userDataDir))
      if (pid === undefined) throw new Error('kernel.ready 里没有 pid')
      await sendMessage(page, '长回答：说到一半我要杀掉内核')
      // 等首段正文出现（说明流已开始），再 kill（此刻 in-flight）
      await page.getByTestId('message-text').first().waitFor({ state: 'visible', timeout: 30_000 })
      await page.waitForTimeout(300)
      const kill = spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' })
      record.pid = pid
      record.kill = `${String(kill.status)} ${kill.stdout ?? ''} ${kill.stderr ?? ''}`.trim()
      const card = await captureCard(page)
      const logAfter = readKernelLog(userDataDir)
      const crashed = logAfter.split('\n').filter((line) => line.includes(' kernel.crashed '))
      record = {
        ...record,
        message: card.message,
        raw: card.raw.slice(0, 600),
        cardCount: card.cardCount,
        hasExitCode: /exitCode=|signal /.test(`${card.message}\n${card.raw}`),
        hasLogPath: card.raw.includes('kernel.log'),
        crashedLines: crashed.length,
        classify: classify(card.message, card.raw)
      }
    } catch (error) {
      record = { ...record, error: error instanceof Error ? error.message : String(error) }
    } finally {
      lines.push(JSON.stringify(record))
      writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
      await closeApp(launched)
    }
  }
})

test('PB-050 汇总', () => {
  test.skip(!enabled, '门控探针：KYCLAW_PB050_PROBE=1（需先构建 out/）')
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  const counts = (scenario: string): Record<string, number> => {
    const subset = records.filter((record) => record.scenario === scenario)
    return {
      total: subset.length,
      detailed: subset.filter((record) => record.classify === 'detailed').length,
      generic: subset.filter((record) => record.classify === 'generic').length,
      other: subset.filter((record) => record.classify === 'other').length,
      errors: subset.filter((record) => record.error !== undefined).length
    }
  }
  console.log(`PB050_SUMMARY ${JSON.stringify({ A: counts('A'), B: counts('B'), out: OUT })}`)
})
