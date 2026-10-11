/**
 * 工作台空态（标签页全关光时）：面板正中一列动作条目 —— 左侧图标 + 标签，右侧键帽组。
 * 无标题、无解释小字；行 hover 铺灰底、点击（或 Enter/Space）即开对应标签。
 *
 * 四行的内容与键帽来自 workbench-actions 的同一张表（Workbench 的窗口级快捷键也读它）：
 * 显示了就必须能用。这里只管画；监听挂在 Workbench（面板收起也生效）。
 */
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { WorkbenchTabKind } from './workbench-store'
import { WORKBENCH_ACTIONS } from './workbench-actions'

/** 空态：居中一列动作条目（窄面板时收缩不溢出：定宽 + max-w-full） */
export function EmptyActions({
  openTab
}: {
  openTab: (kind: WorkbenchTabKind) => void
}): React.JSX.Element {
  return (
    <div
      data-testid="workbench-empty"
      className="flex min-h-0 flex-1 items-center justify-center p-4"
    >
      <ul data-testid="workbench-empty-actions" className="flex w-52 max-w-full flex-col gap-0.5">
        {WORKBENCH_ACTIONS.map((action) => {
          const Icon = action.icon
          return (
            <li key={action.kind}>
              <button
                type="button"
                data-testid={`workbench-empty-action-${action.kind}`}
                // 无障碍名就是标签：键帽不进去（"浏览器 Ctrl T"念出来是噪音）
                aria-label={action.label}
                onClick={() => openTab(action.kind)}
                onKeyDown={activateOnKey}
                className="flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left text-b2 text-ink outline-none transition-colors duration-(--motion-fast) ease-main hover:bg-hover focus-visible:bg-hover focus-visible:shadow-none"
              >
                <Icon
                  aria-hidden="true"
                  className="size-(--icon-size-sm) shrink-0 text-ink-secondary"
                />
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
                  {action.keys.map((key) => (
                    <KeyCap key={key}>{key}</KeyCap>
                  ))}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * 原生 button 在真机上 Enter/Space 自会走一次点击；jsdom 不实现这条默认行为，所以显式补上
 * （preventDefault 先挡掉真机的默认激活，否则一条键走两遍 = 开两个标签）。
 */
function activateOnKey(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  event.currentTarget.click()
}

/** 单键键帽：等宽观感、字符居中、min-w 对齐（单个字符的键也叫一样宽，组合一眼看懂） */
function KeyCap({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-badge border-(length:--hairline-width) border-hairline px-1 font-mono text-c1 leading-none text-ink-tertiary">
      {children}
    </kbd>
  )
}
