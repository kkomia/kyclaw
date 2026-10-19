/**
 * Headless NDJSON 回放（B2 黄金事件夹具的解析/汇总）。
 *
 * 夹具来源：**B1.5 真机 POC 的原始实测输出**（不是手编）：
 * `.superpowers/dev-verify/20261019-0.2.0/bao/poc-kernel-boot.md` 与
 * `C:\lmstudio-temp\dsh-poc\logs\headless-ok-out.log`（2026-10-19，DSH 0.2.1-rc.2 + 本地 stub provider）。
 *
 * 这是将来内核升级的漂移闸门：事件名/字段一变，`headless-replay.spec.ts` 就会红。
 */

export type HeadlessEvent =
  | { type: 'session'; sessionId: string; cwd: string }
  | {
      type: 'status'
      phase: 'turn_start'
      turn: number
    }
  | {
      type: 'status'
      phase: 'step_start'
      turn: number
      step: number
    }
  | {
      type: 'status'
      phase: 'step_end'
      turn: number
      step: number
      usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
    }
  | {
      type: 'status'
      phase: 'turn_end'
      turn: number
      reason?: { kind: string; error?: { message?: string; code?: string } }
    }
  | { type: 'text'; text: string }
  | { type: 'final'; text: string }

export interface HeadlessRunSummary {
  sessionId: string
  cwd: string
  turn: number
  steps: number
  text: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  endKind?: string
  finalText: string
  eventTypes: readonly string[]
}

/** 解析 headless `--json` 的 NDJSON；坏行直接抛（fixture 漂移要显式红） */
export function parseHeadlessNdjson(text: string): HeadlessEvent[] {
  const events: HeadlessEvent[] = []
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(
        `headless NDJSON line ${String(index + 1)} is not JSON: ${line.slice(0, 120)}`
      )
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { type?: unknown }).type !== 'string'
    )
      throw new Error(`headless NDJSON line ${String(index + 1)} has no type`)
    events.push(parsed as HeadlessEvent)
  }
  return events
}

export function summarizeHeadlessRun(events: readonly HeadlessEvent[]): HeadlessRunSummary {
  const summary: HeadlessRunSummary = {
    sessionId: '',
    cwd: '',
    turn: 0,
    steps: 0,
    text: '',
    finalText: '',
    eventTypes: events.map((event) => event.type)
  }
  for (const event of events) {
    if (event.type === 'session') {
      summary.sessionId = event.sessionId
      summary.cwd = event.cwd
      continue
    }
    if (event.type === 'status') {
      if (event.phase === 'turn_start') summary.turn = event.turn
      if (event.phase === 'step_start') summary.steps = Math.max(summary.steps, event.step)
      if (event.phase === 'step_end' && event.usage !== undefined) summary.usage = event.usage
      if (event.phase === 'turn_end') summary.endKind = event.reason?.kind
      continue
    }
    if (event.type === 'text') {
      summary.text += event.text
      continue
    }
    if (event.type === 'final') summary.finalText = event.text
  }
  return summary
}
