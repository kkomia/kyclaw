import type { MenuItemConstructorOptions } from 'electron'

/**
 * 托盘的右键菜单模板（T16 走查补测）：提成纯函数，文案与动作能被单测钉住。
 *
 * 为什么不写在 tray.ts 里：那个文件 `import icon from '../../resources/icon.png?asset'`，
 * `?asset` 是 electron-vite 的查询，vitest 解析不了 —— 模板与挂载分开，测试就不再被图标导入挡住。
 * 文案是用户可见界面（spec §2.1 生命周期），照产品名 kyclaw 写。
 */
export interface TrayMenuActions {
  show: () => void
  quit: () => void
}

export function trayMenuTemplate(actions: TrayMenuActions): MenuItemConstructorOptions[] {
  return [
    { label: '显示主窗口', click: actions.show },
    { type: 'separator' },
    { label: '退出 kyclaw', click: actions.quit }
  ]
}
