/**
 * PB-051：宿主侧「默认内核会话」的稳定身份 —— 每次启动不再多一个 ≤1KB blank session。
 *
 * ## 根因（真内核 rc.2 实测，非推断）
 *
 * `kernel-adapter.ts` 启动时调 `session/create`（**不带 id**），内核每次 mint 一个新的
 * `session-<uuid>` 并落盘一个 header-only `session.v4.jsonl.zstd`（实测 327~350B，`isSeeded:false`）
 * + 一个 `storages/session_projcache/sessions/<id>.json`。也就是说：
 * **不是内核 boot 自己建会话**（干净 `DSH_HOME` 起内核后 `sessions/` 是 0 文件、projcache 0 条），
 * 而是宿主 adapter 的启动路径每次造一个 —— 连续重启 N 次 = 多 N 个空会话（PB-051）。
 * 这个会话 id 就是 `adapter.defaultSessionId`：threads 列表按它过滤（PB-024），PB-030 的 blank
 * 过滤也会过滤它，所以侧栏一直看不见，但磁盘上一直在长。
 *
 * ## 修法
 *
 * 默认会话改成**从 cwd 派生的稳定 id**：启动时先 `session/list`，已存在就只 `session/follow`
 * （真内核实测 follow 零写盘），不存在才 `session/create(稳定 id)`（内核会复用已存的 blank）。
 * 于是：首次启动建 1 个隐藏默认会话；之后每次启动 session 文件数 / 字节数 / projcache 条数都不增。
 *
 * ## 边界（刻意不做的事）
 *
 * - **不删历史空会话**：内核 home 里的持久文件不归宿主擅删，也无法证明旧 blank 会话不是用户
 *   真空会话；侧栏本来就不显示（blank + defaultSessionId 双过滤），交给后续专门的迁移再做。
 * - 不全局固定 id：内核 `session/create` 要求「同一个 id 属于同一个 cwd」，换工作区会
 *   `session/conflict`；按 cwd 派生 = 每个工作区最多 1 个隐藏默认会话，与所在 sessions 目录同源。
 */
import { createHash } from 'node:crypto'

/** 默认会话 id 前缀（便于人眼/日志区分「宿主建的隐藏默认会话」与用户 thread id） */
export const DEFAULT_SESSION_ID_PREFIX = 'kyclaw-default-'

/**
 * cwd 归一化（**只用于算 id**，不改任何持久值、也不改写发给内核的 cwd）：
 * 斜杠统一、折叠重复、去尾斜杠、Windows 大小写不敏感。
 *
 * 不归一化的话 `C:\a\b\` 与 `c:/a/b` 会算出两个 id → 每次启动各建一个，「稳定」就失效了。
 */
export function normalizeCwdForDefaultSessionId(cwd: string): string {
  const unified = cwd
    .trim()
    .replace(/\\/gu, '/')
    .replace(/\/{2,}/gu, '/')
  const trimmed = unified.length > 1 ? unified.replace(/\/+$/u, '') : unified
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * 默认会话 id：`kyclaw-default-<sha256(归一化 cwd) 前 16 位>`。
 * 同一 cwd 跨重启稳定；不同 cwd 不冲突（16 hex = 64bit，workspace 量级碰撞可忽略）。
 */
export function defaultSessionIdForCwd(cwd: string): string {
  const digest = createHash('sha256')
    .update(normalizeCwdForDefaultSessionId(cwd), 'utf8')
    .digest('hex')
  return `${DEFAULT_SESSION_ID_PREFIX}${digest.slice(0, 16)}`
}

/** 启动路径的纯判定结果 */
export interface DefaultSessionDecision {
  sessionId: string
  /** true = 内核里还没有这个会话，需要 `session/create`；false = 已存在，只 follow（零写盘） */
  create: boolean
}

/**
 * 纯判定：期望 id 已在 `session/list` 里就**复用**（不 create），否则 create。
 * 提成纯函数是为了能不起内核单测「第二次启动不再 create」这条序列。
 */
export function decideDefaultSession(
  desiredId: string,
  listedSessionIds: ReadonlyArray<string | undefined>
): DefaultSessionDecision {
  const known = listedSessionIds.some((id) => typeof id === 'string' && id === desiredId)
  return { sessionId: desiredId, create: !known }
}

/** 启动判定所需的内核动作（注入：生产 = adapter 的裸 rpc + createSession；测试 = 假件） */
export interface DefaultSessionDeps {
  /**
   * 内核现有会话 id（`session/list` 的 `items[].sessionId`）。
   * 读失败（内核抖动/超时）由实现方决定：`resolveDefaultSessionId` 会按"没有"兜底。
   */
  listSessionIds: () => Promise<ReadonlyArray<string | undefined>>
  /** 建会话（显式 id；内核在"同名 blank 且同 cwd"时会复用同一个 id 并原样返回） */
  createSession: (sessionId: string) => Promise<string>
}

/**
 * 启动路径唯一入口：**已存在就只回 id**（调用方直接 follow，零写盘），**不存在才 create**。
 *
 * list 失败（内核刚起/抖动）不阻断启动：退回 `createSession(稳定 id)` —— 内核对"已存 blank
 * 同 cwd"会复用同一个 id，最坏情况是 `session/conflict` 上抛（不静默造第二个 id）。
 * create 返回的 id 以**内核为准**（理论上会等于请求的稳定 id；内核若 mint 了别的 id 就用它，
 * 避免把"内核的会话"错记成我们期望的 id）。
 */
export async function resolveDefaultSessionId(
  cwd: string,
  deps: DefaultSessionDeps
): Promise<string> {
  const desired = defaultSessionIdForCwd(cwd)
  const listed = await deps.listSessionIds().catch(() => [] as ReadonlyArray<string | undefined>)
  const decision = decideDefaultSession(desired, listed)
  if (!decision.create) return decision.sessionId
  return deps.createSession(decision.sessionId)
}
