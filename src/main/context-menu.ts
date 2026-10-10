/**
 * 客户端内的右键菜单（雷点 4：原生右键菜单一律重写）。
 *
 * 口径：
 *   - 编辑区（输入框 / 文本域 / 可编辑内容）= 剪切 / 复制 / 粘贴 / 全选 —— 只留有功能的项，
 *     禁用态直接取 Chromium 给的 editFlags（没选区时复制就是灰的）；
 *   - 非编辑区有选中文字 = 复制 / 全选；
 *   - 其余位置**不弹**（不给"查看源代码 / 检查元素 / 另存为 / 刷新"这类浏览器项留任何入口）。
 *
 * 这里只做"菜单模板"的构造（纯函数，可在单测里逐条断言）；挂事件与弹菜单在 attachContextMenu。
 * 注意：Electron 本身不会给窗口加默认右键菜单，所以这里不是"去掉默认项"，而是"只放我们认的项"。
 */
import {
  Menu,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions
} from 'electron'

/** 菜单动作落点：webContents 的那几个原生编辑命令（签名照抄 electron 的 WebContents） */
export interface ContextMenuActions {
  cut: () => void
  copy: () => void
  paste: () => void
  selectAll: () => void
}

export function contextMenuTemplate(
  params: Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>,
  actions: ContextMenuActions
): MenuItemConstructorOptions[] {
  const flags = params.editFlags
  const hasSelection = params.selectionText.trim() !== '' || flags.canCopy

  if (params.isEditable) {
    return [
      { label: '剪切', enabled: flags.canCut, click: actions.cut },
      { label: '复制', enabled: flags.canCopy, click: actions.copy },
      { label: '粘贴', enabled: flags.canPaste, click: actions.paste },
      { type: 'separator' },
      { label: '全选', enabled: flags.canSelectAll, click: actions.selectAll }
    ]
  }

  if (hasSelection) {
    return [
      { label: '复制', enabled: flags.canCopy, click: actions.copy },
      { label: '全选', enabled: flags.canSelectAll, click: actions.selectAll }
    ]
  }

  return []
}

/** 把右键菜单挂到一个窗口上（模板为空就不弹，等于该位置没有右键菜单） */
export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params, {
      cut: () => win.webContents.cut(),
      copy: () => win.webContents.copy(),
      paste: () => win.webContents.paste(),
      selectAll: () => win.webContents.selectAll()
    })
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window: win })
  })
}
