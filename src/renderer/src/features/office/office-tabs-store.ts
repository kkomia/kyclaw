import { create } from 'zustand'
import type { OfficeDocumentInfo } from '@shared/office-editor'
import { openBlockReason, type OpenBlock } from './office-capacity'

/**
 * Office 工作区的标签模型（0.2.0 只做骨架，编辑器后续接）。
 *
 * 与右侧工作台（workbench-store）刻意分开：那是聊天右栏的工具面板（浏览器/文件/Git/终端/预览），
 * 生命周期按会话根存取；这里是**独立于会话的文档工作区** —— 标签不带 threadId，也不读
 * sessions-store：切会话、切模块都不能换掉已经打开的 Word/PPT/Excel/PDF/图片/文本/网页。
 */
export const OFFICE_TAB_KINDS = ['docx', 'pptx', 'xlsx', 'pdf', 'image', 'text', 'web'] as const

export type OfficeTabKind = (typeof OFFICE_TAB_KINDS)[number]

/** 文件/文档类标签（有磁盘路径）；`web` 走 URL */
export type OfficeDocumentKind = Exclude<OfficeTabKind, 'web'>

/** 关闭脏标签时的三种处理；保存档要编辑器接上 OfficeTabs 的 onSave 才出现 */
export type DirtyCloseAction = 'save' | 'discard' | 'cancel'

export interface OfficeTab {
  /** 稳定的标签 id：只随标签创建生成，切标签/重排/标记 dirty 都不变 */
  id: string
  kind: OfficeTabKind
  title: string
  /** 文档/文件类：打开时的路径（同时是兜底去重键） */
  path?: string
  /**
   * M3-S4：主进程回包里的**只读绝对路径**（仅 docx；选择器入口与 `path` 相同、会话入口不同）。
   * 只用于"同一文件"匹配/展示（预览交叉提示、聊天入口去重），**绝不作为授权/读写参数**回传主进程。
   */
  absolutePath?: string
  /**
   * M3-S2：主进程文档注册表的不透明 id（第一步 docx 必有）。
   * 有它时去重以它为准——同一真实文件的选择器绝对路径与会话相对路径不同，路径不能当身份。
   */
  documentId?: string
  /** web 类：打开时的网址（同时是去重键） */
  url?: string
  dirty: boolean
  readOnly: boolean
  /** 最近一次被激活的毫秒时间戳（以后按最近使用排序用） */
  lastActiveAt: number
  /**
   * M3-S5-3：dormant = **占位标签**——标签还在（可激活、标题/路径不变），但它那块
   * `OfficeWorkspace`（= 整个 iframe）已卸载：编辑器/wasm 内存放掉，激活时从磁盘重读字节重建。
   * 约束：active 恒不为 dormant；**dirty 恒不为 dormant**（存了未保存内容还卸载 = 丢内容）。
   * 缺省 undefined = 正常挂载。
   */
  dormant?: boolean
}

export type OfficeOpenInput =
  | {
      kind: OfficeDocumentKind
      path: string
      title?: string
      readOnly?: boolean
    }
  | {
      kind: 'web'
      url: string
      title?: string
      readOnly?: boolean
    }

export interface OfficeTabsState {
  /** 开着的标签，顺序即显示顺序 */
  tabs: OfficeTab[]
  /** 当前标签；空串 = 空态 */
  activeTabId: string
  /** 按路径（文件类）/ URL（web）去重并激活；返回标签 id */
  open: (input: OfficeOpenInput) => string
  /**
   * M3-S2：按主进程的 `OfficeDocumentInfo` 打开/激活 DOCX 标签。
   * **按 documentId 去重**（realpath 同一文件只开一个标签）；title=displayName、
   * path=displayPath、kind='docx'、readOnly 跟主进程回包。已存在时只激活，不重置 dirty/readOnly。
   *
   * M3-S5-3：这是**旧签名**（超限被拒时返回空串、拿不到原因，只为既有调用方不破）。新接线
   * （打开入口展示"为什么打不开"）请用 `openDocumentChecked`。
   */
  openDocument: (info: OfficeDocumentInfo) => string
  /**
   * M3-S5-3：带原因的打开（`office-capacity` 的打开闸门）：同 documentId → 只激活；
   * 新文档且标签数/未保存数超限 → `{ok:false, block}` 且**不新增标签**（不静默加）。
   */
  openDocumentChecked: (info: OfficeDocumentInfo) => OfficeDocumentOpenResult
  /**
   * M3-S5-3：批量置 dormant（幂等；未知 id 忽略；**dirty 标签跳过**——绝不把未保存内容卸载）。
   * 调用方一般直接喂 `planMounts(...).dormant`。
   */
  setDormant: (ids: readonly string[]) => void
  /** M3-S5-3：恢复挂载（激活时会自动清；这里给"只预挂不激活"的场景用） */
  clearDormant: (id: string) => void
  /**
   * M3-S3：另存为成功后按 documentId 更新既有标签的标题/路径/只读（documentId 不变）。
   * 不触碰 dirty/active（脏由保存状态机单独 commit）。
   */
  replaceDocument: (info: OfficeDocumentInfo) => void
  /** 关标签；返回是否真的关掉（未知 id = false） */
  close: (id: string) => boolean
  activate: (id: string) => void
  /** 把标签移到目标下标（越界夹取；未知 id 空操作） */
  reorder: (id: string, toIndex: number) => void
  markDirty: (id: string, dirty?: boolean) => void
  markSaved: (id: string) => void
  closeAll: () => void
  tabsOfKind: (kind: OfficeTabKind) => OfficeTab[]
}

/** 标签 id 计数器（模块级：先 docx-1，之后顺序往后；测试用 resetOfficeTabsStore 归零） */
let seq = 0

function nextTabId(kind: OfficeTabKind): string {
  seq += 1
  return `${kind}-${seq}`
}

/** 去重键：文档优先用主进程 documentId；文件类比路径、web 类比 URL（同类资源只开一个标签） */
function resourceKeyOf(source: {
  kind: OfficeTabKind
  path?: string
  url?: string
  documentId?: string
}): string {
  if (source.documentId !== undefined && source.documentId !== '') {
    return `doc:${source.documentId}`
  }
  return source.kind === 'web' ? `url:${source.url ?? ''}` : `path:${source.path ?? ''}`
}

/** 标签标题：显式标题优先；web 用主机名，文件用文件名（正反斜杠都认） */
export function officeTabTitleOf(input: OfficeOpenInput): string {
  const given = input.title?.trim()
  if (given !== undefined && given !== '') return given
  if (input.kind === 'web') {
    try {
      return new URL(input.url).host || input.url
    } catch {
      return input.url
    }
  }
  const segments = input.path.split(/[\\/]/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? input.path
}

/** M3-S5-3：带原因的打开结果（同文档去重 → ok:true；超限才是 ok:false + 分类） */
export type OfficeDocumentOpenResult = { ok: true; tabId: string } | { ok: false; block: OpenBlock }

export const useOfficeTabsStore = create<OfficeTabsState>()((set, get) => ({
  tabs: [],
  activeTabId: '',
  open: (input) => {
    const key = resourceKeyOf(input)
    const existing = get().tabs.find((tab) => resourceKeyOf(tab) === key)
    if (existing !== undefined) {
      get().activate(existing.id)
      return existing.id
    }
    const tab: OfficeTab = {
      id: nextTabId(input.kind),
      kind: input.kind,
      title: officeTabTitleOf(input),
      dirty: false,
      readOnly: input.readOnly === true,
      lastActiveAt: Date.now(),
      ...(input.kind === 'web' ? { url: input.url } : { path: input.path })
    }
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }))
    return tab.id
  },
  openDocumentChecked: (info) => {
    const existing = get().tabs.find((tab) => tab.documentId === info.documentId)
    if (existing !== undefined) {
      // 同一真实文件（选择器/会话/聊天入口都可能点第二次）：只激活，不重置 dirty/readOnly。
      // 去重激活**不受上限限制**（这本就是已有标签，不算"新开"）。
      get().activate(existing.id)
      return { ok: true, tabId: existing.id }
    }
    // 打开闸门（标签数 / 未保存数超限）：拒绝并带回原因，**不新增标签**（不静默加）
    const block = openBlockReason(get().tabs, info.kind)
    if (block !== null) return { ok: false, block }
    const tab: OfficeTab = {
      id: nextTabId(info.kind),
      kind: info.kind,
      title: info.displayName,
      path: info.displayPath,
      absolutePath: info.absolutePath,
      documentId: info.documentId,
      dirty: false,
      readOnly: info.readOnly,
      lastActiveAt: Date.now()
    }
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }))
    return { ok: true, tabId: tab.id }
  },
  openDocument: (info) => {
    // 旧签名：超限被拒时返回空串（拿不到原因）。新接线请用 openDocumentChecked。
    const result = get().openDocumentChecked(info)
    return result.ok ? result.tabId : ''
  },
  setDormant: (ids) => {
    const wanted = new Set(ids)
    set((state) => {
      let changed = false
      const tabs = state.tabs.map((tab) => {
        if (!wanted.has(tab.id)) return tab
        // 幂等：已经 dormant 的不换引用；**dirty 永不 dormant**（卸载编辑器 = 丢未保存内容）
        if (tab.dormant === true || tab.dirty) return tab
        changed = true
        return { ...tab, dormant: true }
      })
      return changed ? { tabs } : {}
    })
  },
  clearDormant: (id) => {
    set((state) => {
      const target = state.tabs.find((tab) => tab.id === id)
      if (target === undefined || target.dormant !== true) return {}
      return {
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, dormant: false } : tab))
      }
    })
  },
  replaceDocument: (info) => {
    set((state) => {
      const existing = state.tabs.find((tab) => tab.documentId === info.documentId)
      if (existing === undefined) return {}
      return {
        tabs: state.tabs.map((tab) =>
          tab.documentId === info.documentId
            ? {
                ...tab,
                title: info.displayName,
                path: info.displayPath,
                absolutePath: info.absolutePath,
                readOnly: info.readOnly
              }
            : tab
        )
      }
    })
  },
  close: (id) => {
    const state = get()
    const index = state.tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return false
    const tabs = state.tabs.filter((tab) => tab.id !== id)
    // 关掉的是当前标签：接到左边那个（没有就右边）；全关光时 activeTabId 空串 = 空态
    const activeTabId =
      state.activeTabId === id ? ((tabs[index - 1] ?? tabs[index])?.id ?? '') : state.activeTabId
    set({ tabs, activeTabId })
    return true
  },
  activate: (id) =>
    set((state) => {
      if (!state.tabs.some((tab) => tab.id === id)) return {}
      return {
        activeTabId: id,
        tabs: state.tabs.map((tab) => {
          if (tab.id !== id) return tab
          const next = { ...tab, lastActiveAt: Date.now() }
          // M3-S5-3：active 永不 dormant —— 激活一个 dormant 标签 = 恢复挂载（调用方随后从磁盘重读）
          return tab.dormant === true ? { ...next, dormant: false } : next
        })
      }
    }),
  reorder: (id, toIndex) =>
    set((state) => {
      const from = state.tabs.findIndex((tab) => tab.id === id)
      if (from === -1) return {}
      const to = Math.min(Math.max(toIndex, 0), state.tabs.length - 1)
      if (to === from) return {}
      const tabs = [...state.tabs]
      const [moved] = tabs.splice(from, 1)
      if (moved === undefined) return {}
      tabs.splice(to, 0, moved)
      return { tabs }
    }),
  markDirty: (id, dirty = true) =>
    set((state) => {
      if (!state.tabs.some((tab) => tab.id === id)) return {}
      return { tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, dirty } : tab)) }
    }),
  markSaved: (id) =>
    set((state) => {
      if (!state.tabs.some((tab) => tab.id === id)) return {}
      return { tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, dirty: false } : tab)) }
    }),
  closeAll: () => set({ tabs: [], activeTabId: '' }),
  tabsOfKind: (kind) => get().tabs.filter((tab) => tab.kind === kind)
}))

/** 测试用：回到初始状态（模块级 store 与 id 计数器都不随 render 重置） */
export function resetOfficeTabsStore(): void {
  seq = 0
  useOfficeTabsStore.setState({ tabs: [], activeTabId: '' })
}
