// @vitest-environment node
/**
 * R71 · U13 探针：**工作区 `full` 时，经 `bash` 跑 `rm` 到底弹不弹审批？**
 *
 * ## 这份探针的来龙
 *
 * 决策清单 `_r71-cc-digest.md` 的 §3-U13 把"full 时 `rm` 经 bash 免审"标成**读码推断、未跑运行时验证**，
 * 而这条事实直接决定提案 #5 是"必修"还是"可降档"。这份 spec 用真链路（真 settings.json + 真 agent +
 * 真 chatRoute + 真 Git Bash + 真 `rm`）把审批行为钉在真文件系统上。
 *
 * ## 现在钉的口径（round 75，用户拍板）
 *
 * > "如果设置了全免那就是全免（但是是限定了的）…… 一个是工作区内免审核，一个是工作区外也免审核，
 * > 我们目前没去分开。"
 *
 * 所以判定**按目标落在哪个区**（判定链见 `mastra/tools/guard.ts` 的 needsApproval 头注）：
 *   - **区内 `full` → 免审**：这个文件夹里的写 / 删 / 移 / bash 命令都不再问，`rm -rf`、`delete`、
 *     `move` 都不问（round 71 那条"递归删除永远问"的红线已按用户口径撤掉）；
 *   - **区外 → 按「工作区之外」那一档**（`settings.outsideWorkspaceMode`）：默认 `ask`（弹卡），
 *     用户显式设成 `full` 就免审（他设了就照办，用例⑪）；
 *   - **判不出落在哪 → 保守问**（`~` / `$VAR` / 多工作区又没给 `cwd` 时的相对路径）。
 * 会话级 / 永久的"允许"通道与"为什么问"的卡片说明照旧（那两项是 round 71 的既有行为，本文件不覆盖）。
 *
 * ## 红→绿（本文件是那条基线）
 *
 * 用例②、④、⑤、⑥、⑧ 这五条在旧口径下断言的是"弹卡 / 什么都没执行"，现在按用户口径翻成
 * "免审 / 真执行"；用例①③⑦⑨⑩ 与新增的⑪⑫ 保持不变或新加。命令与断言都**只针对本 spec 自建的
 * 临时目录**（`mkdtemp` 下的 `ws` 与 `outside` 两块），不碰任何用户目录。
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { threadMemoryBody } from '../../shared/threads'
import { defaultSettings, type PermissionRule, type WorkspaceMode } from '../../shared/settings'
import { settingsPath, writeSettings } from '../../main/settings'
import { currentShell } from '../../main/git-bash' /* 只为把"本机解析出哪个 shell"打进证据里 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }
const FINISH_TOOLS = { unified: 'tool-calls' as const, raw: 'tool_calls' }

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

function textScript(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: FINISH_STOP, usage: USAGE }
  ]
}

function toolCallScript(toolCallId: string, toolName: string, input: unknown): StreamPart[] {
  const json = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: json },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: json },
    { type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE }
  ]
}

function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

/** Git Bash 只吃正斜杠；Windows 路径原样喂进去会被反斜杠转义吃掉 */
function posix(path: string): string {
  return path.replace(/\\/g, '/')
}

let dir: string
let workspace: string
/** 授权工作区**之外**的一个目录（本 spec 自建，用来验证区外那一档） */
let outside: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []

function push(toolCallId: string, toolName: string, input: unknown): void {
  scripts.length = 0
  scripts.push(() => toolCallScript(toolCallId, toolName, input))
  scripts.push(() => textScript('处理完了。'))
}

interface RunOutcome {
  approval: Array<Record<string, unknown>>
  outputAvailable: Array<Record<string, unknown>>
  errors: string[]
  partTypes: string[]
}

/** 授权表：'full'/'ask' = 只授权本探针工作区；显式数组 = 多工作区（会话根判定的边界用例） */
type ModeArg = 'full' | 'ask' | ReadonlyArray<{ path: string; mode: WorkspaceMode }>

async function chat(
  threadId: string,
  mode: ModeArg,
  toolName: string,
  rules: PermissionRule[] = [],
  /** 「工作区之外」那一档（round 75；缺省 = 落盘默认的 ask） */
  outsideWorkspaceMode: WorkspaceMode = 'ask'
): Promise<RunOutcome> {
  const workspaces = typeof mode === 'string' ? [{ path: workspace, mode }] : [...mode]
  writeSettings(settingsPath(dir), {
    ...defaultSettings(),
    workspaces,
    permissions: { rules },
    outsideWorkspaceMode
  })

  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [
        { id: `u-${threadId}`, role: 'user', parts: [{ type: 'text', text: '按我说的做' }] }
      ],
      ...threadMemoryBody(threadId)
    })
  })
  expect(response.status).toBe(200)
  const parsed = sseParts(await response.text())

  const outcome: RunOutcome = {
    approval: parsed.filter((part) => part.type === 'tool-approval-request'),
    outputAvailable: parsed.filter((part) => part.type === 'tool-output-available'),
    errors: parsed
      .filter((part) => part.type === 'tool-output-error')
      .map((part) => String(part.errorText ?? '')),
    partTypes: parsed.map((part) => String(part.type))
  }

  const verdict = outcome.approval.length > 0 ? '弹了审批卡' : '没有审批卡'
  console.log(
    `[r71-u13] ${toolName} @ ${workspaces.map((w) => `${w.path.slice(dir.length + 1)}:${w.mode}`).join('+')}` +
      `；区外档=${outsideWorkspaceMode} → ${verdict}；tool-output-available=${outcome.outputAvailable.length}` +
      `；tool-output-error=${JSON.stringify(outcome.errors)}` +
      `；parts=${JSON.stringify(outcome.partTypes)}`
  )
  return outcome
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-r71-u13-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  mkdirSync(join(dir, 'outside'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))
  outside = realpathSync.native(join(dir, 'outside'))
  writeFileSync(join(workspace, 'a.txt'), 'AAA\n', 'utf8')

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-r71-u13-mock',
    modelId: 'kyclaw-r71-u13-mock',
    doStream: async () => {
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({ chunks: script(), initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  })

  // 不注入 workspaces：服务端现读 dataDir/settings.json（与设置页同一条链）
  server = await startAgentServer({ dataDir: dir, model })
  console.log(
    `[r71-u13] 环境：temp=${dir}；workspace=${workspace}；outside=${outside}；` +
      `shell=${currentShell()?.kind ?? 'null'}（${currentShell()?.path ?? '-'}）；platform=${process.platform}`
  )
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('U13：full 工作区下 bash rm 的审批行为（真链路）', () => {
  it('① 整条命令里有一个**区外**目标：区外档默认问 → 弹卡、两个文件一个都没动', async () => {
    const insideVictim = join(workspace, 'inside-victim.txt')
    const outsideVictim = join(outside, 'outside-victim.txt')
    writeFileSync(insideVictim, 'inside\n', 'utf8')
    writeFileSync(outsideVictim, 'outside\n', 'utf8')

    // cwd 落在 full 工作区里，但命令里还有一个区外目标 → 这次调用判成"区外" → 走区外档（默认 ask）
    push('rm-in-cwd', 'bash', {
      cwd: workspace,
      command: `rm -f "${posix(insideVictim)}" "${posix(outsideVictim)}"`
    })
    const outcome = await chat('r71-u13-a', 'full', 'bash(rm，区内+区外)')

    expect(outcome.approval.length).toBeGreaterThan(0)
    expect(existsSync(insideVictim)).toBe(true)
    expect(existsSync(outsideVictim)).toBe(true)
    console.log(
      `[r71-u13] 判决：full + bash(cwd=区内，命令里含区外目标) → 弹审批卡；` +
        `区内文件仍在=${existsSync(insideVictim)}；区外文件仍在=${existsSync(outsideVictim)}`
    )
  }, 60_000)

  it('② 区内 full + 递归删除**区内的**目录树：免审、真删（"设了全免就是全免"）', async () => {
    const victimDir = join(workspace, 'tree-to-die')
    mkdirSync(join(victimDir, 'nested'), { recursive: true })
    writeFileSync(join(victimDir, 'nested', 'deep.txt'), 'deep\n', 'utf8')

    // 无 cwd：单工作区 → 相对目标以它为基准；命令只碰工作区内 → 区 = full → 免审
    push('rmrf-in-ws', 'bash', { command: `rm -rf "${posix(victimDir)}"` })
    const outcome = await chat('r71-u13-b', 'full', 'bash(rm -rf，区内)')

    expect(outcome.approval).toHaveLength(0)
    expect(outcome.errors).toEqual([])
    expect(existsSync(victimDir)).toBe(false)
    console.log(
      `[r71-u13] 判决：full + bash(rm -rf 区内目录树) → 没有审批卡；整树已删=${!existsSync(victimDir)}`
    )
  }, 60_000)

  it('③ 区内 full、命令删的是**区外**目录树：区外档默认问 → 弹卡、树还在', async () => {
    const victimDir = join(outside, 'outside-tree')
    mkdirSync(join(victimDir, 'nested'), { recursive: true })
    writeFileSync(join(victimDir, 'nested', 'deep.txt'), 'deep\n', 'utf8')

    push('rmrf-outside', 'bash', {
      cwd: workspace,
      command: `rm -rf "${posix(victimDir)}"`
    })
    const outcome = await chat('r71-u13-i', 'full', 'bash(rm -rf，区外)')

    expect(outcome.approval.length).toBeGreaterThan(0)
    expect(existsSync(victimDir)).toBe(true)
    console.log(
      `[r71-u13] 判决：full + bash(cwd=区内，rm -rf 区外) → 弹审批卡；整树仍在=${existsSync(victimDir)}`
    )
  }, 60_000)

  it('④ 区内 full + delete 工具：免审、真删（删除不再"永远问"）', async () => {
    const victim = join(workspace, 'delete-victim.txt')
    writeFileSync(victim, 'x\n', 'utf8')

    push('full-delete', 'delete', { path: 'delete-victim.txt' })
    const outcome = await chat('r71-u13-c', 'full', 'delete')

    expect(outcome.approval).toHaveLength(0)
    expect(outcome.errors).toEqual([])
    expect(existsSync(victim)).toBe(false)
    console.log(`[r71-u13] 判决：full + delete → 没有审批卡；文件已删=${!existsSync(victim)}`)
  }, 60_000)

  it('⑤ 区内 full + move 工具：免审、真移动（移动不再"永远问"）', async () => {
    const victim = join(workspace, 'move-victim.txt')
    writeFileSync(victim, 'y\n', 'utf8')

    push('full-move', 'move', { path: 'move-victim.txt', to: 'moved.txt' })
    const outcome = await chat('r71-u13-d', 'full', 'move')

    expect(outcome.approval).toHaveLength(0)
    expect(outcome.errors).toEqual([])
    expect(existsSync(victim)).toBe(false)
    expect(existsSync(join(workspace, 'moved.txt'))).toBe(true)
    console.log(
      `[r71-u13] 判决：full + move → 没有审批卡；源文件已不在=${!existsSync(victim)}；` +
        `目标已生成=${existsSync(join(workspace, 'moved.txt'))}`
    )
  }, 60_000)

  it('⑥ 区外目标走区外档（对照②）：full + bash(cwd 在工作区外) → 弹卡', async () => {
    const victim = join(outside, 'cwd-outside-victim.txt')
    writeFileSync(victim, 'z\n', 'utf8')

    push('rm-cwd-outside', 'bash', {
      cwd: outside,
      command: `rm -f "${posix(victim)}"`
    })
    const outcome = await chat('r71-u13-e', 'full', 'bash(rm，cwd 在工作区外)')

    expect(outcome.approval.length).toBeGreaterThan(0)
    expect(existsSync(victim)).toBe(true)
    console.log(
      `[r71-u13] 判决：full + bash(cwd 在工作区外) → 弹审批卡；文件仍在=${existsSync(victim)}`
    )
  }, 60_000)

  it('⑦ 档位是唯一变量：ask 工作区里同一条 bash rm -rf（区内）→ 弹卡、树还在', async () => {
    const victimDir = join(workspace, 'ask-tree-to-die')
    mkdirSync(join(victimDir, 'nested'), { recursive: true })
    writeFileSync(join(victimDir, 'nested', 'deep.txt'), 'deep\n', 'utf8')

    push('rmrf-ask', 'bash', { command: `rm -rf "${posix(victimDir)}"` })
    const outcome = await chat('r71-u13-f', 'ask', 'bash(rm -rf，ask 档)')

    expect(outcome.approval.length).toBeGreaterThan(0)
    expect(existsSync(victimDir)).toBe(true)
    console.log(
      `[r71-u13] 判决：ask + bash(rm -rf 区内) → 弹审批卡；整树仍在=${existsSync(victimDir)}`
    )
  }, 60_000)

  it('⑧ 区内的 ask 档 + 已点过「永久允许」(bash × 本工作区)：普通命令与递归删除都免审', async () => {
    const rules: PermissionRule[] = [{ tool: 'bash', workspace, mode: 'allow' }]
    const victimDir = join(workspace, 'rule-tree-to-die')
    mkdirSync(victimDir, { recursive: true })

    // 对照组：规则本身生效（普通命令不再打扰）
    push('rule-plain', 'bash', { command: 'echo hi' })
    const plain = await chat('r71-u13-j', 'ask', 'bash(echo，有规则)', rules)
    expect(plain.approval).toHaveLength(0)
    expect(plain.outputAvailable).toHaveLength(1)

    // round 75：规则覆盖这个工作区里的一切（含 rm -rf）—— 规则绑的就是这条工作区
    push('rule-rmrf', 'bash', { command: `rm -rf "${posix(victimDir)}"` })
    const outcome = await chat('r71-u13-k', 'ask', 'bash(rm -rf，区内，有规则)', rules)

    expect(outcome.approval).toHaveLength(0)
    expect(outcome.errors).toEqual([])
    expect(existsSync(victimDir)).toBe(false)
    console.log(
      `[r71-u13] 判决：ask + 规则(bash×工作区) → 普通命令免审=${plain.approval.length === 0}；` +
        `rm -rf（区内）也免审=${outcome.approval.length === 0}；目录已删=${!existsSync(victimDir)}`
    )
  }, 60_000)

  it('⑨ 边界：授权表 = [工作区:full, outside:ask] 且 bash **不给 cwd** —— 会话根不全 full → 弹卡', async () => {
    const victim = join(workspace, 'boundary-victim.txt')
    writeFileSync(victim, 'b\n', 'utf8')

    // 多工作区又没给 cwd：相对路径没有基准、执行层也会拒（说不清落在哪）→ 保守问
    push('rm-mixed-no-cwd', 'bash', { command: `rm -f "${posix(victim)}"` })
    const outcome = await chat(
      'r71-u13-g',
      [
        { path: workspace, mode: 'full' },
        { path: outside, mode: 'ask' }
      ],
      'bash(rm，无 cwd，混合档)'
    )

    expect(outcome.approval.length).toBeGreaterThan(0)
    expect(existsSync(victim)).toBe(true)
    console.log(`[r71-u13] 判决：混合档 + bash(无 cwd) → 弹审批卡；文件仍在=${existsSync(victim)}`)
  }, 60_000)

  it('⑩ 同上混合档，但 bash 显式给 cwd=full 那个工作区、目标也在区内 —— 免审、真删', async () => {
    const victim = join(workspace, 'boundary-explicit-victim.txt')
    writeFileSync(victim, 'b2\n', 'utf8')

    push('rm-mixed-explicit-cwd', 'bash', {
      cwd: workspace,
      command: `rm -f "${posix(victim)}"`
    })
    const outcome = await chat(
      'r71-u13-h',
      [
        { path: workspace, mode: 'full' },
        { path: outside, mode: 'ask' }
      ],
      'bash(rm，cwd=full，混合档)'
    )

    expect(outcome.approval).toHaveLength(0)
    expect(outcome.errors).toEqual([])
    expect(existsSync(victim)).toBe(false)
    console.log(
      `[r71-u13] 判决：混合档 + bash(cwd=full，目标区内) → 没有审批卡；文件已删=${!existsSync(victim)}`
    )
  }, 60_000)

  it('⑪ 把「工作区之外」也设成完全访问：区外的删除不再问（他设了就照办）', async () => {
    const victim = join(outside, 'outside-tier-victim.txt')
    writeFileSync(victim, 'o\n', 'utf8')

    push('outside-full-rm', 'bash', {
      cwd: workspace,
      command: `rm -f "${posix(victim)}"`
    })
    const outcome = await chat('r71-u13-l', 'full', 'bash(rm 区外，区外档=full)', [], 'full')

    expect(outcome.approval).toHaveLength(0)
    expect(outcome.errors).toEqual([])
    expect(existsSync(victim)).toBe(false)
    console.log(
      `[r71-u13] 判决：full + 区外档=full + bash(rm 区外目标) → 没有审批卡；` +
        `区外文件已删=${!existsSync(victim)}`
    )
  }, 60_000)

  it('⑫ delete 目标在区外：不问（执行层 fail closed）、文件仍在', async () => {
    const victim = join(outside, 'delete-outside-victim.txt')
    writeFileSync(victim, 'd\n', 'utf8')

    push('delete-outside', 'delete', { path: victim })
    const outcome = await chat('r71-u13-m', 'full', 'delete(区外)', [], 'full')

    expect(outcome.approval).toHaveLength(0)
    expect(outcome.errors.join('\n')).toContain('工作区')
    expect(existsSync(victim)).toBe(true)
    console.log(
      `[r71-u13] 判决：full + delete(区外) → 没有审批卡（批了也不会执行）；` +
        `文件仍在=${existsSync(victim)}；error=${JSON.stringify(outcome.errors)}`
    )
  }, 60_000)
})
