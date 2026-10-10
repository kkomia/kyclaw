import { describe, expect, it } from 'vitest'
import type { ThreadSummary } from '@shared/threads'
import { composeSidebarSessions } from '../sidebar-sessions'

/**
 * 侧栏会话分组（T18）：项目名下 vs 平铺区（今天/更早）。
 * 口径：映射指向已删项目 = 没有项目；草稿排在自己那个桶的最前；排序沿用服务端。
 */
const threads: ThreadSummary[] = [
  { id: 't1', title: '甲', updatedAt: '2026-10-11T10:00:00.000Z' },
  { id: 't2', title: '乙', updatedAt: '2026-10-10T10:00:00.000Z' },
  { id: 't3', title: '丙', updatedAt: '2026-10-09T10:00:00.000Z' }
]

describe('composeSidebarSessions', () => {
  it('按映射分桶：有项目的进 byProject，其余进 ungrouped（顺序照服务端）', () => {
    const result = composeSidebarSessions({
      threads,
      activeId: 't1',
      projectOf: (id) => (id === 't2' ? 'p1' : null),
      projectIds: new Set(['p1'])
    })

    expect(result.byProject['p1']?.map((entry) => entry.id)).toEqual(['t2'])
    expect(result.ungrouped.map((entry) => entry.id)).toEqual(['t1', 't3'])
    expect(result.byProject['p1']?.[0]?.draft).toBeUndefined()
  })

  it('草稿（还没落成线程）按它自己的归属入桶，且排在该桶最前', () => {
    const result = composeSidebarSessions({
      threads,
      activeId: 'draft-1',
      projectOf: (id) => (id === 'draft-1' || id === 't2' ? 'p1' : null),
      projectIds: new Set(['p1'])
    })

    expect(result.byProject['p1']?.map((entry) => entry.id)).toEqual(['draft-1', 't2'])
    expect(result.byProject['p1']?.[0]?.draft).toBe(true)
  })

  it('草稿没有项目：进平铺区最前（与 T9 的行为一致）', () => {
    const result = composeSidebarSessions({
      threads,
      activeId: 'draft-1',
      projectOf: () => null,
      projectIds: new Set()
    })

    expect(result.ungrouped.map((entry) => entry.id)).toEqual(['draft-1', 't1', 't2', 't3'])
  })

  it('映射指向已删项目：当"没有项目"处理（回平铺区）', () => {
    const result = composeSidebarSessions({
      threads,
      activeId: null,
      projectOf: (id) => (id === 't2' ? 'deleted-project' : null),
      projectIds: new Set(['p1'])
    })

    expect(result.byProject).toEqual({})
    expect(result.ungrouped.map((entry) => entry.id)).toEqual(['t1', 't2', 't3'])
  })

  it('activeId 是服务端里已有的会话：不造草稿（列表与别处一致）', () => {
    const result = composeSidebarSessions({
      threads,
      activeId: 't1',
      projectOf: () => null,
      projectIds: new Set()
    })

    expect(result.ungrouped.map((entry) => entry.id)).toEqual(['t1', 't2', 't3'])
    expect(result.ungrouped.every((entry) => entry.draft === undefined)).toBe(true)
  })
})
