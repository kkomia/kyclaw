import { describe, expect, it, vi } from 'vitest'
import type { TaskSnapshot, TodoOutput } from '@shared/tasks'
import { createTasksStore, EMPTY_TASK_SESSION, taskSession, type TasksStore } from '../tasks-store'
import type { TasksApi } from '../tasks-api'

const time = '2026-10-14T00:00:00.000Z'
function snapshot(revision = 1): TaskSnapshot {
  return {
    revision,
    updatedAt: time,
    items: [{ id: 'a', title: '任务', status: 'pending', createdAt: time, updatedAt: time }]
  }
}
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(): { api: TasksApi; store: TasksStore } {
  const api: TasksApi = {
    get: vi.fn().mockResolvedValue(snapshot()),
    put: vi.fn().mockResolvedValue({ status: 'ok', snapshot: snapshot(2) })
  }
  return { api, store: createTasksStore(api) }
}

describe('任务状态隔离和并发', () => {
  it('不同会话乱序响应独立存储，同会话只接最后请求', async () => {
    const { store, api } = fixture()
    const a = deferred<TaskSnapshot>(),
      b = deferred<TaskSnapshot>(),
      newer = deferred<TaskSnapshot>()
    vi.mocked(api.get)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(newer.promise)
    const oldLoad = store.getState().load('a')
    const bLoad = store.getState().load('b')
    const newLoad = store.getState().load('a')
    b.resolve(snapshot(7))
    await bLoad
    newer.resolve(snapshot(9))
    await newLoad
    a.resolve(snapshot(1))
    await oldLoad
    expect(taskSession(store.getState(), 'a').snapshot?.revision).toBe(9)
    expect(taskSession(store.getState(), 'b').snapshot?.revision).toBe(7)
  })

  it('删除缓存使在途读写失效，即使同 id 重新加载也不复活旧响应', async () => {
    const { store, api } = fixture()
    await store.getState().load('a')
    const write = deferred<TodoOutput>()
    vi.mocked(api.put).mockReturnValueOnce(write.promise)
    const pending = store.getState().clear('a')
    store.getState().forget('a')
    vi.mocked(api.get).mockResolvedValueOnce(snapshot(8))
    await store.getState().load('a')
    write.resolve({ status: 'ok', snapshot: snapshot(2) })
    expect(await pending).toBe('ignored')
    expect(taskSession(store.getState(), 'a').snapshot?.revision).toBe(8)
  })

  it('409 加载最新快照并显示冲突，只发送一次，不自动覆盖', async () => {
    const { store, api } = fixture()
    await store.getState().load('a')
    vi.mocked(api.put).mockResolvedValueOnce({ status: 'conflict', snapshot: snapshot(5) })
    expect(await store.getState().setStatus('a', 'a', 'done')).toBe('conflict')
    expect(api.put).toHaveBeenCalledWith('a', {
      action: 'update',
      expectedRevision: 1,
      changes: [{ id: 'a', status: 'done' }]
    })
    expect(api.put).toHaveBeenCalledTimes(1)
    expect(taskSession(store.getState(), 'a')).toMatchObject({
      snapshot: snapshot(5),
      saving: false,
      conflict: expect.stringContaining('本次修改未保存')
    })
    expect(taskSession(store.getState(), 'a').snapshot?.items[0].status).toBe('pending')
  })

  it('写入阻止重复提交和并行刷新，明确清空不伪造全部完成', async () => {
    const { store, api } = fixture()
    await store.getState().load('a')
    const pending = deferred<TodoOutput>()
    vi.mocked(api.put).mockReturnValueOnce(pending.promise)
    const saving = store.getState().clear('a')
    expect(await store.getState().clear('a')).toBe('ignored')
    await store.getState().load('a')
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.put).toHaveBeenCalledWith('a', { action: 'replace', expectedRevision: 1, items: [] })
    pending.resolve({ status: 'ok', snapshot: { revision: 2, items: [], updatedAt: time } })
    await saving
    expect(taskSession(store.getState(), 'a').snapshot?.items).toEqual([])
  })

  it('blocked 无原因、第二个进行中和过长原因都不发请求', async () => {
    const { store, api } = fixture()
    const data = snapshot()
    data.items.push({ ...data.items[0], id: 'b', status: 'in_progress' })
    vi.mocked(api.get).mockResolvedValueOnce(data)
    await store.getState().load('a')
    expect(await store.getState().setStatus('a', 'a', 'blocked', ' ')).toBe('error')
    expect(await store.getState().setStatus('a', 'a', 'blocked', 'x'.repeat(1001))).toBe('error')
    expect(await store.getState().setStatus('a', 'a', 'in_progress')).toBe('error')
    expect(api.put).not.toHaveBeenCalled()
    await store.getState().setStatus('a', 'a', 'blocked', '等待反馈')
    expect(api.put).toHaveBeenCalledWith('a', {
      action: 'update',
      expectedRevision: 1,
      changes: [{ id: 'a', status: 'blocked', note: '等待反馈' }]
    })
  })

  it('加载和写入错误可见，刷新不回退已知版本，折叠隔离', async () => {
    const { store, api } = fixture()
    vi.mocked(api.get).mockRejectedValueOnce(new Error('private token detail'))
    await store.getState().load('a')
    expect(taskSession(store.getState(), 'a').error).toBe('任务加载失败，请重试')
    vi.mocked(api.get).mockResolvedValueOnce(snapshot(6))
    await store.getState().load('a')
    await store.getState().load('a')
    expect(taskSession(store.getState(), 'a').snapshot?.revision).toBe(6)
    vi.mocked(api.put).mockRejectedValueOnce(new Error('private detail'))
    expect(await store.getState().clear('a')).toBe('error')
    expect(taskSession(store.getState(), 'a').error).toContain('未确认保存')
    store.getState().setCollapsed('a', true)
    expect(taskSession(store.getState(), 'a').collapsed).toBe(true)
    // 折叠隔离：改 'a' 不带动 'b'（b 还停在默认档 —— round 81 起默认是收起）
    expect(taskSession(store.getState(), 'b').collapsed).toBe(EMPTY_TASK_SESSION.collapsed)
    expect(EMPTY_TASK_SESSION.collapsed).toBe(true)
  })
})
