/**
 * 审批 part 的读取与记忆（T13）。
 *
 * 五个纯函数 + 一份模块级内存：
 *   1. `approvalRequestOf` / `pendingApprovals` / `hasPendingApproval`：从 AI SDK 的 tool part
 *      里认出"正在等审批"的调用（`state='approval-requested'` + `approval.id`）。
 *      round 75：里面就把 MCP 元工具（`mcp__<serverId>__meta`）的 `call` 解包成**真名与真入参**
 *      （见 `@shared/mcp` 的 resolveMcpToolCallName / resolveMcpToolCallInput）—— 服务端闸门按真名
 *      判，渲染端按真名记，两边的粒度才是同一个（审批记忆、永久规则都吃这里的 toolName）；
 *   2. `resolveApprovalWorkspace`：按渲染端那份设置判这次调用落在哪个工作区 —— 只用于
 *      审批记忆的粒度（工具 + 工作区）与"永久允许"写哪条规则，**不是安全边界**（边界在
 *      服务端 guard：路径只认引擎归一后的 abs）。round28：目标字段按工具身份取
 *      （bash=cwd、fetch=save_to、其余=path，与服务端 guard 的能力类口径一致）；能力类工具
 *      没给显式目标时只有授权列表恰好一条才绑得上（多工作区判不出 → 不给记忆入口，保守方向）；
 *   3. `approvalDetailOf`：审批卡上"这次在批什么"的正文（bash 命令 / fetch URL / move 目标）；
 *   4. `approvalScopeNote`（round 75）：审批卡上"**为什么问你**"的那一行 —— 服务端按"目标落在哪个
 *      区"判（见 `mastra/tools/guard.ts` 的 needsApproval），这里用同一把尺复算一遍说清范围：
 *      区外的目标说"按「工作区之外」那一档"，区内的说"这个文件夹现在是「每次询问」档"；
 *   5. 会话记忆（"本会话允许"）：模块级 Set，应用退出即清空；粒度 = **对话（thread）+ 工具 + 工作区**。
 *
 * 工作区判定与工具名归一都走 shared/permissions 的同一把尺，和服务端的规则匹配保持一致。
 */
import type { Workspace, WorkspaceMode } from '@shared/settings'
import { normalizeToolName, normalizeWorkspacePath, toolBasename } from '@shared/permissions'
import { resolveMcpToolCallInput, resolveMcpToolCallName } from '@shared/mcp'
import { assessCommandRisk, type CommandRisk, type ZoneOf } from '@shared/command-risk'

/** 一次待审批的工具调用（从 tool part 里抽出来的最小信息） */
export interface ApprovalRequest {
  /** 服务端给的审批 id（T11 口径：`runId::toolCallId`）；回灌时原样交回 */
  approvalId: string
  toolCallId: string
  /**
   * 工具名：MCP 元工具（`mcp__<serverId>__meta`）的 `call` **已经解包**成被调用的真名
   * `mcp__<server>__<tool>`（round 75）—— 审批记忆、永久规则、卡片标题都按它认。
   */
  toolName: string
  /**
   * 入参：与 toolName 配套，元工具调用给的是**真入参**（`call.args`）—— 卡片的目标 / 正文 /
   * 红线复算都看它，元工具那层壳对用户是透明的。
   */
  input: unknown
  /**
   * 入参里的目标（展示用）：path 优先，没有就依次看 cwd（bash）、save_to（fetch）；
   * 都没有就是 null。工作区判定另走 resolveApprovalWorkspace（按工具身份取字段）。
   */
  path: string | null
}

/** 结构化读 part：只认必要的几个字段，避免把 AI SDK 的宽泛类型带进来 */
type PartLike = {
  type?: unknown
  toolCallId?: unknown
  toolName?: unknown
  state?: unknown
  input?: unknown
  approval?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 入参里的"目标"（卡片展示 + 审批记忆判定共用；模型给的是原始串，可能是绝对路径也可能是
 * 相对工作区的相对路径）：
 *   - 没给工具名（展示兜底）：`path → cwd → save_to` 依次取第一个非空字符串；
 *   - 给了工具名：按服务端 guard.needsApproval 的能力类口径**只认该工具的字段** ——
 *     bash=cwd、fetch=save_to、其余（含 git / 内置文件工具 / MCP）=path。字段拿不准就不猜：
 *     猜出来的目标会造出一条服务端永不生效的"永久允许"规则（round28）。
 */
export function approvalPath(input: unknown, toolName?: string): string | null {
  if (!isRecord(input)) return null
  const capability = toolName === undefined ? null : capabilityToolOf(toolName)
  const keys: readonly string[] =
    toolName === undefined
      ? ['path', 'cwd', 'save_to']
      : capability === 'shell'
        ? ['cwd']
        : capability === 'network'
          ? ['save_to']
          : ['path']
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/**
 * 能力类工具（整名；镜像 `src/mastra/tools/guard.ts` 的头注"目标抽取" —— 渲染端不引主进程
 * 代码，两处口径必须一起改）：bash 的显式目标是 cwd、fetch 是 save_to、git_add/commit 是 path。
 */
export type ApprovalCapability = 'shell' | 'network' | 'git'

export function capabilityToolOf(toolName: string): ApprovalCapability | null {
  switch (normalizeToolName(toolName)) {
    case 'bash':
      return 'shell'
    case 'fetch':
      return 'network'
    case 'git_add':
    case 'git_commit':
      return 'git'
    default:
      return null
  }
}

/**
 * 危险档（delete/move；`mcp__x__delete` 这类末段命中的也算 —— 与 main/permission/classify
 * 同一口径）。**round 76 起没有人再用它当闸**：用户口径"允许就是永久允许" —— 审批卡上
 * delete / move 与其它写类同一套入口，"本会话允许 / 永久允许"照给（规则粒度同样是
 * (工具 × 工作区)，服务端 gate 一直吃它）。保留这个分类镜像，是因为"这两样是破坏性的"仍是
 * 一个有意义的事实（将来要给破坏性操作加提示/二次确认，尺子已经在这）；生产代码里不再引用。
 */
const DANGEROUS_BASENAMES = new Set(['delete', 'move'])

export function isDangerousTool(toolName: string): boolean {
  return DANGEROUS_BASENAMES.has(toolBasename(toolName))
}

/** 审批卡上"这次在批什么"的正文（diff 之外的多行信息） */
export interface ApprovalDetail {
  kind: 'command' | 'url' | 'move-to'
  text: string
}

/**
 * 这次调用的目标是不是"落在授权工作区之外"（round 71 起；round 75 改了含义）。
 *
 * 服务端的判定在 `mastra/tools/guard.ts` 的 `zoneOfCall`（抽取实现 `shared/command-risk.ts`）；
 * 渲染端拿同一份抽取**现算一遍**，卡片才能说清"为什么问"。不是安全边界 —— 真判定在主进程；
 * 这里判错顶多是提示少一行/多一行，不会放行任何东西。
 *
 * round 75 起它只回答一件事：**这个命令里有工作区之外的目标（或形态落不到工作区里）** ——
 * 服务端据此走"区外档"（默认每次询问）。"递归删除"之类与目标无关的形态**不再**在这里命中
 * （`full` 就是真免审：区内的 `rm -rf` 不问）。
 *
 * 与主进程唯一的差异是 `ZoneOf`：主进程走路径引擎（realpath，防链接逃逸），这里只做词法前缀
 * 比较；相对路径看不出会话根的实时基准，只在明显往上爬（`..`）时按"工作区外"报（宁松不误报）。
 */
export function approvalRiskOf(
  input: unknown,
  workspaces: readonly Workspace[]
): CommandRisk | null {
  if (!isRecord(input)) return null
  const command = input.command
  if (typeof command !== 'string' || command.trim() === '') return null
  return assessCommandRisk(command, approvalPathZone(workspaces))
}

function approvalPathZone(workspaces: readonly Workspace[]): ZoneOf {
  return (raw) => {
    const token = raw.trim()
    // `~` / `$VAR` / `%VAR%`：展开成什么在渲染端证明不了 —— 与主进程同口径，按"外"
    if (token === '' || /^[~$%]/.test(token)) return 'outside'
    if (isRelativePath(token)) {
      return token.split(/[\\/]/).includes('..') ? 'outside' : 'inside'
    }
    const normalized = normalizeWorkspacePath(token)
    for (const workspace of workspaces) {
      const root = normalizeWorkspacePath(workspace.path)
      if (root === '') continue
      if (normalized === root || normalized.startsWith(`${root}/`)) return 'inside'
    }
    return 'outside'
  }
}

/**
 * 认得出就回展示正文：bash → 要执行的命令；fetch → 请求的 URL；move → 目标位置。
 * 只认整名（`mcp__x__bash` 不算我们的 bash）；认不出回 null（卡片退回"只看 path"）。
 */
export function approvalDetailOf(toolName: string, input: unknown): ApprovalDetail | null {
  if (!isRecord(input)) return null
  const name = normalizeToolName(toolName)
  if (name === 'bash' && typeof input.command === 'string' && input.command !== '') {
    return { kind: 'command', text: input.command }
  }
  if (name === 'fetch' && typeof input.url === 'string' && input.url !== '') {
    return { kind: 'url', text: input.url }
  }
  if (name === 'move' && typeof input.to === 'string' && input.to !== '') {
    return { kind: 'move-to', text: input.to }
  }
  return null
}

/** part → 待审批请求；不是"正在等审批"就回 null（已回应/执行完成都不算） */
export function approvalRequestOf(part: unknown): ApprovalRequest | null {
  if (!isRecord(part)) return null
  const candidate = part as PartLike
  if (candidate.state !== 'approval-requested') return null
  if (typeof candidate.approval !== 'object' || candidate.approval === null) return null

  const approval = candidate.approval as { id?: unknown; approved?: unknown }
  const approvalId = approval.id
  if (typeof approvalId !== 'string' || approvalId === '') return null
  // 带 approved 的是"已经回应过"的 part（AI SDK 用同一个 approval 对象表达回应），不算待批
  if (approval.approved !== undefined) return null

  const rawToolName =
    typeof candidate.toolName === 'string' ? candidate.toolName : toolNameFromType(candidate.type)
  const toolCallId = candidate.toolCallId
  if (rawToolName === null || typeof toolCallId !== 'string' || toolCallId === '') return null

  // round 75：MCP 元工具（`mcp__<serverId>__meta`）的 `call` 剥成真名与真入参 —— 服务端闸门本来
  // 就在真名上工作，渲染端不剥的话「本会话允许」的粒度会从"某个工具"塌成"某个 server"
  // （记成 `mcp__x__meta` → 之后这台 server 的任何调用都被自动回灌放行），"永久允许"写下的
  // 规则也永远命中不了真名。不是元工具 / 不是 call → 原样（认不出就不猜）。
  const toolName = resolveMcpToolCallName(rawToolName, candidate.input)
  const input = resolveMcpToolCallInput(rawToolName, candidate.input)

  return {
    approvalId,
    toolCallId,
    toolName,
    input,
    path: approvalPath(input)
  }
}

/** 静态工具 part 的 `tool-<name>` 形态（dynamic-tool 用 part.toolName） */
function toolNameFromType(type: unknown): string | null {
  if (typeof type !== 'string' || !type.startsWith('tool-')) return null
  const name = type.slice('tool-'.length)
  return name === '' ? null : name
}

/** 一条消息里所有"正在等审批"的调用（一条消息可能带多个工具调用） */
export function pendingApprovals(message: { parts?: unknown } | undefined): ApprovalRequest[] {
  const parts = message?.parts
  if (!Array.isArray(parts)) return []
  const requests: ApprovalRequest[] = []
  for (const part of parts) {
    const request = approvalRequestOf(part)
    if (request !== null) requests.push(request)
  }
  return requests
}

/** 这条消息结束时还停在那里等审批（挂起轮：不算"完成轮"，见 thread-chats 的 onFinish） */
export function hasPendingApproval(message: { parts?: unknown } | undefined): boolean {
  return pendingApprovals(message).length > 0
}

/**
 * 审批续跑的就绪判定（替代 AI SDK 的 `lastAssistantMessageIsCompleteWithApprovalResponses`）。
 *
 * 规则与 AI SDK 内置那份对齐（只看**最后一条助手消息**、只从最后一个 `step-start` 切**最后一步**、
 * 要求这一步里**至少一条 approval-responded**），但"每个 part 都已收束"这条按本应用的实际形状放宽：
 *
 *   1. `providerExecuted`：提供方执行的工具，结果不进 UI 消息，客户端本来就不该等它（滤掉）；
 *   2. Mastra 记忆工具（`updateWorkingMemory`）：服务端执行完把结果吞进记忆，UI part 永远
 *      停在 `input-available`（滤掉，T18 复核 concern② 实测）；
 *   3. **`input-available` 的兄弟工具**（round28 定位到的真 bug）：同一步里有工具要审批时，
 *      Mastra 挂起前**只发审批请求**——同一步其它"已经执行完"的工具，结果面不会随挂起流发出来
 *      （wire 实测：`tool-input-available(glob)` 之后直接 `tool-approval-request(bash)`，
 *      没有 `tool-output-available(glob)`）。内置判定要求所有 part 收束，于是恒 false、
 *      批准后永不自动续跑（现场：15:42/15:51 两条会话卡死）。这里把 `input-available`
 *      当作"服务端待续跑补上"的状态放行 —— 本应用没有客户端执行的工具，`input-available`
 *      只可能是"服务端还没补结果"，不会出现"等客户端 addToolOutput"的语义；
 *      `input-streaming` / `approval-requested`（还有没回应的审批）仍然不放行。
 * 滤完没有任何可等待的调用 → false：没有"该续跑的审批"，不替用户往前跑。
 */
const MEMORY_TOOL_NAMES = new Set(['updateWorkingMemory'])

interface ResumePartLike {
  type?: unknown
  state?: unknown
  toolName?: unknown
  providerExecuted?: unknown
  preliminary?: unknown
}

function isToolCallPart(part: { type?: unknown }): boolean {
  if (part.type === 'dynamic-tool') return true
  return typeof part.type === 'string' && part.type.startsWith('tool-')
}

function toolNameOfPart(part: ResumePartLike): string | null {
  if (typeof part.toolName === 'string' && part.toolName !== '') return part.toolName
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
    return part.type.slice('tool-'.length)
  }
  return null
}

export function canResumeAfterApproval(
  messages: ReadonlyArray<{ role?: unknown; parts?: unknown }>
): boolean {
  const message = messages[messages.length - 1]
  if (message === undefined || message.role !== 'assistant') return false
  const parts: ResumePartLike[] = Array.isArray(message.parts)
    ? (message.parts as ResumePartLike[])
    : []

  let lastStepStartIndex = -1
  parts.forEach((part, index) => {
    if (part.type === 'step-start') lastStepStartIndex = index
  })

  const toolParts = parts
    .slice(lastStepStartIndex + 1)
    .filter(isToolCallPart)
    .filter((part) => part.providerExecuted !== true)
    .filter((part) => {
      const name = toolNameOfPart(part)
      return name === null || !MEMORY_TOOL_NAMES.has(name)
    })
  if (toolParts.length === 0) return false

  const hasResponded = toolParts.some((part) => part.state === 'approval-responded')
  if (!hasResponded) return false

  return toolParts.every(
    (part) =>
      // input-available：挂起时兄弟工具的结果面没发出来（见上面头注第 3 条）——
      // 续跑那轮服务端会把结果补上；本应用没有客户端工具，不会有"等客户端输出"的语义
      part.state === 'input-available' ||
      (part.state === 'output-available' && part.preliminary !== true) ||
      part.state === 'output-error' ||
      part.state === 'output-denied' ||
      part.state === 'approval-responded'
  )
}

/**
 * 审批卡上"为什么这次要问你"的那一行（round 75）。服务端按"目标落在哪个区"判审批（见
 * `mastra/tools/guard.ts` 的 needsApproval），这里用同一把尺**复算一遍**，把"作用范围"写在卡上 ——
 * 用户看不到"为什么这个删了没问、那个问了"就必须靠这句话说清。
 *
 * 两种来源：
 *   - **区外**（`approvalRiskOf` 命中：目标在工作区之外，或命令形态本身落不到工作区里）→
 *     把那句话 + "工作区之外那一档现在是什么"一起说；
 *   - **区内的 ask 档**（目标确实在这个文件夹里，只是这一档是「每次询问」）→ 点名是哪个文件夹、
 *     以及去哪儿改成「完全访问」。
 * 判不出（工作区绑不上 / 那一档本来就是 full）→ null：宁可不解释，也不说一句可能不成立的话。
 *
 * 不是安全边界（真判定在主进程），判错顶多提示少一行/多一行。
 */
export function approvalScopeNote(
  input: unknown,
  toolName: string,
  workspaces: readonly Workspace[],
  outsideMode: WorkspaceMode
): string | null {
  const risk = approvalRiskOf(input, workspaces)
  if (risk !== null) {
    const tier = outsideMode === 'full' ? '「完全访问」' : '「每次询问」'
    return `${risk.reason}工作区之外的操作按「工作区之外」那一档判定（现在是${tier}，可在「设置 → 工作区」里改）。`
  }

  const path = resolveApprovalWorkspace(input, workspaces, toolName)
  if (path === null) return null
  const workspace = workspaces.find(
    (candidate) => normalizeWorkspacePath(candidate.path) === normalizeWorkspacePath(path)
  )
  if (workspace === undefined || workspace.mode !== 'ask') return null
  return (
    `「${workspace.path}」这一档是「每次询问」：里面的写、删、移都会先问你` +
    '（在「设置 → 工作区」里可以改成「完全访问」）。'
  )
}

/**
 * 这次调用落在哪个工作区（渲染端口径，用于审批记忆粒度）：
 *   - 目标字段按工具身份取（见 approvalPath）；绝对路径按前缀找包含它的工作区，相对路径
 *     归**第一个工作区** —— 与服务的 resolveTarget 同一顺序（相对路径在任何工作区根下都能解出，
 *     服务端也是按列表顺序取第一个）；
 *   - 能力类工具（bash/fetch/git_add/commit）没给显式目标：执行层的根 = 会话根，审批层拿不到
 *     会话 —— 只有授权列表**恰好一条**才绑得上（与服务端 guard 的"无目标"那一档同口径）；
 *     多工作区判不出 → null（不给记忆入口，保守方向）；
 *   - 判不出（没有目标 / 没有工作区）回 null。
 */
export function resolveApprovalWorkspace(
  input: unknown,
  workspaces: readonly Workspace[],
  toolName?: string
): string | null {
  const path = approvalPath(input, toolName)
  if (path === null) {
    const capability = toolName === undefined ? null : capabilityToolOf(toolName)
    if (capability !== null && workspaces.length === 1) return workspaces[0].path
    return null
  }
  if (workspaces.length === 0) return null

  const relative = isRelativePath(path)
  if (relative) return workspaces[0].path

  const normalized = normalizeWorkspacePath(path)
  for (const workspace of workspaces) {
    const root = normalizeWorkspacePath(workspace.path)
    if (root === '') continue
    if (normalized === root || normalized.startsWith(`${root}/`)) return workspace.path
  }
  return null
}

/** 盘符（C:\ / C:/）或 POSIX 根开头的都算绝对路径；其余（含 `..\x`）按相对处理 */
function isRelativePath(path: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  return true
}

/**
 * 会话记忆（"本会话允许"）：粒度 = **对话（thread）+ 工具 + 工作区**。
 * "会话"取 UI 里那个词义（侧栏的会话 = 一个聊天线程，threadId）：用户在某个对话里说
 * "本会话允许"，就只对那个对话里的同类调用不再打扰；换个对话照旧问。
 * 只活在当前渲染进程里（重启应用即清空），不落盘、不过桥 —— 这是"这次先放过它"的语义。
 * 记忆入口只在工作区明确、且目标没踩区外时才给（放行范围说不清的不给）。round 76 起对
 * delete / move 与其它工具一视同仁（用户口径：允许就是永久允许）—— 粒度同样是
 * (对话 × 工具 × 工作区)。
 */
const sessionAllowed = new Set<string>()

function sessionKey(threadId: string, tool: string, workspace: string): string {
  return `${threadId}\u0000${normalizeToolName(tool)}\u0000${normalizeWorkspacePath(workspace)}`
}

/** 记下"本会话允许"（用户在审批卡上点的那一下） */
export function allowForSession(threadId: string, tool: string, workspace: string): void {
  sessionAllowed.add(sessionKey(threadId, tool, workspace))
}

/** 这个对话里、这个工具在这个工作区是否已被放行（命中就自动批准，不再打扰用户） */
export function isAllowedForSession(threadId: string, tool: string, workspace: string): boolean {
  return sessionAllowed.has(sessionKey(threadId, tool, workspace))
}

/**
 * 会话记忆这次到底算不算数（round 71；round 75 跟着新口径收窄）：**区外的目标不吃"本会话允许"**。
 *
 * 为什么：`isAllowedForSession` 的粒度是 (对话 × 工具 × 工作区)，与服务端那条"永久允许"规则同一
 * 粒度 —— 用户在**普通** bash 卡上点过一次"本会话允许"（如 ask 工作区里跑 `pnpm test`），
 * 这条记忆就会把同一个对话里**之后任意** bash 调用直接回灌放行，包括工作区外的破坏性目标
 * （ChatPage 的 dock 把它藏起来、并自动 `approved: true`）。区外那一档（默认每次询问）是用户
 * 对"这台机器上其它地方"的显式选择，不该被某一次"这个文件夹里放行"的点头静默盖过 ——
 * 所以这里按同一把尺再挡一次（服务端那道判定照旧在，两边都不放行才算真不放行）。
 */
export function isAllowedForSessionNow(
  threadId: string,
  request: ApprovalRequest,
  workspace: string | null,
  workspaces: readonly Workspace[]
): boolean {
  if (workspace === null) return false
  if (approvalRiskOf(request.input, workspaces) !== null) return false
  return isAllowedForSession(threadId, request.toolName, workspace)
}

/** 测试用：清空会话记忆（模块级状态不随 render 重置） */
export function resetSessionApprovals(): void {
  sessionAllowed.clear()
}
