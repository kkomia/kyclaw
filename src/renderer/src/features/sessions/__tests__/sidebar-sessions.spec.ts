import { describe, expect, it } from 'vitest'
import type { ThreadSummary } from '@shared/threads'
import { composeSidebarSessions } from '../sidebar-sessions'

/**
 * 侧栏会话分组（T18）：项目名下 vs 无项目（round 61 起去侧栏的「任务」组）。
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

  it('草稿没有项目：进「任务」组最前（与 T9 的行为一致）', () => {
    const result = composeSidebarSessions({
      threads,
      activeId: 'draft-1',
      projectOf: () => null,
      projectIds: new Set()
    })

    expect(result.ungrouped.map((entry) => entry.id)).toEqual(['draft-1', 't1', 't2', 't3'])
  })

  it('round 26：草稿的显示标题从 draftTitle 进来（就地重命名的结果）；不给就是 null 占位', () => {
    const withTitle = composeSidebarSessions({
      threads,
      activeId: 'draft-1',
      projectOf: () => null,
      projectIds: new Set(),
      draftTitle: '草稿改过的名'
    })
    expect(withTitle.ungrouped[0]).toMatchObject({ id: 'draft-1', title: '草稿改过的名' })

    const withoutTitle = composeSidebarSessions({
      threads,
      activeId: 'draft-1',
      projectOf: () => null,
      projectIds: new Set()
    })
    expect(withoutTitle.ungrouped[0]?.title).toBeNull()
  })

  it('映射指向已删项目：当"没有项目"处理（回「任务」组）', () => {
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

  it('round 20：归档的会话整条不出现（含草稿与项目桶）', () => {
    const result = composeSidebarSessions({
      threads,
      activeId: 't2',
      projectOf: (id) => (id === 't2' ? 'p1' : null),
      projectIds: new Set(['p1']),
      archivedIds: new Set(['t2'])
    })

    expect(result.byProject).toEqual({})
    expect(result.ungrouped.map((entry) => entry.id)).toEqual(['t1', 't3'])
  })

  it('round 20：归档当前草案（还没落成线程）也不出现', () => {
    const result = composeSidebarSessions({
      threads,
      activeId: 'draft-1',
      projectOf: () => null,
      projectIds: new Set(),
      archivedIds: new Set(['draft-1'])
    })

    expect(result.ungrouped.map((entry) => entry.id)).toEqual(['t1', 't2', 't3'])
  })

  it('round 20：置顶的排在各桶最前（stable：同档保持服务端顺序；草稿仍在置顶之后但在其余之前）', () => {
    const result = composeSidebarSessions({
      threads,
      activeId: 'draft-1',
      projectOf: (id) => (id === 't2' || id === 'draft-1' ? 'p1' : null),
      projectIds: new Set(['p1']),
      pinnedIds: new Set(['t3', 't2'])
    })

    // 「任务」组（ungrouped）：t3 置顶排最前（t1 在它后面）
    expect(result.ungrouped.map((entry) => entry.id)).toEqual(['t3', 't1'])
    // 项目桶：t2 置顶，但草稿永远更靠前（T18 的口径不动）
    expect(result.byProject['p1']?.map((entry) => entry.id)).toEqual(['draft-1', 't2'])
  })
})
