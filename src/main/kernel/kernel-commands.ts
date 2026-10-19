/**
 * B3.3 / PB-005-F2：内核命令平面的**本地诊断层**（纯函数 + 结果形状，不碰 RPC）。
 *
 * 为什么需要：内核 `commands/execute` 对**未识别**的行**静默丢弃**——返回 `undefined`，
 * 不产生 `command/run`/`command/done` 事件（Eve 实测：`/eve-nope-command` → `undefined`）。
 * 上层（renderer 结果卡）于是既没结果也没错误，用户以为命令执行了。
 *
 * 口径：
 * - **内核仍是权威**：这里只在能拿到 `commands/list` 时做"这行有没有对应命令"的校验；
 *   校验不通过时不发 RPC，直接合成一个**与内核同形**的失败结果 `{commandId, result:{kind:'error',text}}`
 *   （对照实测：`/goal edit` 缺参时内核返回的也是 `{commandId, result:{kind:'error',text:'…Usage…'}}`）。
 * - 合成结果的 `commandId` 带 `kyclaw-` 前缀，一眼能和内核自己生成的 `cmd-…` 区分。
 * - 不硬编码命令清单：可用命令一律取当次 `commands/list` 的返回值，内核加命令不用改这里。
 */

/** 内核 `commands/execute` 已知命令的返回形状（rc.2 实测） */
export interface KernelCommandResult {
  commandId: string
  result: { kind: 'success' | 'error'; text: string }
}

export interface KernelCommandInfo {
  name: string
  description?: string
}

/** 从整行命令里取命令名：`/goal pause` → `goal`；` plan off ` → `plan`；空行 → null */
export function commandNameFromLine(line: string): string | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  const body = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  const [name = ''] = body.split(/\s+/u)
  return name === '' ? null : name
}

/** 命令行的**语法**是否合法：内核命令平面只认 `/` 开头的整行（不带 `/` 的 `goal` 不是命令） */
export function isCommandLine(line: string): boolean {
  return line.trim().startsWith('/')
}

/**
 * 未知命令的失败结果（与内核同形，上层按 `result.kind === 'error'` 就能渲染）。
 * `text` 里同时给：原样命令 + 当次可用命令清单（不含 `/` 开头的行单独说清语法）。
 */
export function unknownCommandResult(
  line: string,
  available: readonly KernelCommandInfo[]
): KernelCommandResult {
  const name = commandNameFromLine(line)
  const slashless = !isCommandLine(line) && name !== null
  const head =
    name === null
      ? '未识别的命令（命令行是空的）'
      : slashless
        ? `未识别的命令：${line.trim()}（命令要以 / 开头，例如 /${name}）`
        : `未识别的命令：${line.trim()}`
  const listed = available.map((command) => `/${command.name}`).join('、')
  const tail = listed === '' ? '（当前拿不到命令清单）' : `可用命令：${listed}`
  return {
    commandId: `kyclaw-unknown-${name ?? 'empty'}`,
    result: {
      kind: 'error',
      text: `${head}；${tail}。这一行不会发送到内核，也不会产生模型消息。`
    }
  }
}
