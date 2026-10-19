/**
 * PB-039 `/goal` 解析（纯函数，照抄 DSH `command-goal/lib/index.js:19-35` 的语法）。
 *
 * 口径：
 *   - `/goal` 必须**整行以它开头**（名后是空白或行尾），否则不是 goal 命令（不当命令处理）；
 *   - 控制词 `clear / pause / resume / edit` **只有占满整行参数**才算控制词：
 *     `/goal pause after verification` = 创建字面 objective；`/goal edit`（缺 objective）= 报错不发送；
 *   - `/goal` 无参数 = 查看状态（返回 status）；`/goal <objective>` = create。
 *
 * 输出只描述"要做什么"，不碰网络/UI；调用方负责执行与结果卡片。
 */
export type GoalCommandAction = 'status' | 'create' | 'edit' | 'pause' | 'resume' | 'clear'

export type GoalCommandParse =
  | { kind: 'not-goal' }
  | { kind: 'invalid'; message: string }
  | { kind: 'action'; action: GoalCommandAction; objective?: string }

const USAGE = '用法：/goal [<objective> | clear | edit <objective> | pause | resume]'

/** 是否以 `/goal` 命令名开头（命令名后必须是空白/行尾；`/goalkeeper` 不算） */
export function isGoalCommand(text: string): boolean {
  return /^\/goal(?:\s|$)/.test(text.trimStart())
}

export function parseGoalCommand(text: string): GoalCommandParse {
  const trimmed = text.trim()
  if (!isGoalCommand(trimmed)) return { kind: 'not-goal' }
  const rest = trimmed.slice('/goal'.length).trim()
  if (rest === '') return { kind: 'action', action: 'status' }
  if (rest === 'clear') return { kind: 'action', action: 'clear' }
  if (rest === 'pause') return { kind: 'action', action: 'pause' }
  if (rest === 'resume') return { kind: 'action', action: 'resume' }
  if (rest === 'edit') return { kind: 'invalid', message: `缺少新的目标内容。${USAGE}` }
  if (rest.startsWith('edit ')) {
    const objective = rest.slice('edit '.length).trim()
    if (objective === '') return { kind: 'invalid', message: `缺少新的目标内容。${USAGE}` }
    return { kind: 'action', action: 'edit', objective }
  }
  return { kind: 'action', action: 'create', objective: rest }
}
