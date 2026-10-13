/**
 * 「新建会话」的快捷键口径（Ctrl+K / Cmd+K）：纯数据 + 纯函数，独立成 .ts 与
 * workbench-actions 同一写法 —— 键帽显示与窗口级键盘监听**共用这一处**，
 * 不会"改了键帽忘了改监听"（监听见 use-new-session-shortcut）。
 */

/** 主键：k（判定用小写，event.key 大小写不分） */
export const NEW_SESSION_SHORTCUT_KEY = 'k'

/**
 * 命令键的键帽：macOS 显示 ⌘，其余平台显示 Ctrl —— 认不出平台（jsdom、老内核）也按 Ctrl 画，
 * 与"两个修饰键都认"的判定一致。渲染端拿不到 process.platform（主进程没往外暴露），
 * 只能读 navigator.platform；参数只为单测注入平台用。
 */
export function commandKeyLabel(platform: string = currentPlatform()): string {
  return /mac/i.test(platform) ? '⌘' : 'Ctrl'
}

function currentPlatform(): string {
  return typeof navigator === 'undefined' ? '' : navigator.platform
}

/**
 * 键盘事件 → 是不是"新建会话"（Ctrl+K / Cmd+K）。
 * 宽容口径（对齐 workbench-actions）：左右 Ctrl 不分、字母大小写不分、**Ctrl 与 Cmd 都认**
 * （macOS 上物理键就是 ⌘，同一个快捷键不必按平台分两套判定）。
 * 多按了 Shift/Alt 不算 —— 那是别的快捷键的地盘（Ctrl+Shift+E/G 归工作台），不许抢。
 * 命中由调用方 preventDefault（Windows 上不留给别的默认行为）。
 */
export function matchNewSessionShortcut(event: KeyboardEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false
  if (event.altKey || event.shiftKey) return false
  return event.key.toLowerCase() === NEW_SESSION_SHORTCUT_KEY
}
