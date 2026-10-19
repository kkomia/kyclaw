// @vitest-environment node
/**
 * R68 探针 D：**真模型 before/after**（同一个任务、同一个模型，只差这一轮加的东西）。
 *
 * 任务（与 round 67 的基线逐字一致）：
 *   「简单查下今天的新闻，做个简报 PPT 给我，简单做下就行」
 * 基线（before）：`.superpowers/sdd/.../_r67-probe/_r67-real-before.json`（15:00 那次真跑，
 *   14 次 LLM 调用、产出 181KB 的 pptx、**没有任何"看产出"的动作**——那时 render_ppt 还不存在）。
 *
 * 这一条要回答的：
 *   1. 模型**真的会**去调 render_ppt 吗（技能里的硬流程有没有生效）？调了几次？
 *   2. 有没有"看完再改"（render → 改 → 再 render）这个循环？
 *   3. 产出质量：页数 / 有没有套话页 / 有没有来源 / 有没有 `—` 占位 / 条目的"小标题｜正文"结构。
 *   4. 代价：LLM 调用次数、Σprompt tokens（和 before 比）。
 *
 * 做法：globalThis.fetch 包一层旁观（不碰被测代码），记下每次请求的载荷与 SSE 里的 usage；
 * 跑完再从**最后一次请求**的 messages 里把顺序对的 tool_calls 抽出来（历史是累积的，最后一次最全）。
 * 最后用 PowerPoint 把产出的 pptx 逐页导成 PNG 落到证据目录，供人（和后续的模型）目检。
 *
 * 用法（会真花钱）：
 *   KYCLAW_R68_REAL=1 pnpm exec vitest run src/main/agent/__tests__/_r68-real.spec.ts
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../service'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import { resolveModel } from '../../model'
import { settingsPath, writeSettings } from '../../settings'
import { defaultSettings, type Workspace } from '../../../shared/settings'
import type { ProviderConfig } from '../../../shared/providers'
import { extractPptx } from '../../workbench-office'
import { runProcess } from '../../tools/exec'

const requested = process.env.KYCLAW_R68_REAL === '1'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp', '_r68-probe')

const BASE_URL = process.env.KYCLAW_R68_BASE ?? 'https://api.deepseek.com'
const API_KEY = process.env.KYCLAW_R68_KEY ?? ''

/** 门开一半（REAL=1 但 KEY 空）时说清为什么跳过：本文件**不提供任何默认密钥** */
if (requested && API_KEY === '') {
  console.warn('[R68] KYCLAW_R68_REAL=1 但 KYCLAW_R68_KEY 为空——真服务探针跳过（没有默认密钥可用）')
}
const enabled = requested && API_KEY !== ''
const MODEL = process.env.KYCLAW_R68_MODEL ?? 'deepseek-flash'
const TASK = process.env.KYCLAW_R68_TASK ?? '简单查下今天的新闻，做个简报 PPT 给我，简单做下就行'
const LABEL = process.env.KYCLAW_R68_LABEL ?? 'after'
/** 内置技能根目录（与生产 main/index.ts 的 builtinSkillsDir() 同一处：开发态 = 仓库的 resources/skills） */
const SKILLS_DIR = join(repoRoot, 'resources', 'skills')

interface SeenRequest {
  bodyChars: number
  messageCount: number
  toolCount: number
  toolsChars: number
  systemChars: number
  /** provider 报的用量（SSE 尾部的 include_usage 块） */
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number } | null
  /** 这次请求里累积的 tool 调用顺序（从历史里抽的；最后一次最全） */
  toolCalls: string[]
  /** model 给的最后一条 user 文本（用于确认任务没被改） */
  lastUserText: string
}

function usageOfSse(text: string): SeenRequest['usage'] {
  let found: SeenRequest['usage'] = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    try {
      const parsed = JSON.parse(data) as {
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_cache_hit_tokens?: number
        }
      }
      if (parsed.usage != null) {
        found = {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          cachedTokens: parsed.usage.prompt_cache_hit_tokens ?? 0
        }
      }
    } catch {
      // 心跳/注释行跳过
    }
  }
  return found
}

/** 从一次请求的 messages 里把 tool 调用按顺序抽出来（assistant.tool_calls[].function.name） */
function toolCallsOf(messages: ReadonlyArray<Record<string, unknown>>): string[] {
  const names: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const calls = message.tool_calls
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      const name = (call as { function?: { name?: unknown } }).function?.name
      if (typeof name === 'string') names.push(name)
    }
  }
  return names
}

function lastUserTextOf(messages: ReadonlyArray<Record<string, unknown>>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') return content.slice(0, 200)
    if (Array.isArray(content)) {
      return content
        .map((part) => (part as { text?: string }).text ?? '')
        .join(' ')
        .slice(0, 200)
    }
  }
  return ''
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(`${full.slice(root.length + 1)} (${statSync(full).size} bytes)`)
    }
  }
  walk(root)
  return out
}

/** 产出质量的可核对指标（判据写在证据里，人/模型可以复核） */
function deckReport(bytes: Uint8Array): Record<string, unknown> {
  const { slides } = extractPptx(bytes)

  // 每页的"正文行"：标题 + 正文，去掉除封面外自动加的那条页脚（左=文档标题、右=页码）
  const stripped = slides.map((slide) => {
    const lines = [...(slide.title === undefined ? [] : [slide.title]), ...slide.lines]
    while (lines.length > 0 && /^\d+$/.test(lines[lines.length - 1].trim())) lines.pop()
    return lines
  })
  // 页脚左半（文档标题）出现在**绝大多数**页末尾（封面没有）——按众数认出来再摘掉，
  // 不写死标题文本，也不要求"每一页都有"
  const tails = new Map<string, number>()
  for (const lines of stripped) {
    const last = lines.at(-1)
    if (last !== undefined && last.trim() !== '') tails.set(last, (tails.get(last) ?? 0) + 1)
  }
  const footerLine = [...tails.entries()]
    .filter(([, count]) => count >= 2 && count * 2 >= stripped.length)
    .sort((left, right) => right[1] - left[1])[0]?.[0]
  if (footerLine !== undefined) {
    for (const lines of stripped) if (lines.at(-1) === footerLine) lines.pop()
  }
  const bodies = stripped.map((lines) => lines.join(' / ').trim())

  /** 括注（来源）：`（财政部 10-13）` 这种 */
  const sourceMarkPattern = /（[^）]{3,24}）|\([^)]{3,24}\)/gu
  /** "小标题｜正文"里的竖线（全角｜或半角 |） */
  const sectionedPattern = /[^\s｜|]{2,8}｜/gu
  /** 空值占位（独立成条或成格） */
  const dashPattern = /(^|\s|\/|｜)(—|-|–|待定|暂无|N\/A|TBD)(\s|\/|$)/u

  return {
    pageCount: slides.length,
    /** 整页正文只剩致谢 → 占位页 */
    placeholderPages: bodies
      .map((text, index) => ({ index: index + 1, text }))
      .filter((page) =>
        /^(谢谢观看|感谢聆听|感谢观看|敬请指正|谢谢|Thank you)[。！!]?$/u.test(page.text)
      )
      .map((page) => page.index),
    /** 出现 `—` / `待定` / `暂无` 这类空值占位的页（**注意**：表格单元格不在 extractPptx 的
     *  抽取范围内，所以表格里的占位抓不到 —— 见本轮报告"结构自检的盲区"） */
    dashPlaceholders: bodies
      .map((text, index) => ({ index: index + 1, text }))
      .filter((page) => dashPattern.test(page.text))
      .map((page) => page.index),
    /** 只有标题、没有正文的页（空页的近似判据；注意同样受"表格抽不到"影响） */
    thinPages: bodies
      .map((text, index) => ({ index: index + 1, text }))
      .filter((page) => page.text.length > 0 && page.text.length <= 14)
      .map((page) => page.index),
    /** 带来源括注的条目数 */
    sourceMarks: bodies.reduce(
      (sum, text) => sum + (text.match(sourceMarkPattern)?.length ?? 0),
      0
    ),
    /** "小标题｜正文"结构的条目数 */
    sectionedBullets: bodies.reduce(
      (sum, text) => sum + (text.match(sectionedPattern)?.length ?? 0),
      0
    ),
    pageTexts: bodies
  }
}

describe.runIf(enabled)(
  'R68 探针 D：真模型 after（同一任务，带 render_ppt 与新的自检硬口径）',
  () => {
    it(
      '跑一次新闻简报 PPT，抓调用序列、载荷用量与产出质量',
      async () => {
        mkdirSync(evidenceDir, { recursive: true })
        const dir = mkdtempSync(join(tmpdir(), 'kyclaw-r68-real-'))
        const ws = join(dir, 'ws')
        mkdirSync(ws, { recursive: true })
        const workspaces: Workspace[] = [{ path: ws, mode: 'full' }]
        const provider: ProviderConfig = {
          id: 'deepseek',
          type: 'openai-compatible',
          baseUrl: BASE_URL,
          model: MODEL,
          isDefault: true
        }
        writeSettings(settingsPath(dir), {
          ...defaultSettings(),
          providers: [provider],
          workspaces,
          defaultWorkspace: ws
        })

        const host = new URL(BASE_URL).host
        const seen: SeenRequest[] = []
        let firstSystemText = ''
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          if (!url.includes(host)) return originalFetch(input, init)

          let record: SeenRequest | null = null
          try {
            const raw = typeof init?.body === 'string' ? init.body : ''
            const parsed = JSON.parse(raw) as {
              messages?: Array<Record<string, unknown>>
              tools?: unknown[]
            }
            const messages = parsed.messages ?? []
            const tools = parsed.tools ?? []
            record = {
              bodyChars: raw.length,
              messageCount: messages.length,
              toolCount: tools.length,
              toolsChars: JSON.stringify(tools).length,
              systemChars: messages
                .filter((message) => message.role === 'system')
                .map((message) => JSON.stringify(message.content ?? ''))
                .join('\n').length,
              usage: null,
              toolCalls: toolCallsOf(messages),
              lastUserText: lastUserTextOf(messages)
            }
            // 第一条请求的系统指令原文留档（技能清单在不在、是新的还是旧的，一眼可查）
            if (seen.length === 0) {
              firstSystemText = messages
                .filter((message) => message.role === 'system')
                .map((message) =>
                  typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content)
                )
                .join('\n')
            }
            seen.push(record)
          } catch {
            // 不是 JSON 体的请求不记
          }

          const response = await originalFetch(input, init)
          if (record !== null) {
            const clone = response.clone()
            void clone
              .text()
              .then((text) => {
                record.usage = usageOfSse(text)
              })
              .catch(() => {})
          }
          return response
        }) as typeof globalThis.fetch

        let server: AgentServerHandle | undefined
        try {
          server = await startAgentServer({
            dataDir: dir,
            resolveModel: async () => (await resolveModel([provider], () => API_KEY)).model,
            workspaces: () => workspaces,
            defaultWorkspace: () => ws,
            projects: () => [],
            // **必须注入内置技能目录**（生产由 main/index.ts 的 builtinSkillsDir() 给）：
            // 不注入 = 这个 agent 根本没有内置技能，use_skill 只会回"暂无可用技能"——
            // 那样测出来的就只是"工具 + 系统指令"这一层，技能层的硬口径一条都没进上下文。
            builtinSkillsDir: SKILLS_DIR
          })

          const started = Date.now()
          const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${server.token}`
            },
            body: JSON.stringify({
              messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: TASK }] }],
              memory: { thread: `r68-${LABEL}`, resource: 'local-user' }
            })
          })
          expect(response.status).toBe(200)
          await response.text()
          await new Promise((r) => setTimeout(r, 3_000))
          const durationMs = Date.now() - started

          const withUsage = seen.filter((request) => request.usage !== null)
          const sumPrompt = withUsage.reduce(
            (sum, item) => sum + (item.usage?.promptTokens ?? 0),
            0
          )
          const sumCached = withUsage.reduce(
            (sum, item) => sum + (item.usage?.cachedTokens ?? 0),
            0
          )
          // 历史是累积的：最后一次请求里的 tool 序列最全
          const toolSequence = seen.at(-1)?.toolCalls ?? []
          const produced = listFiles(ws)

          // 产出质量：把最后落盘的那个 pptx 抽结构，并逐页导 PNG 供目检
          const deckName = produced
            .filter((entry) => /\.pptx \(\d+ bytes\)$/u.test(entry))
            .map((entry) => entry.slice(0, entry.lastIndexOf(' (')))
            .at(-1)
          let deck: Record<string, unknown> | null = null
          if (deckName !== undefined) {
            const deckAbs = join(ws, deckName)
            const { readFileSync } = await import('node:fs')
            try {
              deck = { path: deckName, ...deckReport(readFileSync(deckAbs)) }
            } catch (error) {
              deck = { path: deckName, error: String(error) }
            }
            const pngDir = join(evidenceDir, `_r68-${LABEL}-png`)
            rmSync(pngDir, { recursive: true, force: true })
            mkdirSync(pngDir, { recursive: true })
            const render = await runProcess({
              command: 'powershell.exe',
              args: [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                [
                  '$ErrorActionPreference = "Stop"',
                  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
                  `$before = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue).Count`,
                  '$app = New-Object -ComObject PowerPoint.Application',
                  'try {',
                  `  $pres = $app.Presentations.Open('${deckAbs.replace(/'/g, "''")}', $true, $false, $false)`,
                  `  try { $pres.Export('${pngDir.replace(/'/g, "''")}', 'PNG', 1600, 900) } finally { $pres.Close() }`,
                  '} finally {',
                  '  if ($before -eq 0) { $app.Quit() }',
                  '}'
                ].join('\n')
              ],
              timeoutMs: 180_000
            })
            writeFileSync(
              join(evidenceDir, `_r68-${LABEL}-render.log`),
              `exit=${render.exitCode} timedOut=${render.timedOut}\n${render.text}`
            )
          }

          const report = {
            label: LABEL,
            task: TASK,
            model: MODEL,
            durationMs,
            llmCallCount: seen.length,
            sumPromptTokens: sumPrompt,
            sumCachedTokens: sumCached,
            /** tool 调用序列（顺序） */
            toolSequence,
            /** 自检相关：调了几次 render_ppt、调了几次 create_ppt */
            renderPptCalls: toolSequence.filter((name) => name === 'render_ppt').length,
            createPptCalls: toolSequence.filter((name) => name === 'create_ppt').length,
            produced,
            deck,
            requests: seen,
            systemPromptChars: seen[0]?.systemChars ?? 0,
            /** 第一条请求的系统指令文件名与长度（证据：技能清单在不在） */
            skillsDir: SKILLS_DIR
          }
          writeFileSync(
            join(evidenceDir, `_r68-real-${LABEL}.json`),
            `${JSON.stringify(report, null, 2)}\n`
          )
          writeFileSync(join(evidenceDir, `_r68-system-prompt-${LABEL}.txt`), firstSystemText)
          console.log(
            `[r68] LLM 调用 ${seen.length} 次；Σprompt=${sumPrompt}（Σcache=${sumCached}）；耗时 ${(durationMs / 1000).toFixed(0)}s`
          )
          console.log(`[r68] tool 序列：${toolSequence.join(' → ')}`)
          console.log(
            `[r68] render_ppt=${report.renderPptCalls} 次；create_ppt=${report.createPptCalls} 次；产出 ${produced.length} 个文件`
          )
          console.log(`[r68] 产出：${produced.join('、').slice(0, 400)}`)
          if (deck !== null) console.log(`[r68] pptx 分析：${JSON.stringify(deck).slice(0, 500)}`)

          expect(seen.length).toBeGreaterThan(0)
        } finally {
          globalThis.fetch = originalFetch
          await server?.stop()
          try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
          } catch {
            console.warn('[kyclaw] r68 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
          }
        }
      },
      30 * 60 * 1000
    )
  }
)

/**
 * 同一个质量判据打**已有的** pptx（before/after 用同一把尺子量）：
 *   KYCLAW_R68_REAL=1 KYCLAW_R68_ANALYZE="D:\测试\tasks\3092e275\今日新闻日报_2026-10-13.pptx" \
 *     pnpm exec vitest run src/main/agent/__tests__/_r68-real.spec.ts
 */
describe('R68 探针 D：用同一判据给已有 deck 打分', () => {
  const deckPath = process.env.KYCLAW_R68_ANALYZE ?? ''
  it.skipIf(deckPath === '')(
    '对指定 pptx 出质量报告（页数 / 套话页 / 占位值 / 来源 / 条目结构）',
    async () => {
      const { readFileSync } = await import('node:fs')
      const report = deckReport(readFileSync(deckPath))
      mkdirSync(evidenceDir, { recursive: true })
      const name = deckPath.split(/[\\/]/).at(-1) ?? 'deck'
      writeFileSync(
        join(evidenceDir, `_r68-analyze-${name.replace(/\.pptx$/i, '')}.json`),
        `${JSON.stringify({ deck: deckPath, ...report }, null, 2)}\n`
      )
      const brief = report as {
        pageCount: number
        placeholderPages: number[]
        dashPlaceholders: number[]
        thinPages: number[]
        sourceMarks: number
        sectionedBullets: number
      }
      console.log(
        `[r68-analyze] ${name}：页数=${brief.pageCount}；套话页=[${brief.placeholderPages.join(',')}]；` +
          `占位值页=[${brief.dashPlaceholders.join(',')}]；只有标题的页=[${brief.thinPages.join(',')}]；` +
          `来源括注=${brief.sourceMarks}；"小标题｜"条目=${brief.sectionedBullets}`
      )
      expect(brief.pageCount).toBeGreaterThan(0)
    }
  )
})
