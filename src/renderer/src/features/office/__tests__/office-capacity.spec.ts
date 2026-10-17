import { describe, expect, it } from 'vitest'
import {
  countDirtyTabs,
  OFFICE_MAX_DIRTY_EDITORS,
  OFFICE_MAX_MOUNTED_EDITORS,
  OFFICE_MAX_OPEN_TABS,
  OFFICE_SURFACE_MAX_REUSE,
  openBlockReason,
  planMounts,
  shouldReloadSurface
} from '../office-capacity'
import type { OfficeTab, OfficeTabKind } from '../office-tabs-store'

/** 造一个标签（只填容量策略关心的字段；lastActiveAt 可直接给） */
function tab(id: string, patch: Partial<OfficeTab> & { kind?: OfficeTabKind } = {}): OfficeTab {
  return {
    id,
    kind: 'docx',
    title: `${id}.docx`,
    dirty: false,
    readOnly: false,
    lastActiveAt: 0,
    ...patch
  }
}

describe('office-capacity：常量（D18 通用命名，跨格式共享）', () => {
  it('打开上限 5 / 挂载上限 3 / 未保存上限 3；整面重载复用上限有默认值', () => {
    expect(OFFICE_MAX_OPEN_TABS).toBe(5)
    expect(OFFICE_MAX_MOUNTED_EDITORS).toBe(3)
    expect(OFFICE_MAX_DIRTY_EDITORS).toBe(3)
    expect(OFFICE_SURFACE_MAX_REUSE).toBeGreaterThan(0)
  })
})

describe('office-capacity：countDirtyTabs', () => {
  it('只数 dirty（干净标签不计；readOnly 也照 dirty 投影计数，投影本身不该出现）', () => {
    expect(countDirtyTabs([])).toBe(0)
    expect(
      countDirtyTabs([
        tab('a'),
        tab('b', { dirty: true }),
        tab('c', { readOnly: true, dirty: true }),
        tab('d', { dirty: false })
      ])
    ).toBe(2)
  })
})

describe('office-capacity：打开闸门 openBlockReason', () => {
  it('未到上限：可以打开（null）', () => {
    expect(openBlockReason([], 'docx')).toBeNull()
    const four = [tab('a'), tab('b'), tab('c'), tab('d')]
    expect(openBlockReason(four, 'docx')).toBeNull()
  })

  it('标签数到上限：max-open，消息有人话与上限数字，kind 原样带回', () => {
    const five = [tab('a'), tab('b'), tab('c'), tab('d'), tab('e')]
    const block = openBlockReason(five, 'pptx')
    expect(block).toMatchObject({ code: 'max-open', kind: 'pptx' })
    expect(block?.message).toContain('5')
    expect(block?.message).toContain('关闭')
  })

  it('未保存数到上限：max-dirty（先保存/关闭，不静默驱逐脏文档；打开数未满是前提）', () => {
    const tabs = [tab('a', { dirty: true }), tab('b', { dirty: true }), tab('c', { dirty: true })]
    const block = openBlockReason(tabs, 'docx')
    expect(block).toMatchObject({ code: 'max-dirty', kind: 'docx' })
    expect(block?.message).toContain('保存')
  })

  it('两条都超：先报 max-open（打开数是最外层的硬闸）', () => {
    const tabs = [
      tab('a', { dirty: true }),
      tab('b', { dirty: true }),
      tab('c', { dirty: true }),
      tab('d'),
      tab('e')
    ]
    expect(openBlockReason(tabs, 'docx')?.code).toBe('max-open')
  })
})

describe('office-capacity：挂载计划 planMounts', () => {
  it('空标签：全空、不阻塞', () => {
    expect(planMounts([], { activeTabId: '' })).toEqual({
      mounted: [],
      dormant: [],
      evicted: [],
      revived: [],
      blocked: null
    })
  })

  it('active + dirty 恒挂载：上限内 clean 按最近激活降序补满；其余 dormant', () => {
    const tabs = [
      tab('active', { lastActiveAt: 10 }),
      tab('dirty-1', { dirty: true, lastActiveAt: 5 }),
      tab('clean-old', { lastActiveAt: 1 }),
      tab('clean-new', { lastActiveAt: 9 }),
      tab('clean-mid', { lastActiveAt: 7 })
    ]
    // 上限 3：active + dirty-1 已占 2，剩 1 个名额 → 最近激活的 clean-new 留下
    const plan = planMounts(tabs, { activeTabId: 'active' })
    expect(plan.mounted).toEqual(['active', 'dirty-1', 'clean-new'])
    expect(plan.dormant).toEqual(['clean-old', 'clean-mid'])
    expect(plan.blocked).toBeNull()
  })

  it('dirty 永不 dormant：哪怕 lastActiveAt 最老也照样挂载', () => {
    const tabs = [
      tab('active', { lastActiveAt: 100 }),
      tab('dirty-old', { dirty: true, lastActiveAt: 1 }),
      tab('clean-new', { lastActiveAt: 99 }),
      tab('clean-mid', { lastActiveAt: 50 }),
      tab('clean-old', { lastActiveAt: 2 })
    ]
    const plan = planMounts(tabs, { activeTabId: 'active' })
    expect(plan.mounted).toContain('dirty-old')
    expect(plan.dormant).not.toContain('dirty-old')
    // 上限 3：active + dirty + 最近 clean-new → 另外两个 clean 变 dormant
    expect(plan.dormant).toEqual(['clean-mid', 'clean-old'])
  })

  it('evicted 是"本次从已挂载转 dormant"的 clean，按 LRU 最久未激活在前', () => {
    const tabs = [
      tab('active', { lastActiveAt: 100 }),
      tab('mounted-recent', { lastActiveAt: 90 }),
      tab('mounted-oldest', { lastActiveAt: 1 }),
      tab('mounted-old', { lastActiveAt: 5 }),
      tab('mounted-mid', { lastActiveAt: 50 })
    ]
    // 上限 3 = active + 两个最近（mounted-recent 90 / mounted-mid 50）
    const plan = planMounts(tabs, { activeTabId: 'active' })
    expect(plan.mounted).toEqual(['active', 'mounted-recent', 'mounted-mid'])
    // 被赶走的两个：更老的排前面（接线方按这个顺序回收/提示）
    expect(plan.evicted).toEqual(['mounted-oldest', 'mounted-old'])
  })

  it('revived 是"本次从 dormant 恢复挂载"的标签（接线方要重读磁盘）', () => {
    const tabs = [
      tab('active', { lastActiveAt: 10 }),
      tab('clean-sleeping', { dormant: true, lastActiveAt: 9 }),
      tab('clean-awake', { lastActiveAt: 8 })
    ]
    const plan = planMounts(tabs, { activeTabId: 'active' })
    // 上限 3：active + clean-sleeping（最近）+ clean-awake 全挂；sleeping 被唤醒
    expect(plan.mounted).toEqual(['active', 'clean-sleeping', 'clean-awake'])
    expect(plan.revived).toEqual(['clean-sleeping'])
    expect(plan.dormant).toEqual([])
  })

  it('已 dormant 且仍超限：幂等（dormant 集合稳定、不重复驱逐）', () => {
    const tabs = [
      tab('active', { lastActiveAt: 100 }),
      tab('keep', { lastActiveAt: 90 }),
      tab('keep-2', { lastActiveAt: 80 }),
      tab('sleep-1', { dormant: true, lastActiveAt: 1 }),
      tab('sleep-2', { dormant: true, lastActiveAt: 2 })
    ]
    const first = planMounts(tabs, { activeTabId: 'active' })
    const second = planMounts(tabs, { activeTabId: 'active' })
    expect(first).toEqual(second)
    expect(first.dormant).toEqual(['sleep-1', 'sleep-2'])
    // 已经是 dormant 的不再算"本次驱逐"
    expect(first.evicted).toEqual([])
  })

  it('强制挂载数超过上限（dirty=3 + active 是另一条 clean）：不驱逐 dirty，blocked 置位', () => {
    const tabs = [
      tab('active', { lastActiveAt: 100 }),
      tab('d1', { dirty: true }),
      tab('d2', { dirty: true }),
      tab('d3', { dirty: true }),
      tab('clean-extra', { lastActiveAt: 99 })
    ]
    const plan = planMounts(tabs, { activeTabId: 'active' })
    expect(plan.blocked).toBe('all-mounted-dirty')
    expect(plan.mounted).toEqual(['active', 'd1', 'd2', 'd3'])
    expect(plan.dormant).toEqual(['clean-extra'])
  })

  it('上限与最近激活取值都可注入（单测/将来调参）', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    const at =
      (value: number) =>
      (entry: OfficeTab): number =>
        entry.id === 'a' ? value : entry.id === 'b' ? value - 1 : value - 2

    const plan = planMounts(tabs, { activeTabId: '', maxMounted: 2, lastActiveAt: at(10) })
    expect(plan.mounted).toEqual(['a', 'b'])
    expect(plan.dormant).toEqual(['c'])

    // 换一套"最近激活"注入值：留下的是 a 与 c
    const flipped = planMounts(tabs, {
      activeTabId: '',
      maxMounted: 2,
      lastActiveAt: (entry) => (entry.id === 'c' ? 10 : entry.id === 'a' ? 9 : 1)
    })
    expect(flipped.mounted).toEqual(['a', 'c'])
  })
})

describe('office-capacity：整面重载判定 shouldReloadSurface', () => {
  it('有未保存内容：绝不重载（销毁 iframe 会丢内容）', () => {
    expect(shouldReloadSurface({ openTabCount: 2, dirtyCount: 1, reuseCount: 999 })).toBe(false)
    expect(shouldReloadSurface({ openTabCount: 0, dirtyCount: 1, reuseCount: 0 })).toBe(false)
  })

  it('标签全关：重载（把空面回收，下次打开重建）', () => {
    expect(shouldReloadSurface({ openTabCount: 0, dirtyCount: 0, reuseCount: 0 })).toBe(true)
  })

  it('复用次数达到上限：重载；没到：继续复用', () => {
    expect(
      shouldReloadSurface({ openTabCount: 2, dirtyCount: 0, reuseCount: OFFICE_SURFACE_MAX_REUSE })
    ).toBe(true)
    expect(
      shouldReloadSurface({
        openTabCount: 2,
        dirtyCount: 0,
        reuseCount: OFFICE_SURFACE_MAX_REUSE - 1
      })
    ).toBe(false)
    // 上限可注入（S5-4 实测后调参）
    expect(
      shouldReloadSurface({ openTabCount: 2, dirtyCount: 0, reuseCount: 5, maxReuse: 5 })
    ).toBe(true)
    expect(
      shouldReloadSurface({ openTabCount: 2, dirtyCount: 0, reuseCount: 4, maxReuse: 5 })
    ).toBe(false)
  })
})
