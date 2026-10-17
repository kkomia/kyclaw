/**
 * Office 文档容量策略（M3-S5-3 前置，**纯逻辑**）：打开闸门 / 挂载计划 / 整面重载判定。
 *
 * 背景（`.superpowers/handover/s5-recon.md` §3、`office-docx-plan.md` §7.5）：
 *   - DOCX 编辑器**没有 dispose**：卸载只释放文档活内存，共享 wasm 线性内存不缩容 → "关标签"不等于
 *     回收内存；S4 实测两个编辑器同驻 Office 面 working set 831 MiB（单编辑器 562.8）。
 *   - 因此策略分三层：① 打开前闸门（上限，不静默加标签）；② 同时挂载的编辑器数上限，超出的
 *     **clean** 标签转 dormant（整块 OfficeWorkspace = 整个 iframe 卸载，保留标签；激活时从磁盘重读）；
 *     ③ 唯一能回收线性内存的手段是**整面重载**（销毁 iframe）：只在没有 dirty 时做。
 *
 * 本模块不 import store / React：全部纯函数，`lastActiveAt`、上限都可注入，单测直接驱动。
 * 接线（S5-3 收尾，A2 之后）：OfficePage 的渲染循环按 `planMounts` 决定挂载/占位，
 * 打开入口先问 `openBlockReason`，面空闲时按 `shouldReloadSurface` 决定是否重建 iframe。
 */
import type { OfficeTab, OfficeTabKind } from './office-tabs-store'

/**
 * 同时打开的标签上限（D18：跨格式共享、命名通用；壳自己这一层是产品体验上限）。
 * 主进程注册表另有 `OFFICE_MAX_OPEN_DOCUMENTS=24`（防泄漏），两层都要过。
 */
export const OFFICE_MAX_OPEN_TABS = 5

/** 同时挂载编辑器的上限（active + dirty + 其余 clean 的 LRU 名额总计）。依据 recon §3.2 */
export const OFFICE_MAX_MOUNTED_EDITORS = 3

/** 同时存在的未保存文档上限（超限时打开新文档要用户先保存/关闭；dirty 永不驱逐） */
export const OFFICE_MAX_DIRTY_EDITORS = 3

/**
 * 同一个 Office 面（iframe）复用多少次后、在**没有 dirty** 时值得整面重载（回收线性内存）。
 * 经验值：S5-4 探针用 `app.getAppMetrics()` 实测后再校准；只影响"什么时候重建"不影响正确性。
 */
export const OFFICE_SURFACE_MAX_REUSE = 24

/** 打开被拒的分类：打开数超限 / 未保存文档超限 */
export type OpenBlockCode = 'max-open' | 'max-dirty'

export interface OpenBlock {
  code: OpenBlockCode
  /** 直接给用户看的人话（调用方原样展示，不拼接） */
  message: string
  /** 请求打开的类型（原样带回；现阶段消息不按类型分叉，给将来按格式限流留口） */
  kind: OfficeTabKind
}

/** 未保存文档数（dirty 的真相在 save-machine，store 的 dirty 是它的投影；这里只数投影） */
export function countDirtyTabs(tabs: readonly OfficeTab[]): number {
  let dirtyCount = 0
  for (const tab of tabs) {
    if (tab.dirty) dirtyCount += 1
  }
  return dirtyCount
}

/**
 * 打开前的闸门（**纯判断，不改 store**）。
 *   - 标签数已达上限 → `max-open`；
 *   - 未保存文档数已达上限 → `max-dirty`（先保存/关闭，不静默驱逐脏文档）。
 * 同文件重复打开（按 documentId 去重）不经过这里：那是"激活既有标签"，不是新开。
 * 返回 null = 可以打开。
 */
export function openBlockReason(
  tabs: readonly OfficeTab[],
  incomingKind: OfficeTabKind
): OpenBlock | null {
  if (tabs.length >= OFFICE_MAX_OPEN_TABS) {
    return {
      code: 'max-open',
      message: `最多同时打开 ${String(OFFICE_MAX_OPEN_TABS)} 个标签，请先关闭一些再打开新的`,
      kind: incomingKind
    }
  }
  if (countDirtyTabs(tabs) >= OFFICE_MAX_DIRTY_EDITORS) {
    return {
      code: 'max-dirty',
      message: `最多同时保留 ${String(OFFICE_MAX_DIRTY_EDITORS)} 个未保存的文档，请先保存或关闭再打开新的`,
      kind: incomingKind
    }
  }
  return null
}

export interface MountPlanOptions {
  /** 当前激活的标签 id（空串 = 空态） */
  activeTabId: string
  /** 取"最近激活时间"（单测注入固定值；缺省读 `tab.lastActiveAt`，没有再退 0） */
  lastActiveAt?: (tab: OfficeTab) => number
  /** 覆盖挂载上限（单测/将来调参；缺省 `OFFICE_MAX_MOUNTED_EDITORS`） */
  maxMounted?: number
}

export interface MountPlan {
  /** 需要挂载编辑器的标签 id（store 顺序，便于渲染循环直接照抄） */
  mounted: string[]
  /** 应处于 dormant（卸载编辑器、保留标签）的标签 id（store 顺序；幂等，调用方可整批 setDormant） */
  dormant: string[]
  /** 本次要从"已挂载"转成 dormant 的 clean 标签 id：**按 LRU 从最久未激活到最近**排好序 */
  evicted: string[]
  /** 本次要从 dormant 恢复挂载的标签 id（store 顺序；这些激活时要从磁盘重读字节） */
  revived: string[]
  /**
   * 不应发生的情况：active + dirty 的强制挂载数已超过上限（dirty>3 或 dirty=3 + active 是另一个
   * clean 标签）。此时**不强行驱逐 dirty**，返回它让调用方给提示（正常路径上打开闸门已挡住）。
   */
  blocked: 'all-mounted-dirty' | null
}

/**
 * 计算挂载计划（**纯函数**，不改 store）。
 *
 * 规则（recon §3.4）：
 *   1. active 恒挂载；dirty 恒挂载（dirty 永不 dormant）；
 *   2. 其余 clean 标签按 `lastActiveAt` 降序补到上限（`maxMounted`，缺省 3）；
 *   3. `dormant` 是"应处于 dormant 的全集"（幂等）；`evicted` 只列本次新要驱逐的（LRU 顺序）；
 *   4. `revived` 列出本次从 dormant 恢复的（调用方负责重读磁盘）。
 *
 * dirty 与 active 的强制挂载数超过上限时：仍然全部挂载（绝不驱逐 dirty），`blocked` 置位。
 */
export function planMounts(tabs: readonly OfficeTab[], options: MountPlanOptions): MountPlan {
  const lastActiveAt = options.lastActiveAt ?? ((tab: OfficeTab): number => tab.lastActiveAt ?? 0)
  const maxMounted = options.maxMounted ?? OFFICE_MAX_MOUNTED_EDITORS

  const activeTab = tabs.find((tab) => tab.id === options.activeTabId)
  const dirtyTabs = tabs.filter((tab) => tab.dirty)

  // 1) 强制挂载集合：active + dirty（按 store 顺序，active 可能本来就是 dirty）
  const mandatoryIds = new Set<string>()
  if (activeTab !== undefined) mandatoryIds.add(activeTab.id)
  for (const tab of dirtyTabs) mandatoryIds.add(tab.id)

  // 2) 剩余名额给 clean 且非 active 的标签，按最近激活降序（最近用过的优先留在内存里）
  const slots = Math.max(0, maxMounted - mandatoryIds.size)
  const cleanCandidates = tabs
    .filter((tab) => !mandatoryIds.has(tab.id) && !tab.dirty)
    .slice()
    .sort((a, b) => lastActiveAt(b) - lastActiveAt(a))
  for (const tab of cleanCandidates.slice(0, slots)) mandatoryIds.add(tab.id)

  // 3) 输出：mounted/dormant/revived 用 store 顺序（渲染稳定）；evicted 用 LRU 顺序
  const mounted = tabs.filter((tab) => mandatoryIds.has(tab.id)).map((tab) => tab.id)
  const dormant = tabs.filter((tab) => !mandatoryIds.has(tab.id)).map((tab) => tab.id)
  const evicted = tabs
    .filter((tab) => tab.dormant !== true && !mandatoryIds.has(tab.id) && !tab.dirty)
    .slice()
    .sort((a, b) => lastActiveAt(a) - lastActiveAt(b))
    .map((tab) => tab.id)
  const revived = tabs
    .filter((tab) => tab.dormant === true && mandatoryIds.has(tab.id))
    .map((tab) => tab.id)

  return {
    mounted,
    dormant,
    evicted,
    revived,
    blocked: mandatoryIds.size > maxMounted ? 'all-mounted-dirty' : null
  }
}

export interface SurfaceReloadInput {
  /** 当前打开的标签数（0 = 空态） */
  openTabCount: number
  /** 其中未保存的标签数（>0 一律不重载：销毁 iframe 会丢内容） */
  dirtyCount: number
  /** 这个 iframe 自上次创建以来的复用次数（切标签/换文档都算一次；S5-3 接线时累计） */
  reuseCount: number
  /** 覆盖复用上限（单测/实测后调参；缺省 `OFFICE_SURFACE_MAX_REUSE`） */
  maxReuse?: number
}

/**
 * 整面重载判定（recon §3 / 方案 §7.5）：**唯一能回收 wasm 线性内存**的手段。
 *
 * 只在"没有未保存内容"时做：
 *   - 有 dirty → 绝不重载（内容只在 iframe 里，销毁 = 丢）；
 *   - 标签全关（openTabCount=0）→ 重载（把空面回收掉，下次打开重建）；
 *   - 复用次数达到上限 → 重载（线性内存的近似度量；S5-4 用 getAppMetrics 实测校准）。
 *
 * 注意：重载后干净标签按需从磁盘重开（壳只存 documentId 清单，不存内容）。
 */
export function shouldReloadSurface(input: SurfaceReloadInput): boolean {
  if (input.dirtyCount > 0) return false
  if (input.openTabCount === 0) return true
  const maxReuse = input.maxReuse ?? OFFICE_SURFACE_MAX_REUSE
  return input.reuseCount >= maxReuse
}
