import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, sendMessage, waitForChat } from './harness'

/**
 * PB-042（R16「代码块首帧空白」）真机时间线探针 **+ 判据**（判据不放宽）。
 *
 * 口径（与 0.2.0 R16 采样一致）：
 *   - code-block **第一次插入 DOM 的那一帧**，`pre > code` 的 innerHTML 就必须非空且带 shiki 结构
 *     （`pre.shiki` + `var(--shiki-token-*)` 内联色）；`firstHtml=''` / 纯文本 / `data-highlighted="false"` 即红；
 *   - 代码块只插入一次、不重挂（`added=1 / removed=0`）；
 *   - 流结束时正文与高亮结构仍然正确。
 *
 * 修复前实测（0.2.1 探针，旧证据 `.superpowers/dev-verify/20261020-0.2.1/cyrus/r16-timeline.json`）：
 * 第一个快照 `data-highlighted="false"`、innerHTML 为空，约 58ms 后才有 shiki 结构。
 * 本次证据写到同目录的 `r16-timeline-fixed.json`（不覆盖旧证据，便于前后对比）。
 *
 * 用法（需先构建 `out/`，本 spec 不自己 build）：
 *   $env:KYCLAW_KERNEL_PORT='1'; pnpm exec playwright test e2e/_cyrus-r16-timeline.spec.ts
 */

const R16_CHUNKS = ['看这段代码：\n```ts\n', 'const a = 1\n', '```'] as const
const R16_CHUNK_DELAY_MS = 600
const EVIDENCE_DIR = '.superpowers/dev-verify/20261020-0.2.1/cyrus'
const EVIDENCE_FILE = `${EVIDENCE_DIR}/r16-timeline-fixed.json`

/** 门控：真机时间线探针默认不进常规 e2e 门禁（需要构建产物 + 采样时序）。 */
const enabled = process.env.KYCLAW_R16_PROBE === '1'

interface Sample {
  event: 'added' | 'changed'
  /** 相对探针开始的时间（ms） */
  t: number
  present: boolean
  highlighted: string | null
  htmlLength: number
  codeText: string
  hasShiki: boolean
}

test('PB-042 R16：code-block 首次插入 DOM 即带 shiki 高亮结构', async () => {
  test.skip(!enabled, '真机时间线探针：KYCLAW_R16_PROBE=1（需先构建 out/）')
  test.setTimeout(120_000)
  const launched = await launchApp({
    stub: {
      chunks: [...R16_CHUNKS],
      chunkDelayMs: R16_CHUNK_DELAY_MS
    }
  })
  const { page } = launched
  try {
    await waitForChat(page)
    await page.evaluate(() => {
      const w = window as unknown as {
        __r16: { events: Sample[]; added: number; removed: number; done: boolean }
      }
      w.__r16 = { events: [], added: 0, removed: 0, done: false }
      const t0 = performance.now()

      const state = (): Omit<Sample, 'event'> | null => {
        const el = document.querySelector('[data-testid="code-block"]') as HTMLElement | null
        if (el === null) return null
        const code = el.querySelector('pre code') as HTMLElement | null
        const pre = el.querySelector('pre')
        const html = code?.innerHTML ?? ''
        return {
          t: Math.round(performance.now() - t0),
          present: true,
          highlighted: el.getAttribute('data-highlighted'),
          htmlLength: html.length,
          codeText: code?.textContent ?? '',
          hasShiki: pre?.classList.contains('shiki') === true && /var\(--shiki-token-/u.test(html)
        }
      }
      const rec = (event: Sample['event']): void => {
        const sample = state()
        if (sample === null) return
        w.__r16.events.push({ event, ...sample })
      }

      let last: string | null = JSON.stringify(state())
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            const element = node as Element
            const blocks = [
              ...(element.matches?.('[data-testid="code-block"]') === true ? [element] : []),
              ...(element.querySelectorAll?.('[data-testid="code-block"]') ?? [])
            ]
            w.__r16.added += blocks.length
            if (blocks.length > 0) rec('added')
          }
          for (const node of mutation.removedNodes) {
            const element = node as Element
            if (element.matches?.('[data-testid="code-block"]') === true) w.__r16.removed += 1
          }
        }
        const next = JSON.stringify(state())
        if (next !== last) {
          last = next
          rec('changed')
        }
        // 首个 code-block 已上屏且带高亮 → 探针继续等流结束（剩下的 chunk 可能触发重挂）
        const current = state()
        if (w.__r16.added > 0 && current?.highlighted === 'true') w.__r16.done = true
      })
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-highlighted']
      })
      ;(window as unknown as { __r16Observer: MutationObserver }).__r16Observer = observer
    })

    await sendMessage(page, '给我一段代码')
    await page.waitForFunction(
      () => (window as unknown as { __r16: { done: boolean } }).__r16.done === true,
      undefined,
      { timeout: 30_000 }
    )
    // 等剩下两片（600ms 间隔）推完再把最终态和「有没有重挂」一起采掉
    await page.waitForTimeout(1500)

    const result = await page.evaluate(() => {
      const w = window as unknown as { __r16: { events: Sample[]; added: number; removed: number } }
      const el = document.querySelector('[data-testid="code-block"]') as HTMLElement | null
      const code = el?.querySelector('pre code') as HTMLElement | null
      const pre = el?.querySelector('pre')
      const finalHtml = code?.innerHTML ?? ''
      return {
        events: w.__r16.events,
        added: w.__r16.added,
        removed: w.__r16.removed,
        firstAdded: w.__r16.events.find((event) => event.event === 'added') ?? null,
        final: {
          highlighted: el?.getAttribute('data-highlighted') ?? null,
          htmlLength: finalHtml.length,
          codeText: code?.textContent ?? '',
          hasShiki:
            pre?.classList.contains('shiki') === true && /var\(--shiki-token-/u.test(finalHtml)
        },
        dom: {
          codeBlocks: document.querySelectorAll('[data-testid="code-block"]').length,
          messageText:
            (document.querySelector('[data-testid="message-text"]') as HTMLElement | null)
              ?.innerText ?? ''
        }
      }
    })

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(EVIDENCE_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

    // —— R16 判据：不放宽 ——
    const first = result.firstAdded
    expect(
      result.added,
      `code-block 重复挂载（added=${String(result.added)}，证据 ${EVIDENCE_FILE}）`
    ).toBe(1)
    expect(
      result.removed,
      `code-block 被重挂（removed=${String(result.removed)}，证据 ${EVIDENCE_FILE}）`
    ).toBe(0)
    expect(first, `code-block 从未插入 DOM（证据 ${EVIDENCE_FILE}）`).not.toBeNull()
    expect(
      first?.highlighted,
      `R16 首帧 data-highlighted 必须是 true（first=${JSON.stringify(first)}，证据 ${EVIDENCE_FILE}）`
    ).toBe('true')
    expect(
      first?.htmlLength ?? 0,
      `R16 首帧 pre>code 的 innerHTML 不能为空（first=${JSON.stringify(first)}，证据 ${EVIDENCE_FILE}）`
    ).toBeGreaterThan(0)
    expect(
      first?.hasShiki,
      `R16 首帧必须带 shiki 结构（first=${JSON.stringify(first)}，证据 ${EVIDENCE_FILE}）`
    ).toBe(true)
    expect(
      first?.codeText ?? '',
      `R16 首帧正文应与代码一致（first=${JSON.stringify(first)}，证据 ${EVIDENCE_FILE}）`
    ).toContain('const a = 1')
    expect(result.final.highlighted, `结束后仍应高亮（证据 ${EVIDENCE_FILE}）`).toBe('true')
    expect(result.final.hasShiki, `结束后仍应是 shiki 结构（证据 ${EVIDENCE_FILE}）`).toBe(true)
    expect(result.final.codeText, `结束后正文应完整（证据 ${EVIDENCE_FILE}）`).toContain(
      'const a = 1'
    )
    expect(result.dom.codeBlocks, `应恰好一个代码块（证据 ${EVIDENCE_FILE}）`).toBe(1)
  } finally {
    await closeApp(launched)
  }
})
