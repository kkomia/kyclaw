import { create } from 'zustand'

/**
 * 新增标签页的**单例空白伪标签**（task-80；`.superpowers/tab-newpage/DESIGN.md` §2/§5）。
 *
 * 它不是 `office-tabs-store` 的标签：没有 documentId、没有 dirty、不参与
 * `OFFICE_MAX_OPEN_TABS` / `planMounts` / 退出脏确认、也**不持久化**（重启不复活）。
 * 只有三件事：
 *   - `isOpen`：标签条上有没有它（单例，永远最多一个）；
 *   - `isActive`：前台视图是不是它（只有 `/office` 且它在前台时渲染 NewTabPage）；
 *   - 状态转移：`open()`（开/激活）、`activate()`、`deactivate()`（文档拿到前台，标签保留）、
 *     `consume()`（本页做成选择：标签消失）、`close()`（X / 中键 / Ctrl+W / Esc，同 consume 语义）。
 */
export interface NewTabState {
  isOpen: boolean
  isActive: boolean
  /** 开空白页：没开就开；已开只激活（单例，绝不叠第二个） */
  open: () => void
  /** 把已有空白页拿到前台（不改 isOpen） */
  activate: () => void
  /** 文档被激活：空白仍留在标签条上，但视口让给文档 */
  deactivate: () => void
  /** 本页的选择发生了（新建/打开/继续/写笔记成功）：空白标签消失 */
  consume: () => void
  /** 关闭空白（X / 中键 / Ctrl+W / Esc，无确认） */
  close: () => void
}

export const useNewTabStore = create<NewTabState>()((set) => ({
  isOpen: false,
  isActive: false,
  open: () => set({ isOpen: true, isActive: true }),
  activate: () => set((state) => (state.isOpen && !state.isActive ? { isActive: true } : {})),
  deactivate: () => set((state) => (state.isActive ? { isActive: false } : {})),
  consume: () => set({ isOpen: false, isActive: false }),
  close: () => set({ isOpen: false, isActive: false })
}))

/** 测试用：模块级单例不随 render 重置 */
export function resetNewTabStore(): void {
  useNewTabStore.setState({ isOpen: false, isActive: false })
}
