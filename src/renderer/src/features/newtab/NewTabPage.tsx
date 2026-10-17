import { NewTabView } from './NewTabView'
import { useNewTabController, type NewTabController } from './use-newtab-controller'

/**
 * 新增标签页入口（task-80，稳定导出；OfficePage 只依赖本文件）。
 *
 * **可替换边界**（2026-10-18 用户 02:44：视觉要重做，允许华丽）：
 *   - 行为/数据：`use-newtab-controller.ts`（单例空白消费、create-blank/open-dialog/notes、
 *     容量闸门、键盘语义、焦点、日期）—— 已真能用，换视觉时不动；
 *   - 视觉：`NewTabView.tsx` + `newtab.css` —— **临时极简壳，等新设计稿整体替换**；
 *   - 壳接线：`AppTabBar`（＋/空白标签/Ctrl+W）、`OfficePage`（blank 前台渲染本页、
 *     文档区 hidden/inert 不卸载）—— 与新视觉无关。
 * 换视觉时保持 `NewTabPage` 名字与 props（无）不变即可；testid 若改，同步改 newtab-page.spec。
 */
export function NewTabPage(): React.JSX.Element {
  const controller = useNewTabController()
  return <NewTabView {...controller} />
}

/** 视觉层单独导出给新设计稿并行预览/替换用（产品入口只用 NewTabPage） */
export type { NewTabController }
