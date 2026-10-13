import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetPptTemplatesStore,
  usePptTemplatesStore
} from '@renderer/features/chat/ppt-templates-store'
import { fetchSessionPptTemplates, putSessionPptTemplate } from '@renderer/lib/session-ppt-api'

/**
 * 会话级 PPT 模板选择（round 66）：store 的四件事 —— 载入合并、写入、草稿那一笔、互相不串。
 *
 * 与 projects-store 同一套口径（会话级状态以服务端为准 + 草稿只记本地、物化时补写），
 * 所以这里钉的也是那几条：写入失败要回滚（不把服务端不知道的选择画成已生效）、
 * 快照回来不能把草稿的选择冲掉、草稿期间一个字节都不写服务端。
 */
vi.mock('@renderer/lib/session-ppt-api', () => ({
  fetchSessionPptTemplates: vi.fn(async () => []),
  putSessionPptTemplate: vi.fn(async () => undefined)
}))

beforeEach(() => {
  resetPptTemplatesStore()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('载入：服务端快照是权威', () => {
  it('ensureLoaded 把映射装进 templates；同一份快照里没有的会话 = 没选', async () => {
    vi.mocked(fetchSessionPptTemplates).mockResolvedValueOnce([
      { threadId: 't1', template: '酒红' },
      { threadId: 't2', template: '奶油' }
    ])
    await usePptTemplatesStore.getState().ensureLoaded()

    expect(usePptTemplatesStore.getState().templateOf('t1')).toBe('酒红')
    expect(usePptTemplatesStore.getState().templateOf('t2')).toBe('奶油')
    // 新会话（服务端不认识它）= 没选 —— 用户实报的那条
    expect(usePptTemplatesStore.getState().templateOf('draft-new')).toBe('')
    expect(usePptTemplatesStore.getState().templateOf(null)).toBe('')
  })

  it('载入失败不炸：这轮按"没选"跑，错误落在 error（不影响对话）', async () => {
    vi.mocked(fetchSessionPptTemplates).mockRejectedValueOnce(new Error('服务返回 500'))
    await usePptTemplatesStore.getState().ensureLoaded()

    expect(usePptTemplatesStore.getState().error).toContain('500')
    expect(usePptTemplatesStore.getState().templateOf('t1')).toBe('')
    expect(usePptTemplatesStore.getState().loaded).toBe(true)
  })

  it('refresh 以服务端为准（库里清掉的不留在本地）', async () => {
    vi.mocked(fetchSessionPptTemplates).mockResolvedValueOnce([
      { threadId: 't1', template: '酒红' }
    ])
    await usePptTemplatesStore.getState().ensureLoaded()

    vi.mocked(fetchSessionPptTemplates).mockResolvedValueOnce([])
    await usePptTemplatesStore.getState().refresh()

    expect(usePptTemplatesStore.getState().templateOf('t1')).toBe('')
  })
})

describe('ensureLoaded 的端点复用与重试（本轮）', () => {
  it('给了端点就把它交给取数层（对话页那一屏解析一次、两处共用）', async () => {
    vi.mocked(fetchSessionPptTemplates).mockResolvedValueOnce([])
    const endpoint = { baseUrl: 'http://127.0.0.1:9', token: 'tok-reused' }

    await usePptTemplatesStore.getState().ensureLoaded(endpoint)

    expect(fetchSessionPptTemplates).toHaveBeenCalledWith(endpoint)
  })

  it('失败之后再调会真的再拉一遍（复用了端点也照样可重试）；成功就清掉 error', async () => {
    vi.mocked(fetchSessionPptTemplates).mockRejectedValueOnce(new Error('服务返回 500'))
    await usePptTemplatesStore.getState().ensureLoaded()
    expect(usePptTemplatesStore.getState().error).toContain('500')

    vi.mocked(fetchSessionPptTemplates).mockResolvedValueOnce([
      { threadId: 't1', template: '酒红' }
    ])
    await usePptTemplatesStore.getState().ensureLoaded()

    expect(fetchSessionPptTemplates).toHaveBeenCalledTimes(2)
    expect(usePptTemplatesStore.getState().error).toBeNull()
    expect(usePptTemplatesStore.getState().templateOf('t1')).toBe('酒红')
  })

  it('成功之后就不再多拉（loaded 且无错 = 够了；要强制刷新走 refresh）', async () => {
    vi.mocked(fetchSessionPptTemplates).mockResolvedValueOnce([])

    await usePptTemplatesStore.getState().ensureLoaded()
    await usePptTemplatesStore.getState().ensureLoaded()

    expect(fetchSessionPptTemplates).toHaveBeenCalledTimes(1)
  })

  it('同时触发只拉一次（在飞的 promise 共享）', async () => {
    vi.mocked(fetchSessionPptTemplates).mockResolvedValueOnce([])

    await Promise.all([
      usePptTemplatesStore.getState().ensureLoaded(),
      usePptTemplatesStore.getState().ensureLoaded()
    ])

    expect(fetchSessionPptTemplates).toHaveBeenCalledTimes(1)
  })
})

describe('已有会话：选中即写服务端', () => {
  it('assignTemplate 乐观更新 + PUT 一条', async () => {
    await usePptTemplatesStore.getState().assignTemplate('t1', '湖蓝')

    expect(usePptTemplatesStore.getState().templateOf('t1')).toBe('湖蓝')
    expect(putSessionPptTemplate).toHaveBeenCalledWith('t1', '湖蓝')
  })

  it('写失败：回滚本地视图并落 error（不让界面画出"服务端不知道的选择"）', async () => {
    vi.mocked(fetchSessionPptTemplates).mockResolvedValueOnce([
      { threadId: 't1', template: '酒红' }
    ])
    await usePptTemplatesStore.getState().ensureLoaded()
    vi.mocked(putSessionPptTemplate).mockRejectedValueOnce(new Error('映射服务返回 500'))

    await usePptTemplatesStore.getState().assignTemplate('t1', '奶油')

    expect(usePptTemplatesStore.getState().templateOf('t1')).toBe('酒红')
    expect(usePptTemplatesStore.getState().error).toContain('500')
  })

  it('清回自动：写空串（服务端删掉那一行），本地也不再留', async () => {
    await usePptTemplatesStore.getState().assignTemplate('t1', '酒红')
    await usePptTemplatesStore.getState().assignTemplate('t1', '')

    expect(usePptTemplatesStore.getState().templateOf('t1')).toBe('')
    expect(putSessionPptTemplate).toHaveBeenLastCalledWith('t1', '')
  })
})

describe('草稿：只记本地，物化那一刻补写', () => {
  it('rememberDraft 只动本地（PUT 一个字节都不写）', async () => {
    usePptTemplatesStore.getState().rememberDraft('draft-1', '墨绿')

    expect(usePptTemplatesStore.getState().templateOf('draft-1')).toBe('墨绿')
    expect(putSessionPptTemplate).not.toHaveBeenCalled()
  })

  it('服务端快照回来的那一刻，草稿那一笔不被冲掉', async () => {
    usePptTemplatesStore.getState().rememberDraft('draft-1', '墨绿')

    vi.mocked(fetchSessionPptTemplates).mockResolvedValueOnce([
      { threadId: 't1', template: '酒红' }
    ])
    await usePptTemplatesStore.getState().refresh()

    expect(usePptTemplatesStore.getState().templateOf('draft-1')).toBe('墨绿')
    expect(usePptTemplatesStore.getState().templateOf('t1')).toBe('酒红')
  })

  it('flushDraft：物化完成补写一条，且只写一次（取走即不再留）', async () => {
    usePptTemplatesStore.getState().rememberDraft('draft-1', '墨绿')

    await usePptTemplatesStore.getState().flushDraft('draft-1')
    await usePptTemplatesStore.getState().flushDraft('draft-1')

    expect(putSessionPptTemplate).toHaveBeenCalledTimes(1)
    expect(putSessionPptTemplate).toHaveBeenCalledWith('draft-1', '墨绿')
    // 本地那份留着（显示口径不变）
    expect(usePptTemplatesStore.getState().templateOf('draft-1')).toBe('墨绿')
  })

  it('flushDraft：没记过的草稿 = 空操作（不凭空记账）', async () => {
    await usePptTemplatesStore.getState().flushDraft('draft-never-touched')

    expect(putSessionPptTemplate).not.toHaveBeenCalled()
  })

  it('flushDraft 失败：不抛，本地那一笔留着、记 error（服务端这轮拿不到它）', async () => {
    usePptTemplatesStore.getState().rememberDraft('draft-1', '墨绿')
    vi.mocked(putSessionPptTemplate).mockRejectedValueOnce(new Error('映射服务返回 500'))

    await expect(usePptTemplatesStore.getState().flushDraft('draft-1')).resolves.toBeUndefined()

    expect(usePptTemplatesStore.getState().error).toContain('500')
    expect(usePptTemplatesStore.getState().templateOf('draft-1')).toBe('墨绿')
  })
})

describe('两条会话各是各的（不让会话级选择泄漏成全局）', () => {
  it('同一条 store 里并存两条映射；第三条（新会话）没选', async () => {
    usePptTemplatesStore.getState().rememberDraft('draft-a', '酒红')
    await usePptTemplatesStore.getState().assignTemplate('t2', '奶油')

    const state = usePptTemplatesStore.getState()
    expect(state.templateOf('draft-a')).toBe('酒红')
    expect(state.templateOf('t2')).toBe('奶油')
    expect(state.templateOf('t3')).toBe('')
  })
})
