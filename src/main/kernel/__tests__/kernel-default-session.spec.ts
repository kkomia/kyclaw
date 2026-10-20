// @vitest-environment node
/**
 * PB-051 聚焦单测（不起内核）：默认会话的**稳定 id** 与「启动先 list、已存在不 create」判定。
 *
 * 这条链的证据面：
 *   - 旧行为（红）：`kernel-adapter` 启动 `createSession()` 不带 id → 内核每次 mint 新
 *     `session-<uuid>` → 每次启动 +1 个 blank 会话（真内核探针实证，见
 *     `.superpowers/dev-verify/20261020-0.2.1/blank-session-fix/`）；
 *   - 新行为（绿）：id 跨重启稳定 + list-first → 第 2 次起启动序列里**没有额外 createSession**。
 * 真进程的现场目录断言在 `pb051-no-new-blank-session.integration.spec.ts`（KYCLAW_KERNEL_E2E=1）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_ID_PREFIX,
  decideDefaultSession,
  defaultSessionIdForCwd,
  normalizeCwdForDefaultSessionId,
  resolveDefaultSessionId
} from '../kernel-default-session'

const ID_SHAPE = /^kyclaw-default-[0-9a-f]{16}$/u

describe('PB-051 默认会话稳定 id', () => {
  it('形状：前缀 + 16 hex，且同一 cwd 反复算稳定', () => {
    const cwd = 'C:\\Users\\someone\\kyclaw\\work'
    const first = defaultSessionIdForCwd(cwd)
    expect(first).toMatch(ID_SHAPE)
    expect(first.startsWith(DEFAULT_SESSION_ID_PREFIX)).toBe(true)
    expect(defaultSessionIdForCwd(cwd)).toBe(first)
  })

  it('写法归一：斜杠方向/重复斜杠/尾斜杠/首尾空白算同一个 id', () => {
    const canonical = defaultSessionIdForCwd('C:/Users/someone/work')
    expect(defaultSessionIdForCwd('C:\\Users\\someone\\work')).toBe(canonical)
    expect(defaultSessionIdForCwd('C:\\\\Users\\\\someone\\\\work')).toBe(canonical)
    expect(defaultSessionIdForCwd('C:/Users/someone/work/')).toBe(canonical)
    expect(defaultSessionIdForCwd('  C:/Users/someone/work  ')).toBe(canonical)
  })

  it('Windows 路径大小写不敏感（同一工作区不因盘符/目录大小写变 id）', () => {
    const lower = defaultSessionIdForCwd('c:/users/someone/work')
    expect(normalizeCwdForDefaultSessionId('C:/Users/Someone/Work')).toBe(
      normalizeCwdForDefaultSessionId('c:/users/someone/work')
    )
    expect(defaultSessionIdForCwd('C:/Users/Someone/Work')).toBe(lower)
  })

  it('不同 cwd（不同工作区）id 不同 —— 换工作区不落到别人的默认会话上', () => {
    expect(defaultSessionIdForCwd('C:/ws/a')).not.toBe(defaultSessionIdForCwd('C:/ws/b'))
  })
})

describe('PB-051 decideDefaultSession：list 里已有就复用', () => {
  const desired = 'kyclaw-default-0123456789abcdef'

  it('已存在 → create=false（只 follow，零写盘）', () => {
    expect(decideDefaultSession(desired, ['thread-a', desired])).toEqual({
      sessionId: desired,
      create: false
    })
  })

  it('不存在 → create=true', () => {
    expect(decideDefaultSession(desired, ['thread-a'])).toEqual({
      sessionId: desired,
      create: true
    })
    expect(decideDefaultSession(desired, [])).toEqual({ sessionId: desired, create: true })
  })

  it('list 里的脏值（undefined/空串）不会被误判成"已存在"', () => {
    expect(decideDefaultSession(desired, [undefined, '', desired]).create).toBe(false)
    expect(decideDefaultSession(desired, [undefined, '']).create).toBe(true)
  })
})

describe('PB-051 resolveDefaultSessionId：模拟启动序列不产生额外 createSession', () => {
  /** 假内核：listSessionIds / createSession 都记调用次数，模拟"持久化在磁盘上的会话" */
  function fakeKernel(initial: ReadonlyArray<string> = []): {
    deps: {
      listSessionIds: () => Promise<ReadonlyArray<string | undefined>>
      createSession: (sessionId: string) => Promise<string>
    }
    stored: Set<string>
    creates: string[]
    lists: number
    failList: (error: Error) => void
  } {
    let listError: Error | undefined
    const kernel = {
      stored: new Set<string>(initial),
      creates: [] as string[],
      lists: 0,
      failList: (error: Error): void => {
        listError = error
      },
      deps: {
        listSessionIds: async (): Promise<ReadonlyArray<string | undefined>> => {
          kernel.lists += 1
          if (listError !== undefined) throw listError
          return [...kernel.stored]
        },
        createSession: async (sessionId: string): Promise<string> => {
          kernel.creates.push(sessionId)
          kernel.stored.add(sessionId)
          return sessionId
        }
      }
    }
    return kernel
  }

  it('第 1 次启动 create 1 个；第 2/3 次启动**不再 create**、id 不变（旧代码每次启动 +1 的红点）', async () => {
    const kernel = fakeKernel()
    const cwd = 'C:/Users/someone/work'

    const first = await resolveDefaultSessionId(cwd, kernel.deps)
    expect(kernel.creates).toEqual([first])
    expect(first).toMatch(ID_SHAPE)

    const second = await resolveDefaultSessionId(cwd, kernel.deps)
    const third = await resolveDefaultSessionId(cwd, kernel.deps)
    expect(second).toBe(first)
    expect(third).toBe(first)
    // 三次启动序列里只 create 过一次 —— 每次启动不再新增空会话
    expect(kernel.creates).toHaveLength(1)
    expect(kernel.lists).toBe(3)
  })

  it('别的会话存在也不会被当成默认会话；默认会话缺失时仍会 create 一次', async () => {
    const kernel = fakeKernel(['thread-a', 'kyclaw-pending'])
    const id = await resolveDefaultSessionId('C:/ws/x', kernel.deps)
    expect(id).toMatch(ID_SHAPE)
    expect(kernel.creates).toEqual([id])
  })

  it('session/list 读失败 → 退回 create(稳定 id)（内核复用已存 blank；不静默造第二个 id）', async () => {
    const kernel = fakeKernel()
    kernel.failList(new Error('kernel rpc: session/list failed (gateway/internal): boom'))
    const id = await resolveDefaultSessionId('C:/ws/y', kernel.deps)
    expect(id).toMatch(ID_SHAPE)
    expect(kernel.creates).toEqual([id])
  })

  it('create 返回内核 mint 的另一个 id → 以内核为准返回（不把内核会话错记成期望 id）', async () => {
    const kernel = fakeKernel()
    kernel.deps.createSession = async (sessionId: string) => {
      kernel.creates.push(sessionId)
      return 'session-minted-by-kernel'
    }
    await expect(resolveDefaultSessionId('C:/ws/z', kernel.deps)).resolves.toBe(
      'session-minted-by-kernel'
    )
  })
})
