import { SquarePen } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Kbd } from '../../components/ui/kbd'
import { cn } from '../../components/ui/cn'
import { navItemClass } from '../../components/shell/nav-item'
import { commandKeyLabel } from './session-shortcuts'

/**
 * 侧栏「新建会话」（附录 A：224 × 41）：
 * 224 = 侧栏 240 − 左右内边距 8×2，所以按钮本身 w-full、外层给 p-2；
 * 41 是实测值，覆盖导航行高档（--new-session-height）。
 * 底与文字按实测取 --field-bg + 墨色（深 #1f1f1f 底 / #dbdbdb 字 = Bg-Secondary + Labels-Primary）。
 *
 * round 64（用户口径："新建会话按钮有点简陋，做一个跟设置页图标一个风格的"）：
 * 三段式一行 —— 左侧图标（SquarePen，尺寸与设置页栏目、插件入口的导航图标同一档
 * --icon-size-md）、中间「新建会话」、右侧 **Ctrl + K 两枚键帽**（macOS 上是 ⌘ + K，
 * 见 commandKeyLabel）。键帽整组 aria-hidden：按钮的无障碍名还是四个字，念出来不带键位。
 *
 * T9：点击 = 开一个新草稿（onNew，由 SessionsController 接 store）并回到对话页；
 * 草稿在第一轮发消息时才在服务端落成真线程。
 * round 55：全局新建 = **无项目草稿**（不继承"最后浏览的项目"，根走默认工作区下的会话子目录）；
 * 要归属项目只有项目行的 ⊕ 那一条路 —— 这个按钮不带项目参数。
 * round 64：同一个动作也接了全局快捷键（Ctrl+K / Cmd+K，见 use-new-session-shortcut），
 * 键帽上写的组合就是那里接的组合。
 * round 65（用户口径："这个不要描边"）：**去掉描边**，只留填充底 —— 与雷点 7
 * （短距离内不得多层嵌套框线：按钮内还有两枚键帽，键帽自带 hairline）同向。
 */
export interface NewSessionButtonProps {
  onNew?: () => void
}

export function NewSessionButton({ onNew }: NewSessionButtonProps): React.JSX.Element {
  const navigate = useNavigate()

  return (
    <div className="shrink-0 p-2">
      <button
        type="button"
        data-testid="new-session"
        className={cn(
          navItemClass(),
          'h-(--new-session-height) w-full bg-(--field-bg) px-2.5'
        )}
        onClick={() => {
          onNew?.()
          navigate('/chat')
        }}
      >
        <span aria-hidden="true" className="size-(--icon-size-md) shrink-0 [&>svg]:size-full">
          <SquarePen />
        </span>
        <span className="min-w-0 flex-1 truncate text-left">新建会话</span>
        <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
          <Kbd>{commandKeyLabel()}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
    </div>
  )
}
